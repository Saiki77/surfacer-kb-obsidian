/**
 * CollabSession: manages a single Yjs document for one collaboratively-edited file.
 * Directly binds to CM6 EditorView via StateEffect.appendConfig for two-way sync.
 */

import * as Y from "yjs";
import { ViewPlugin, EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import { StateEffect } from "@codemirror/state";
import type { ChangeSet } from "@codemirror/state";
import type { CollabTransport } from "./collab-transport";
import type { KBSyncSettings } from "../settings";
import * as collabStorage from "./s3-collab-storage";
import * as historyManager from "./history-manager";

export interface CursorInfo {
  userId: string;
  anchor: number;
  head: number;
  updatedAt: number;
}

export class CollabSession {
  readonly docPath: string;
  private ydoc: Y.Doc;
  private ytext: Y.Text;
  private transport: CollabTransport;
  private settings: KBSyncSettings;
  private view: EditorView | null = null;
  private ytextObserver: ((event: Y.YTextEvent) => void) | null = null;
  private ydocUpdateHandler: ((update: Uint8Array, origin: any) => void) | null = null;
  isSyncing = false;
  private destroyed = false;
  private snapshotInterval: number | null = null;
  private historyTimer: number | null = null;
  private sessionId: string;
  private remoteCursors: Map<string, CursorInfo> = new Map();

  constructor(
    docPath: string,
    transport: CollabTransport,
    settings: KBSyncSettings
  ) {
    this.docPath = docPath;
    this.transport = transport;
    this.settings = settings;
    this.ydoc = new Y.Doc();
    this.ytext = this.ydoc.getText("content");
    this.sessionId = `${Date.now()}-${settings.userName}`;
  }

  /**
   * Initialize the Yjs document from current editor content.
   * If a snapshot exists in S3, load it; otherwise use the provided content.
   */
  async initialize(currentContent: string): Promise<void> {
    try {
      const snapshot = await collabStorage.readSnapshot(this.settings, this.docPath);
      if (snapshot) {
        Y.applyUpdate(this.ydoc, snapshot);
        // If snapshot diverged from local, use local as authoritative
        if (this.ytext.toString() !== currentContent) {
          this.ydoc.transact(() => {
            this.ytext.delete(0, this.ytext.length);
            this.ytext.insert(0, currentContent);
          });
        }
        return;
      }
    } catch {
      // No snapshot available
    }

    // Initialize from current content
    this.ydoc.transact(() => {
      this.ytext.insert(0, currentContent);
    });
  }

  /**
   * Start the session: subscribe to WebSocket, listen for Y.Doc updates to broadcast.
   */
  start(): void {
    this.transport.subscribe(this.docPath);

    // Broadcast local Yjs updates to peers via WebSocket
    this.ydocUpdateHandler = (update: Uint8Array, origin: any) => {
      if (origin === "remote") return;
      this.transport.sendUpdate(this.docPath, update);
      this.scheduleHistorySnapshot();
    };
    this.ydoc.on("update", this.ydocUpdateHandler);

    // Periodic S3 snapshot (every 5 minutes)
    this.snapshotInterval = window.setInterval(() => {
      this.saveSnapshot();
    }, 5 * 60 * 1000);
  }

  /**
   * Bind this session to a CM6 EditorView.
   * Sets up two-way sync: Y.Text ↔ CM6 document.
   */
  bindEditor(view: EditorView): void {
    if (this.view === view) return;
    this.unbindEditor();
    this.view = view;

    // Step 1: Sync initial content (Yjs → Editor if different)
    const yjsContent = this.ytext.toString();
    const editorContent = view.state.doc.toString();
    if (yjsContent !== editorContent) {
      this.isSyncing = true;
      view.dispatch({
        changes: { from: 0, to: editorContent.length, insert: yjsContent },
      });
      this.isSyncing = false;
    }

    // Step 2: Observe Y.Text changes (from remote) → push to CM6 editor
    this.ytextObserver = (event: Y.YTextEvent) => {
      if (this.isSyncing || !this.view) return;
      this.isSyncing = true;
      try {
        const changes = yTextEventToChangeSpec(event);
        if (changes.length > 0) {
          this.view.dispatch({ changes });
        }
      } catch (err) {
        console.error("KB Collab: Error applying remote changes to editor:", err);
      } finally {
        this.isSyncing = false;
      }
    };
    this.ytext.observe(this.ytextObserver);

    // Step 3: Inject a ViewPlugin into THIS editor that captures local edits → Y.Text
    const session = this;
    const localChangeTracker = ViewPlugin.fromClass(
      class {
        update(update: ViewUpdate) {
          if (!update.docChanged || session.isSyncing || session.destroyed) return;
          session.isSyncing = true;
          try {
            session.ydoc.transact(() => {
              applyChangeSetToYText(session.ytext, update.changes);
            });
          } catch (err) {
            console.error("KB Collab: Error applying local changes to Yjs:", err);
          } finally {
            session.isSyncing = false;
          }
        }
      }
    );

    view.dispatch({
      effects: StateEffect.appendConfig.of(localChangeTracker),
    });

    console.log(`KB Collab: Bound editor for ${this.docPath}`);
  }

  /**
   * Unbind from the current editor (e.g., when user navigates away).
   */
  unbindEditor(): void {
    if (this.ytextObserver) {
      this.ytext.unobserve(this.ytextObserver);
      this.ytextObserver = null;
    }
    // Note: The ViewPlugin injected via appendConfig can't be removed,
    // but it no-ops because the session reference is unchanged and
    // isSyncing/destroyed guards prevent stale writes.
    this.view = null;
  }

  /**
   * Apply a remote Yjs update received via WebSocket.
   */
  applyRemoteUpdate(update: Uint8Array): void {
    if (this.destroyed) return;
    Y.applyUpdate(this.ydoc, update, "remote");
  }

  setRemoteCursor(userId: string, anchor: number, head: number): void {
    this.remoteCursors.set(userId, {
      userId,
      anchor,
      head,
      updatedAt: Date.now(),
    });
  }

  getRemoteCursors(): CursorInfo[] {
    const now = Date.now();
    const active: CursorInfo[] = [];
    for (const [userId, cursor] of this.remoteCursors) {
      if (now - cursor.updatedAt < 10000) {
        active.push(cursor);
      } else {
        this.remoteCursors.delete(userId);
      }
    }
    return active;
  }

  getContent(): string {
    return this.ytext.toString();
  }

  getBoundView(): EditorView | null {
    return this.view;
  }

  private scheduleHistorySnapshot(): void {
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
    }
    this.historyTimer = window.setTimeout(async () => {
      this.historyTimer = null;
      if (this.destroyed) return;
      try {
        await historyManager.saveSnapshot(
          this.settings,
          this.docPath,
          this.getContent(),
          this.settings.userName,
          this.sessionId
        );
      } catch (err) {
        console.error(`KB Collab: History snapshot failed for ${this.docPath}:`, err);
      }
    }, 5000);
  }

  async saveSnapshot(): Promise<void> {
    if (this.destroyed) return;
    try {
      const state = Y.encodeStateAsUpdate(this.ydoc);
      await collabStorage.writeSnapshot(this.settings, this.docPath, state);
    } catch (err) {
      console.error(`KB Collab: S3 snapshot failed for ${this.docPath}:`, err);
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    if (this.snapshotInterval !== null) {
      window.clearInterval(this.snapshotInterval);
    }
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
    }

    this.unbindEditor();
    this.transport.unsubscribe(this.docPath);

    if (this.ydocUpdateHandler) {
      this.ydoc.off("update", this.ydocUpdateHandler);
    }

    await this.saveSnapshot();
    this.ydoc.destroy();
    this.remoteCursors.clear();
  }
}

// ── Helpers: Y.Text ↔ CM6 ChangeSet conversion ─────

/**
 * Convert Y.Text event deltas to CM6 ChangeSpec array.
 * Positions are in terms of the OLD document (before the event).
 */
function yTextEventToChangeSpec(event: Y.YTextEvent): any[] {
  const changes: any[] = [];
  let oldPos = 0;

  for (const delta of event.delta) {
    if (delta.retain != null) {
      oldPos += delta.retain;
    }
    if (delta.insert != null) {
      const text = typeof delta.insert === "string" ? delta.insert : "";
      if (text.length > 0) {
        changes.push({ from: oldPos, to: oldPos, insert: text });
        // Don't advance oldPos — insert doesn't consume old-doc chars
      }
    }
    if (delta.delete != null) {
      changes.push({ from: oldPos, to: oldPos + delta.delete });
      oldPos += delta.delete; // Delete consumes old-doc chars
    }
  }

  return changes;
}

/**
 * Convert a CM6 ChangeSet to Y.Text operations.
 * Applied inside a Y.Doc transaction.
 */
function applyChangeSetToYText(ytext: Y.Text, changes: ChangeSet): void {
  // adj tracks cumulative position shift from prior operations
  let adj = 0;

  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const from = fromA + adj;
    const deleteCount = toA - fromA;
    const insertText = inserted.sliceString(0);

    if (deleteCount > 0) {
      ytext.delete(from, deleteCount);
    }
    if (insertText.length > 0) {
      ytext.insert(from, insertText);
    }

    // Adjust: we removed deleteCount chars and added insertText.length chars
    adj += insertText.length - deleteCount;
  });
}
