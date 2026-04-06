/**
 * CollabSession: manages a single Yjs document for one collaboratively-edited file.
 * Handles Yjs ↔ CM6 binding, update broadcasting, and S3 snapshot persistence.
 */

import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import type { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
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
  private boundView: EditorView | null = null;
  private editorExtension: Extension | null = null;
  private updateHandler: ((update: Uint8Array, origin: any) => void) | null = null;
  private snapshotInterval: number | null = null;
  private remoteCursors: Map<string, CursorInfo> = new Map();
  private destroyed = false;
  private pendingUpdates: Uint8Array[] = [];
  private flushTimer: number | null = null;
  private historyTimer: number | null = null;
  private sessionId: string;

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
   * Initialize the Yjs document. Tries to load a snapshot from S3,
   * falls back to initializing from the current markdown content.
   */
  async initialize(currentContent: string): Promise<void> {
    // Try loading existing snapshot from S3
    try {
      const snapshot = await collabStorage.readSnapshot(this.settings, this.docPath);
      if (snapshot) {
        Y.applyUpdate(this.ydoc, snapshot);
        // If snapshot content differs significantly from current local content,
        // the CRDT will handle merging when updates flow
        return;
      }
    } catch {
      // Snapshot unavailable, initialize from content
    }

    // No snapshot — initialize from current markdown
    this.ydoc.transact(() => {
      this.ytext.insert(0, currentContent);
    });
  }

  /**
   * Bind this session to a CM6 EditorView. Returns the CM6 extension
   * to be applied to the editor. Only one editor can be bound at a time.
   */
  getEditorExtension(userId: string): Extension {
    if (!this.editorExtension) {
      this.editorExtension = yCollab(this.ytext, null, {
        undoManager: new Y.UndoManager(this.ytext),
      });
    }
    return this.editorExtension;
  }

  /**
   * Start the session: subscribe to WebSocket, listen for Yjs updates,
   * begin snapshot interval.
   */
  start(): void {
    // Subscribe to document channel via WebSocket
    this.transport.subscribe(this.docPath);

    // Listen for local Yjs updates and broadcast to peers
    this.updateHandler = (update: Uint8Array, origin: any) => {
      // Don't re-broadcast updates that came from remote
      if (origin === "remote") return;
      this.pendingUpdates.push(update);
      this.scheduleFlush();
      this.scheduleHistorySnapshot();
    };
    this.ydoc.on("update", this.updateHandler);

    // Start periodic snapshot to S3 (every 5 minutes)
    this.snapshotInterval = window.setInterval(() => {
      this.saveSnapshot();
    }, 5 * 60 * 1000);
  }

  /**
   * Apply a remote Yjs update received via WebSocket.
   */
  applyRemoteUpdate(update: Uint8Array): void {
    if (this.destroyed) return;
    Y.applyUpdate(this.ydoc, update, "remote");
  }

  /**
   * Update a remote cursor position.
   */
  setRemoteCursor(userId: string, anchor: number, head: number): void {
    this.remoteCursors.set(userId, {
      userId,
      anchor,
      head,
      updatedAt: Date.now(),
    });
  }

  /**
   * Get all active remote cursors (excluding stale ones > 10s old).
   */
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

  /**
   * Get the current document content as a string.
   */
  getContent(): string {
    return this.ytext.toString();
  }

  /**
   * Flush pending updates to WebSocket.
   */
  private scheduleFlush(): void {
    if (this.flushTimer !== null) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      this.flushUpdates();
    }, 50); // 50ms debounce for batching rapid keystrokes
  }

  private flushUpdates(): void {
    if (this.pendingUpdates.length === 0) return;

    // Merge all pending updates into one
    const merged = Y.mergeUpdates(this.pendingUpdates);
    this.pendingUpdates = [];
    this.transport.sendUpdate(this.docPath, merged);
  }

  /**
   * Schedule a history snapshot after 5 seconds of inactivity (debounced).
   */
  private scheduleHistorySnapshot(): void {
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
    }
    this.historyTimer = window.setTimeout(async () => {
      this.historyTimer = null;
      if (this.destroyed) return;
      try {
        const content = this.getContent();
        await historyManager.saveSnapshot(
          this.settings,
          this.docPath,
          content,
          this.settings.userName,
          this.sessionId
        );
      } catch (err) {
        console.error(`KB Collab: Failed to save history snapshot for ${this.docPath}:`, err);
      }
    }, 5000); // 5-second pause triggers history save
  }

  /**
   * Save a Yjs snapshot to S3 for persistence.
   */
  async saveSnapshot(): Promise<void> {
    if (this.destroyed) return;
    try {
      const state = Y.encodeStateAsUpdate(this.ydoc);
      await collabStorage.writeSnapshot(this.settings, this.docPath, state);
    } catch (err) {
      console.error(`KB Collab: Failed to save snapshot for ${this.docPath}:`, err);
    }
  }

  /**
   * Destroy the session, flushing pending state.
   */
  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;

    // Stop snapshot interval
    if (this.snapshotInterval !== null) {
      window.clearInterval(this.snapshotInterval);
      this.snapshotInterval = null;
    }

    // Clear flush timer
    if (this.flushTimer !== null) {
      window.clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    // Clear history timer
    if (this.historyTimer !== null) {
      window.clearTimeout(this.historyTimer);
      this.historyTimer = null;
    }

    // Flush any remaining updates
    this.flushUpdates();

    // Unsubscribe from WebSocket channel
    this.transport.unsubscribe(this.docPath);

    // Remove Yjs update listener
    if (this.updateHandler) {
      this.ydoc.off("update", this.updateHandler);
      this.updateHandler = null;
    }

    // Save final snapshot
    await this.saveSnapshot();

    // Clean up Yjs
    this.ydoc.destroy();
    this.remoteCursors.clear();
  }
}
