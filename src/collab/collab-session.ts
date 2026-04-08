/**
 * CollabSession: manages a single Yjs document for one collaboratively-edited file.
 *
 * Sync architecture:
 * - Local edits: CM6 ViewPlugin → handleLocalChanges → Y.Text (origin="local")
 * - Remote edits: WebSocket → Y.applyUpdate (origin="remote") → Y.Text observer → CM6
 * - Echo prevention: Y.Doc update handler skips origin="remote" and origin="local"
 *   Y.Text observer skips when isSyncing=true (set during remote→CM6 dispatch)
 *   ViewPlugin skips when isSyncing=true (set during remote→CM6 dispatch)
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
  isSyncing = false; // True ONLY during remote→CM6 dispatch
  private destroyed = false;
  private snapshotInterval: number | null = null;
  private resyncTimer: number | null = null;
  private historyTimer: number | null = null;
  private historySessionTimer: number | null = null;
  private currentHistoryId: string | null = null;
  private sessionId: string;
  private remoteCursors: Map<string, CursorInfo> = new Map();
  private snapshotDirty = false;
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

  get isActive(): boolean { return this._isActive; }

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

    // Only broadcast updates that come from LOCAL edits (not remote, not syncing)
    this.ydocUpdateHandler = (update: Uint8Array, origin: any) => {
      if (origin === "remote" || origin === "local-to-yjs") return;
      this.snapshotDirty = true;
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

    // Y.Text observer: fires when Yjs content changes (from any source)
    // We only want to update CM6 for REMOTE changes
    this.ytextObserver = (event: Y.YTextEvent, txn: Y.Transaction) => {
      // Skip if this change came from local editing or from our own CM6→Yjs sync
      if (txn.origin === "local-to-yjs" || this.isSyncing || !this.view) return;
      this.scheduleResync();
    };
    this.ytext.observe(this.ytextObserver);
  }

  /**
   * Called by the global ViewPlugin when this editor has local changes.
   * Uses origin="local-to-yjs" so the Y.Doc update handler and Y.Text
   * observer both ignore it (preventing echo loops).
   */
  handleLocalChanges(changes: ChangeSet): void {
    if (this.isSyncing || this.destroyed) return;
    this._isActive = true;
    try {
      this.ydoc.transact(() => {
        applyChangeSetToYText(this.ytext, changes);
      }, "local-to-yjs"); // Origin tag prevents echo
    } catch (err) {
      console.error("KB Collab: Local→Yjs error:", err);
    }
  }

  activate(): void { this._isActive = true; }

  private scheduleResync(): void {
    if (this.resyncTimer !== null) return;
    this.resyncTimer = window.setTimeout(() => {
      this.resyncTimer = null;
      this.forceResyncEditor();
    }, 50);
  }

  /**
   * Sync CM6 editor to match Yjs content.
   * Sets isSyncing=true during dispatch so the ViewPlugin ignores
   * the resulting editor update (preventing echo).
   */
  private forceResyncEditor(): void {
    if (!this.view || this.destroyed) return;

    let yjsContent: string;
    let editorContent: string;
    try {
      yjsContent = this.ytext.toString();
      editorContent = this.view.state.doc.toString();
    } catch { return; }

    if (yjsContent === editorContent) return;

    this.isSyncing = true;
    try {
      let prefixLen = 0;
      const minLen = Math.min(editorContent.length, yjsContent.length);
      while (prefixLen < minLen && editorContent[prefixLen] === yjsContent[prefixLen]) {
        prefixLen++;
      }

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
      this.isSyncing = false;
    }
  }

  unbindEditor(): void {
    if (this.resyncTimer !== null) {
      window.clearTimeout(this.resyncTimer);
      this.resyncTimer = null;
    }
    this.isSyncing = false;
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
