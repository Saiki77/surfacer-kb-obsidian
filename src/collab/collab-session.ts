/**
 * CollabSession: manages a single Yjs document for one collaboratively-edited file.
 *
 * Performance optimizations:
 * 1. Delta-based sync (fast path) with full-replacement fallback (safety net)
 * 2. CM6 native ChangeSet for cursor mapping
 * 3. Debounced resync (50ms batching)
 * 4. Safety timer to auto-reset stuck isSyncing
 * 5. Smart snapshots (only when dirty)
 * 6. Focus-aware: queues changes for unfocused editors
 */

import * as Y from "yjs";
import type { EditorView } from "@codemirror/view";
import { ChangeSet } from "@codemirror/state";
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
  private resyncTimer: number | null = null;
  private syncSafetyTimer: number | null = null;
  private historyTimer: number | null = null;
  private historySessionTimer: number | null = null;
  private currentHistoryId: string | null = null;
  private sessionId: string;
  private remoteCursors: Map<string, CursorInfo> = new Map();
  private snapshotDirty = false;
  private pendingRemoteChanges = false;
  private _isActive = false;
  private pendingOutUpdates: Uint8Array[] = [];
  private outBatchTimer: number | null = null;

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

  get isActive(): boolean {
    return this._isActive;
  }

  async initialize(currentContent: string): Promise<void> {
    let snapshot: Uint8Array | null = null;
    try {
      snapshot = await collabStorage.readSnapshot(this.settings, this.docPath);
    } catch {}

    if (snapshot) {
      Y.applyUpdate(this.ydoc, snapshot);
      return;
    }

    this.ydoc.transact(() => {
      this.ytext.insert(0, currentContent);
    });
    await this.saveSnapshot();
  }

  start(): void {
    this.transport.subscribe(this.docPath);

    const fullState = Y.encodeStateAsUpdate(this.ydoc);
    this.transport.sendUpdate(this.docPath, fullState);

    this.ydocUpdateHandler = (update: Uint8Array, origin: any) => {
      if (origin === "remote") return;
      this.snapshotDirty = true;
      // Batch outgoing updates: accumulate for 100ms then merge via Y.mergeUpdates
      this.pendingOutUpdates.push(update);
      if (this.outBatchTimer === null) {
        this.outBatchTimer = window.setTimeout(() => {
          this.outBatchTimer = null;
          if (this.pendingOutUpdates.length === 0) return;
          const merged = this.pendingOutUpdates.length === 1
            ? this.pendingOutUpdates[0]
            : Y.mergeUpdates(this.pendingOutUpdates);
          this.pendingOutUpdates = [];
          this.transport.sendUpdate(this.docPath, merged);
        }, 100);
      }
      this.scheduleHistorySnapshot();
    };
    this.ydoc.on("update", this.ydocUpdateHandler);

    // Smart snapshots: only save when dirty, check every 5 min
    this.snapshotInterval = window.setInterval(() => {
      if (this.snapshotDirty) {
        this.snapshotDirty = false;
        this.saveSnapshot();
      }
    }, 5 * 60 * 1000);
  }

  bindEditor(view: EditorView): void {
    if (this.view === view) return;
    this.unbindEditor();
    this.view = view;

    this.forceResyncEditor();

    // Y.Text observer: use delta-based sync (fast) with fallback
    this.ytextObserver = (event: Y.YTextEvent) => {
      if (this.isSyncing || !this.view) return;

      // If editor is not focused, queue the change for later
      if (!this.view.hasFocus) {
        this.pendingRemoteChanges = true;
        return;
      }

      this.applyDeltaToEditor(event);
    };
    this.ytext.observe(this.ytextObserver);
  }

  /**
   * Called when the editor regains focus. Applies any queued changes.
   */
  onEditorFocus(): void {
    if (this.pendingRemoteChanges && this.view) {
      this.pendingRemoteChanges = false;
      this.forceResyncEditor();
    }
  }

  /**
   * Mark session as active (user started typing). Used for lazy activation.
   */
  activate(): void {
    this._isActive = true;
  }

  /**
   * Fast path: apply Y.Text deltas directly to CM6 editor.
   * Falls back to full resync if positions don't match.
   */
  private applyDeltaToEditor(event: Y.YTextEvent): void {
    if (!this.view) return;

    this.enterSync();
    try {
      const changes = yTextEventToChangeSpec(event);
      if (changes.length === 0) { this.exitSync(); return; }

      const editorLen = this.view.state.doc.length;

      // Validate all positions are within bounds
      let valid = true;
      for (const c of changes) {
        if (c.from < 0 || c.from > editorLen || (c.to != null && c.to > editorLen)) {
          valid = false;
          break;
        }
      }

      if (valid) {
        // Use CM6's native ChangeSet for proper cursor mapping
        const changeSet = ChangeSet.of(changes, editorLen);
        const oldCursor = this.view.state.selection.main.head;
        const newCursor = changeSet.mapPos(oldCursor, 1); // 1 = assoc right

        this.view.dispatch({
          changes: changeSet,
          selection: { anchor: newCursor },
        });
      } else {
        // Positions invalid — fall back to full resync
        this.exitSync();
        this.forceResyncEditor();
        return;
      }

      // Verify sync after delta apply
      const yjsContent = this.ytext.toString();
      const editorContent = this.view.state.doc.toString();
      if (yjsContent !== editorContent) {
        // Delta didn't produce correct result — schedule full resync
        this.exitSync();
        this.scheduleResync();
        return;
      }
    } catch {
      // Delta failed — fall back to full resync
      this.exitSync();
      this.scheduleResync();
      return;
    }
    this.exitSync();
  }

  handleLocalChanges(changes: ChangeSet): void {
    if (this.isSyncing || this.destroyed) return;
    this._isActive = true; // User is typing → activate
    this.enterSync();
    try {
      this.ydoc.transact(() => {
        applyChangeSetToYText(this.ytext, changes);
      });
    } catch (err) {
      console.error("KB Collab: Local→Yjs error:", err);
    } finally {
      this.exitSync();
    }
  }

  private scheduleResync(): void {
    if (this.resyncTimer !== null) return;
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      this.forceResyncEditor();
    }, 50);
  }

  /**
   * Full content resync (safety net). Computes minimal diff via
   * common prefix/suffix and uses CM6 ChangeSet.mapPos for cursor.
   */
  private forceResyncEditor(): void {
    if (!this.view || this.destroyed) return;

    let yjsContent: string;
    let editorContent: string;
    try {
      yjsContent = this.ytext.toString();
      editorContent = this.view.state.doc.toString();
    } catch {
      return;
    }

    if (yjsContent === editorContent) return;

    this.enterSync();
    try {
      // Find common prefix
      let prefixLen = 0;
      const minLen = Math.min(editorContent.length, yjsContent.length);
      while (prefixLen < minLen && editorContent[prefixLen] === yjsContent[prefixLen]) {
        prefixLen++;
      }

      // Find common suffix
      let suffixLen = 0;
      while (
        suffixLen < (minLen - prefixLen) &&
        editorContent[editorContent.length - 1 - suffixLen] === yjsContent[yjsContent.length - 1 - suffixLen]
      ) {
        suffixLen++;
      }

      const changeFrom = prefixLen;
      const changeTo = editorContent.length - suffixLen;
      const insertText = yjsContent.slice(prefixLen, yjsContent.length - suffixLen);

      // Use CM6 ChangeSet.mapPos for precise cursor mapping
      const changeSet = ChangeSet.of(
        [{ from: changeFrom, to: changeTo, insert: insertText }],
        editorContent.length
      );
      const oldCursor = this.view.state.selection.main.head;
      const newCursor = Math.max(0, Math.min(
        changeSet.mapPos(oldCursor, 1),
        yjsContent.length
      ));

      this.view.dispatch({
        changes: changeSet,
        selection: { anchor: newCursor },
      });
    } catch (err) {
      console.error("KB Collab: Resync error:", err);
    } finally {
      this.exitSync();
    }
  }

  private enterSync(): void {
    this.isSyncing = true;
    if (this.syncSafetyTimer !== null) window.clearTimeout(this.syncSafetyTimer);
    this.syncSafetyTimer = window.setTimeout(() => {
      if (this.isSyncing) {
        this.isSyncing = false;
      }
    }, 500);
  }

  private exitSync(): void {
    this.isSyncing = false;
    if (this.syncSafetyTimer !== null) {
      window.clearTimeout(this.syncSafetyTimer);
      this.syncSafetyTimer = null;
    }
  }

  unbindEditor(): void {
    if (this.resyncTimer !== null) {
      window.clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    if (this.syncSafetyTimer !== null) {
      window.clearTimeout(this.syncSafetyTimer);
      this.syncSafetyTimer = null;
    }
    this.isSyncing = false;
    this.pendingRemoteChanges = false;
    if (this.ytextObserver) {
      this.ytext.unobserve(this.ytextObserver);
      this.ytextObserver = null;
    }
    this.view = null;
  }

  applyRemoteUpdate(update: Uint8Array): void {
    if (this.destroyed) return;
    const lengthBefore = this.ytext.length;
    Y.applyUpdate(this.ydoc, update, "remote");
    const lengthAfter = this.ytext.length;

    if (lengthBefore > 10 && lengthAfter > lengthBefore * 1.8) {
      const originalContent = this.ytext.toString().slice(0, lengthBefore);
      this.ydoc.transact(() => {
        this.ytext.delete(0, this.ytext.length);
        this.ytext.insert(0, originalContent);
      });
    }
  }

  setRemoteCursor(userId: string, anchor: number, head: number): void {
    this.remoteCursors.set(userId, { userId, anchor, head, updatedAt: Date.now() });
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

  getContent(): string { return this.ytext.toString(); }
  getYDoc(): Y.Doc { return this.ydoc; }
  getBoundView(): EditorView | null { return this.view; }

  private scheduleHistorySnapshot(): void {
    if (this.historyTimer !== null) window.clearTimeout(this.historyTimer);
    this.historyTimer = window.setTimeout(async () => {
      this.historyTimer = null;
      if (this.destroyed) return;
      if (!this.currentHistoryId) {
        const ts = new Date().toISOString().replace(/[:.]/g, "-");
        this.currentHistoryId = `${ts}-${this.settings.userName}`;
      }
      try {
        await historyManager.saveSnapshot(
          this.settings, this.docPath, this.getContent(),
          this.settings.userName, this.sessionId, this.currentHistoryId
        );
      } catch {}
    }, 3000);

    if (this.historySessionTimer !== null) window.clearTimeout(this.historySessionTimer);
    this.historySessionTimer = window.setTimeout(() => {
      this.currentHistoryId = null;
    }, 2 * 60 * 1000);
  }

  async saveSnapshot(): Promise<void> {
    try {
      const state = Y.encodeStateAsUpdate(this.ydoc);
      await collabStorage.writeSnapshot(this.settings, this.docPath, state);
    } catch {}
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.snapshotInterval !== null) window.clearInterval(this.snapshotInterval);
    if (this.historyTimer !== null) window.clearTimeout(this.historyTimer);
    if (this.historySessionTimer !== null) window.clearTimeout(this.historySessionTimer);
    if (this.outBatchTimer !== null) {
      window.clearTimeout(this.outBatchTimer);
      // Flush remaining updates before destroy
      if (this.pendingOutUpdates.length > 0) {
        const merged = Y.mergeUpdates(this.pendingOutUpdates);
        this.transport.sendUpdate(this.docPath, merged);
        this.pendingOutUpdates = [];
      }
    }
    this.unbindEditor();
    this.transport.unsubscribe(this.docPath);
    if (this.ydocUpdateHandler) this.ydoc.off("update", this.ydocUpdateHandler);
    if (this.snapshotDirty) await this.saveSnapshot();
    this.ydoc.destroy();
    this.remoteCursors.clear();
  }
}

// ── Helpers ─────────────────────────────────────────

function yTextEventToChangeSpec(event: Y.YTextEvent): any[] {
  const changes: any[] = [];
  let oldPos = 0;
  for (const delta of event.delta) {
    if (delta.retain != null) oldPos += delta.retain;
    if (delta.insert != null) {
      const text = typeof delta.insert === "string" ? delta.insert : "";
      if (text.length > 0) changes.push({ from: oldPos, to: oldPos, insert: text });
    }
    if (delta.delete != null) {
      changes.push({ from: oldPos, to: oldPos + delta.delete });
      oldPos += delta.delete;
    }
  }
  return changes;
}

function applyChangeSetToYText(ytext: Y.Text, changes: ChangeSet): void {
  let adj = 0;
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const from = fromA + adj;
    const deleteCount = toA - fromA;
    const insertText = inserted.sliceString(0);
    if (deleteCount > 0) ytext.delete(from, deleteCount);
    if (insertText.length > 0) ytext.insert(from, insertText);
    adj += insertText.length - deleteCount;
  });
}
