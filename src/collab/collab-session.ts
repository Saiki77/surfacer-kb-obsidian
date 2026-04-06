/**
 * CollabSession: manages a single Yjs document for one collaboratively-edited file.
 * Directly binds to CM6 EditorView via StateEffect.appendConfig for two-way sync.
 */

import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
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
  private historySessionTimer: number | null = null;
  private currentHistoryId: string | null = null;
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
   * Initialize the Yjs document. CRITICAL: all peers must share the same
   * Y.Doc origin, otherwise Yjs merges cause content duplication.
   *
   * Flow:
   * 1. Try loading shared snapshot from S3 (created by the first peer)
   * 2. If found → use it as shared origin
   * 3. If NOT found → I'm the first peer; init from content and save immediately
   */
  async initialize(currentContent: string): Promise<void> {
    // Step 1: Try to load existing shared Y.Doc state from S3
    let snapshot: Uint8Array | null = null;
    try {
      snapshot = await collabStorage.readSnapshot(this.settings, this.docPath);
    } catch {
      // S3 unavailable — fall through to local init
    }

    if (snapshot) {
      // Shared state exists — load it (shared origin with other peers)
      Y.applyUpdate(this.ydoc, snapshot);
      console.log(`KB Collab: Loaded shared snapshot for ${this.docPath}`);
      return;
    }

    // Step 2: No shared state — I'm the first peer
    console.log(`KB Collab: First peer for ${this.docPath}, creating shared state`);
    this.ydoc.transact(() => {
      this.ytext.insert(0, currentContent);
    });

    // Save immediately so the next peer loads our state (shared origin)
    await this.saveSnapshot();
  }

  /**
   * Start the session: subscribe to WebSocket, broadcast full state for sync,
   * listen for ongoing updates.
   */
  start(): void {
    this.transport.subscribe(this.docPath);

    // Broadcast full state to any existing peers so they sync with us.
    // This is safe because all peers share the same Y.Doc origin (from S3 snapshot).
    // Yjs handles duplicate/redundant state gracefully.
    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    this.transport.sendUpdate(this.docPath, fullState);
    console.log(`KB Collab: Broadcast full state for ${this.docPath} (${fullState.length} bytes)`);

    // Broadcast incremental Yjs updates to peers via WebSocket
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
   * Sets up: initial content sync + Y.Text observer (remote → CM6).
   * Local changes (CM6 → Y.Text) are handled by the global ViewPlugin
   * in CollabManager, NOT injected per-editor.
   */
  bindEditor(view: EditorView): void {
    if (this.view === view) return;
    this.unbindEditor();
    this.view = view;

    // Sync initial content (Yjs → Editor if different)
    this.forceResyncEditor();

    // Observe Y.Text changes (from remote updates) → push to CM6 editor
    this.ytextObserver = () => {
      // Instead of converting deltas (which can drift), always verify
      // the CM6 content matches Yjs and force-resync if needed.
      if (this.isSyncing || !this.view) return;
      this.forceResyncEditor();
    };
    this.ytext.observe(this.ytextObserver);

    console.log(`KB Collab: Bound editor for ${this.docPath}`);
  }

  /**
   * Called by the global ViewPlugin when this editor has local changes.
   * Applies CM6 ChangeSet to Y.Text.
   */
  handleLocalChanges(changes: ChangeSet): void {
    if (this.isSyncing || this.destroyed) return;
    this.isSyncing = true;
    try {
      this.ydoc.transact(() => {
        applyChangeSetToYText(this.ytext, changes);
      });
    } catch (err) {
      console.error("KB Collab: Error applying local changes to Yjs:", err);
      // Conversion failed — force resync to recover
      this.forceResyncEditor();
    } finally {
      this.isSyncing = false;
    }
    // Verify CM6 and Yjs are still in sync after local change
    this.verifySync();
  }

  /**
   * Force the CM6 editor to match the Yjs document content.
   * Preserves cursor position as much as possible.
   */
  private forceResyncEditor(): void {
    if (!this.view) return;
    const yjsContent = this.ytext.toString();
    const editorContent = this.view.state.doc.toString();
    if (yjsContent === editorContent) return;

    this.isSyncing = true;
    try {
      // Save cursor position
      const cursorPos = Math.min(
        this.view.state.selection.main.head,
        yjsContent.length
      );

      this.view.dispatch({
        changes: { from: 0, to: editorContent.length, insert: yjsContent },
        selection: { anchor: cursorPos },
      });
    } catch (err) {
      console.error("KB Collab: Force resync failed:", err);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Verify CM6 and Yjs are in sync. If not, schedule a resync.
   */
  private verifySync(): void {
    if (!this.view || this.isSyncing) return;
    const yjsContent = this.ytext.toString();
    const editorContent = this.view.state.doc.toString();
    if (yjsContent !== editorContent) {
      // Drift detected — resync on next microtask to avoid re-entrancy
      queueMicrotask(() => this.forceResyncEditor());
    }
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
   * Includes a duplication guard for the rare race where two peers
   * initialize independently (before either's snapshot reaches S3).
   */
  applyRemoteUpdate(update: Uint8Array): void {
    if (this.destroyed) return;
    const lengthBefore = this.ytext.length;
    Y.applyUpdate(this.ydoc, update, "remote");
    const lengthAfter = this.ytext.length;

    // Duplication guard: if content more than doubled, two peers likely
    // initialized independently. Reset to the pre-update content.
    if (lengthBefore > 10 && lengthAfter > lengthBefore * 1.8) {
      console.warn(
        `KB Collab: Content duplication detected for ${this.docPath} ` +
        `(${lengthBefore} → ${lengthAfter}). Resetting.`
      );
      const originalContent = this.ytext.toString().slice(0, lengthBefore);
      this.ydoc.transact(() => {
        this.ytext.delete(0, this.ytext.length);
        this.ytext.insert(0, originalContent);
      });
    }
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

  getYDoc(): Y.Doc {
    return this.ydoc;
  }

  getBoundView(): EditorView | null {
    return this.view;
  }

  /**
   * Google Sheets-style history: saves once when editing starts, then
   * UPDATES the same entry within the session. A new session starts
   * after 2 minutes of inactivity.
   */
  private scheduleHistorySnapshot(): void {
    // Debounce: wait 3s after last keystroke before saving
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
    }
    this.historyTimer = window.setTimeout(async () => {
      this.historyTimer = null;
      if (this.destroyed) return;

      // Generate ID upfront if we don't have one (prevents race conditions
      // where two saves create separate entries)
      if (!this.currentHistoryId) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        this.currentHistoryId = `${ts}-${this.settings.userName}`;
      }

      try {
        await historyManager.saveSnapshot(
          this.settings,
          this.docPath,
          this.getContent(),
          this.settings.userName,
          this.sessionId,
          this.currentHistoryId
        );
      } catch (err) {
        console.error(`KB Collab: History snapshot failed for ${this.docPath}:`, err);
      }
    }, 3000);

    // Session timer: after 2 min of no edits, start a new history entry
    if (this.historySessionTimer !== null) {
      window.clearTimeout(this.historySessionTimer);
    }
    this.historySessionTimer = window.setTimeout(() => {
      this.currentHistoryId = null; // Next edit creates a new entry
    }, 2 * 60 * 1000);
  }

  async saveSnapshot(): Promise<void> {
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
    if (this.historySessionTimer !== null) {
      window.clearTimeout(this.historySessionTimer);
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
