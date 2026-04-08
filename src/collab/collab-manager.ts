/**
 * CollabManager: always-on orchestrator for live collaboration.
 * When collaboration is enabled, every synced file gets a collab session
 * as soon as it's opened. No presence-gating — just like Google Docs.
 */

import * as Y from "yjs";
import { App, MarkdownView, TFile, normalizePath } from "obsidian";
import { ViewPlugin, EditorView } from "@codemirror/view";
import type { ViewUpdate, PluginValue } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { CollabTransport } from "./collab-transport";
import { CollabSession, type CursorInfo } from "./collab-session";
import type { KBSyncSettings } from "../settings";
import * as permissionStore from "../permissions/permission-store";

export class CollabManager {
  private app: App;
  private settings: KBSyncSettings;
  private transport: CollabTransport | null = null;
  private sessions: Map<string, CollabSession> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private destroyed = false;
  private cursorInterval: number | null = null;
  private scanInterval: number | null = null;
  private reconcileInterval: number | null = null;

  // Track which EditorViews are bound to which sessions
  private boundEditors: Map<string, EditorView> = new Map();
  // Permission cache (refreshed periodically)
  private permCache: Map<string, permissionStore.DocPermission> = new Map();

  constructor(app: App, settings: KBSyncSettings) {
    this.app = app;
    this.settings = settings;
  }

  get isEnabled(): boolean {
    return (
      this.settings.collaborationEnabled &&
      !!this.settings.wsUrl &&
      !!this.settings.userName
    );
  }

  get isConnected(): boolean {
    return this.transport?.connected ?? false;
  }

  updateSettings(settings: KBSyncSettings): void {
    this.settings = settings;
  }

  /**
   * Connect the WebSocket and start managing sessions.
   */
  connect(): void {
    if (!this.isEnabled || this.destroyed) return;
    if (this.transport?.connected) return;

    this.transport?.dispose();
    this.transport = new CollabTransport(
      this.settings.wsUrl,
      this.settings.userName
    );

    // Route incoming messages to the correct session
    this.transport.onUpdate((docPath, data, userId) => {
      this.sessions.get(docPath)?.applyRemoteUpdate(data);
    });

    this.transport.onCursor((docPath, userId, anchor, head) => {
      this.sessions.get(docPath)?.setRemoteCursor(userId, anchor, head);
    });

    // Yjs sync protocol: when a peer sends their state vector,
    // compute the diff they're missing and send it back
    this.transport.onSyncVector((docPath, remoteSV, userId) => {
      const session = this.sessions.get(docPath);
      if (!session) return;
      const diff = Y.encodeStateAsUpdate(session.getYDoc(), remoteSV);
      if (diff.length > 2) { // >2 bytes means there's actual data
        this.transport!.sendSyncDiff(docPath, diff);
      }
    });

    // When receiving a diff, apply it (fills in any missing updates)
    this.transport.onSyncDiff((docPath, diff, userId) => {
      this.sessions.get(docPath)?.applyRemoteUpdate(diff);
    });

    this.transport.onStatus((connected) => {
      if (connected) {
        console.log("KB Collab: WebSocket connected");
        this.reconnectDelay = 1000;
        // Re-subscribe all active sessions
        for (const [docPath] of this.sessions) {
          this.transport!.subscribe(docPath);
        }
        // Scan for open files to bind
        this.scanAndBindEditors();
      } else if (!this.destroyed) {
        console.log("KB Collab: WebSocket disconnected, scheduling reconnect");
        this.scheduleReconnect();
      }
    });

    this.transport.connect();

    // Periodically scan for editors and broadcast cursors
    this.startPolling();
  }

  /**
   * Check if a file is currently in collaborative editing mode.
   */
  isInCollabMode(relativePath: string): boolean {
    return this.sessions.has(relativePath);
  }

  /**
   * Scan open editors and create/bind sessions for any synced files.
   * Called on active-leaf-change and periodically.
   */
  async scanAndBindEditors(): Promise<void> {
    if (!this.isEnabled || !this.transport?.connected) return;

    const syncFolder = normalizePath(this.settings.syncFolderPath);
    const openDocPaths = new Set<string>();

    // Find all open markdown editors in the sync folder
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const mdView = leaf.view as MarkdownView;
      const file = mdView.file;
      if (!file || !file.path.startsWith(syncFolder + "/")) continue;

      const docPath = file.path.slice(syncFolder.length + 1);
      openDocPaths.add(docPath);

      // Get the CM6 EditorView
      const cm = (mdView.editor as any)?.cm as EditorView | undefined;
      if (!cm) continue;

      // Create session if needed
      if (!this.sessions.has(docPath)) {
        await this.activateSession(docPath, file);
      }

      // Bind editor if not already bound (or if the EditorView changed)
      const session = this.sessions.get(docPath)!;
      if (session.getBoundView() !== cm) {
        session.bindEditor(cm);
        this.boundEditors.set(docPath, cm);
      }
    }

    // Unbind sessions for files that are no longer open
    for (const [docPath, session] of this.sessions) {
      if (!openDocPaths.has(docPath)) {
        // Write final content back to the local file before destroying
        const content = session.getContent();
        const fullPath = normalizePath(`${syncFolder}/${docPath}`);
        const file = this.app.vault.getAbstractFileByPath(fullPath);
        if (file instanceof TFile) {
          // Only write back if content differs to avoid unnecessary vault events
          const currentContent = await this.app.vault.read(file);
          if (currentContent !== content) {
            await this.app.vault.modify(file, content);
          }
        }
        await session.destroy();
        this.sessions.delete(docPath);
        this.boundEditors.delete(docPath);
        console.log(`KB Collab: Deactivated session for ${docPath}`);
      }
    }
  }

  /**
   * Returns a global CM6 extension that routes local editor changes
   * to the correct CollabSession. Registered ONCE via registerEditorExtension.
   */
  getLocalChangeExtension(): Extension {
    const manager = this;
    return ViewPlugin.fromClass(
      class implements PluginValue {
        update(update: ViewUpdate) {
          if (!update.docChanged) return;
          // Find the session for this editor
          for (const [docPath, view] of manager.boundEditors) {
            if (view === update.view) {
              // Check permissions: block changes for view-only users
              const perm = manager.permCache.get(docPath);
              if (perm && !permissionStore.canEdit(perm, manager.settings.userName)) {
                return; // View-only: don't propagate changes
              }
              const session = manager.sessions.get(docPath);
              if (session) {
                session.handleLocalChanges(update.changes);
              }
              return;
            }
          }
        }
      }
    );
  }

  /**
   * Get all remote cursors for a specific document.
   */
  getRemoteCursors(docPath: string): CursorInfo[] {
    return this.sessions.get(docPath)?.getRemoteCursors() ?? [];
  }

  /**
   * Get all remote cursors across all sessions.
   */
  getAllRemoteCursors(): CursorInfo[] {
    const all: CursorInfo[] = [];
    for (const session of this.sessions.values()) {
      all.push(...session.getRemoteCursors());
    }
    return all;
  }

  /**
   * Get the collab content for a file (if in collab mode).
   */
  getCollabContent(docPath: string): string | null {
    return this.sessions.get(docPath)?.getContent() ?? null;
  }

  /**
   * Get userIds of active collaborators on a document (based on cursor data).
   * This is instant — doesn't depend on S3 presence polling.
   */
  getActiveCollaborators(docPath: string): string[] {
    const cursors = this.getRemoteCursors(docPath);
    return cursors.map((c) => c.userId);
  }

  /**
   * Get list of docPaths that currently have active collab sessions.
   */
  getActiveSessionPaths(): string[] {
    return [...this.sessions.keys()];
  }

  /**
   * Clean up everything. Writes all collab content back to local files
   * so no edits are lost when the app closes.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;
    this.stopPolling();

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    const syncFolder = normalizePath(this.settings.syncFolderPath);

    // Write each session's content back to the local vault file
    for (const [docPath, session] of this.sessions) {
      try {
        const content = session.getContent();
        const fullPath = normalizePath(`${syncFolder}/${docPath}`);
        const file = this.app.vault.getAbstractFileByPath(fullPath);
        if (file instanceof TFile) {
          const currentContent = await this.app.vault.read(file);
          if (currentContent !== content) {
            await this.app.vault.modify(file, content);
          }
        }
      } catch {
        // Best effort — app is closing
      }
      await session.destroy();
    }
    this.sessions.clear();
    this.boundEditors.clear();

    this.transport?.dispose();
    this.transport = null;
  }

  // ── Private ─────────────────────────────────────────

  private async activateSession(
    docPath: string,
    file: TFile
  ): Promise<void> {
    if (this.sessions.has(docPath) || !this.transport) return;

    const content = await this.app.vault.read(file);
    const session = new CollabSession(docPath, this.transport, this.settings);
    await session.initialize(content);
    session.start();
    this.sessions.set(docPath, session);
    console.log(`KB Collab: Activated session for ${docPath}`);
  }

  private startPolling(): void {
    this.stopPolling();

    // Broadcast local cursor positions every 200ms (responsive feel)
    this.cursorInterval = window.setInterval(() => {
      this.broadcastLocalCursors();
    }, 200);

    // Scan editors every 2 seconds to catch tab switches, new files, etc.
    this.scanInterval = window.setInterval(() => {
      this.scanAndBindEditors();
    }, 2000);

    // Reconciliation: exchange state vectors every 15 seconds
    // Safety net ensuring peers converge even if messages were lost
    this.reconcileInterval = window.setInterval(() => {
      this.reconcile();
    }, 15000);
  }

  private stopPolling(): void {
    if (this.cursorInterval !== null) {
      window.clearInterval(this.cursorInterval);
      this.cursorInterval = null;
    }
    if (this.scanInterval !== null) {
      window.clearInterval(this.scanInterval);
      this.scanInterval = null;
    }
    if (this.reconcileInterval !== null) {
      window.clearInterval(this.reconcileInterval);
      this.reconcileInterval = null;
    }
  }

  /**
   * Send our state vector for each active session so peers can send
   * back any updates we're missing. This is the Yjs sync protocol —
   * guarantees convergence even if individual WebSocket messages were lost.
   */
  private reconcile(): void {
    if (!this.transport?.connected) return;
    for (const [docPath, session] of this.sessions) {
      const sv = Y.encodeStateVector(session.getYDoc());
      this.transport.sendSyncVector(docPath, sv);
    }
    // Refresh permission cache
    permissionStore.loadAllPermissions(this.settings).then((map) => {
      this.permCache = map;
    }).catch(() => {});
  }

  private broadcastLocalCursors(): void {
    if (!this.transport?.connected) return;

    for (const [docPath, view] of this.boundEditors) {
      const session = this.sessions.get(docPath);
      if (!session) continue;
      try {
        // Notify session when editor regains focus (applies queued changes)
        if (view.hasFocus) {
          session.onEditorFocus();
        }
        const sel = view.state.selection.main;
        this.transport.sendCursor(docPath, sel.anchor, sel.head);
      } catch {
        // Editor may have been destroyed
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.reconnectTimer !== null) return;

    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.destroyed) {
        this.reconnectDelay = Math.min(
          this.reconnectDelay * 2,
          this.maxReconnectDelay
        );
        this.connect();
      }
    }, this.reconnectDelay);
  }
}
