/**
 * CollabManager: central orchestrator for live collaboration.
 * Manages WebSocket lifecycle, tracks active sessions per document,
 * provides a CM6 extension for editor integration.
 */

import { App, TFile, normalizePath } from "obsidian";
import { ViewPlugin, EditorView } from "@codemirror/view";
import type { Extension, EditorState } from "@codemirror/state";
import type { PluginValue } from "@codemirror/view";
import { CollabTransport } from "./collab-transport";
import { CollabSession, type CursorInfo } from "./collab-session";
import { remoteCursorExtension } from "./cursor-decorations";
import * as collabStorage from "./s3-collab-storage";
import type { KBSyncSettings } from "../settings";
import type { PresenceEntry } from "../ui/sidebar-view";

export class CollabManager {
  private app: App;
  private settings: KBSyncSettings;
  private transport: CollabTransport | null = null;
  private sessions: Map<string, CollabSession> = new Map();
  private reconnectTimer: number | null = null;
  private reconnectDelay = 1000;
  private maxReconnectDelay = 30000;
  private destroyed = false;
  private presenceData: PresenceEntry[] = [];
  private cursorPollInterval: number | null = null;

  // Track which views are open for which doc paths
  private activeViews: Map<EditorView, string> = new Map();

  constructor(app: App, settings: KBSyncSettings) {
    this.app = app;
    this.settings = settings;
  }

  updateSettings(settings: KBSyncSettings): void {
    this.settings = settings;
  }

  /**
   * Connect the WebSocket transport. Call after settings are loaded.
   */
  connect(): void {
    if (!this.settings.collaborationEnabled || !this.settings.wsUrl) return;
    if (this.transport?.connected) return;

    this.transport?.dispose();
    this.transport = new CollabTransport(
      this.settings.wsUrl,
      this.settings.userName
    );

    this.transport.onUpdate((docPath, data, userId) => {
      const session = this.sessions.get(docPath);
      if (session) {
        session.applyRemoteUpdate(data);
      }
    });

    this.transport.onCursor((docPath, userId, anchor, head) => {
      const session = this.sessions.get(docPath);
      if (session) {
        session.setRemoteCursor(userId, anchor, head);
      }
    });

    this.transport.onStatus((connected) => {
      if (connected) {
        this.reconnectDelay = 1000;
        // Re-subscribe all active sessions
        for (const [docPath] of this.sessions) {
          this.transport!.subscribe(docPath);
        }
      } else if (!this.destroyed) {
        this.scheduleReconnect();
      }
    });

    this.transport.connect();

    // Start cursor broadcast interval (send local cursor positions every 500ms)
    if (this.cursorPollInterval !== null) {
      window.clearInterval(this.cursorPollInterval);
    }
    this.cursorPollInterval = window.setInterval(() => {
      this.broadcastLocalCursors();
    }, 500);
  }

  /**
   * Check if a file is currently in collaborative editing mode.
   */
  isInCollabMode(relativePath: string): boolean {
    return this.sessions.has(relativePath);
  }

  /**
   * Update remote presence data. Called when presence is refreshed.
   * Triggers activation/deactivation of collab sessions based on
   * whether other users have the same documents open.
   */
  async updatePresence(presence: PresenceEntry[]): Promise<void> {
    this.presenceData = presence;
    if (!this.settings.collaborationEnabled || !this.settings.wsUrl) return;

    const myName = this.settings.userName;
    if (!myName) return;

    const myOpenDocs = this.getLocalOpenDocs();
    const remoteOpenDocs = new Set<string>();

    for (const entry of presence) {
      if (entry.user === myName) continue;
      // Consider users active in last 5 minutes
      const age = Date.now() - new Date(entry.heartbeat).getTime();
      if (age > 5 * 60 * 1000) continue;
      for (const doc of entry.openDocs) {
        remoteOpenDocs.add(doc);
      }
    }

    // Activate sessions for co-edited docs
    for (const docPath of myOpenDocs) {
      if (remoteOpenDocs.has(docPath) && !this.sessions.has(docPath)) {
        await this.activateSession(docPath);
      }
    }

    // Deactivate sessions for docs no longer co-edited
    for (const [docPath, session] of this.sessions) {
      if (!remoteOpenDocs.has(docPath) && !myOpenDocs.includes(docPath)) {
        await this.deactivateSession(docPath);
      }
    }
  }

  /**
   * Returns the CM6 extensions needed for live collaboration.
   * Should be registered once via plugin.registerEditorExtension().
   */
  getEditorExtensions(): Extension[] {
    const manager = this;

    // Extension that tracks editor lifecycle
    const editorTracker = ViewPlugin.fromClass(
      class implements PluginValue {
        private docPath: string | null = null;

        constructor(view: EditorView) {
          this.docPath = manager.resolveDocPath(view.state);
          if (this.docPath) {
            manager.activeViews.set(view, this.docPath);
            manager.onEditorOpened(this.docPath, view);
          }
        }

        update() {
          // Doc path doesn't change for an open editor
        }

        destroy() {
          if (this.docPath) {
            manager.activeViews.delete(
              [...manager.activeViews.entries()].find(
                ([, p]) => p === this.docPath
              )?.[0] as EditorView
            );
            manager.onEditorClosed(this.docPath);
          }
        }
      }
    );

    // Cursor decoration extension
    const cursorExt = remoteCursorExtension(() => {
      return manager.getAllRemoteCursors();
    });

    return [editorTracker, cursorExt];
  }

  /**
   * Get the Yjs CM6 extension for a specific document, if in collab mode.
   */
  getSessionExtension(docPath: string): Extension | null {
    const session = this.sessions.get(docPath);
    if (!session) return null;
    return session.getEditorExtension(this.settings.userName);
  }

  /**
   * Get all remote cursors across all active sessions.
   */
  getRemoteCursors(docPath: string): CursorInfo[] {
    const session = this.sessions.get(docPath);
    return session ? session.getRemoteCursors() : [];
  }

  /**
   * Get the current content of a collaboratively-edited document.
   */
  getCollabContent(docPath: string): string | null {
    const session = this.sessions.get(docPath);
    return session ? session.getContent() : null;
  }

  /**
   * Clean up everything.
   */
  async destroy(): Promise<void> {
    this.destroyed = true;

    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.cursorPollInterval !== null) {
      window.clearInterval(this.cursorPollInterval);
      this.cursorPollInterval = null;
    }

    // Destroy all sessions
    for (const [, session] of this.sessions) {
      await session.destroy();
    }
    this.sessions.clear();

    // Close WebSocket
    this.transport?.dispose();
    this.transport = null;

    this.activeViews.clear();
  }

  // ── Private methods ────────────────────────────────────

  private async activateSession(docPath: string): Promise<void> {
    if (this.sessions.has(docPath)) return;
    if (!this.transport?.connected) return;

    // Read current local content
    const fullPath = normalizePath(
      `${this.settings.syncFolderPath}/${docPath}`
    );
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (!(file instanceof TFile)) return;

    const content = await this.app.vault.read(file);

    const session = new CollabSession(docPath, this.transport, this.settings);
    await session.initialize(content);
    session.start();
    this.sessions.set(docPath, session);

    console.log(`KB Collab: Activated session for ${docPath}`);
  }

  private async deactivateSession(docPath: string): Promise<void> {
    const session = this.sessions.get(docPath);
    if (!session) return;

    // Write final content back to local file
    const content = session.getContent();
    const fullPath = normalizePath(
      `${this.settings.syncFolderPath}/${docPath}`
    );
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, content);
    }

    await session.destroy();
    this.sessions.delete(docPath);

    console.log(`KB Collab: Deactivated session for ${docPath}`);
  }

  private resolveDocPath(state: EditorState): string | null {
    // Get the file path from the editor state
    // Obsidian stores this in the state's facets
    const syncFolder = normalizePath(this.settings.syncFolderPath);

    // Try to find the file through workspace
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as any)?.file as TFile | undefined;
      if (file?.path?.startsWith(syncFolder + "/")) {
        // Check if this leaf's editor matches our state
        const editor = (leaf.view as any)?.editor;
        if (editor?.cm?.state === state) {
          return file.path.slice(syncFolder.length + 1);
        }
      }
    }
    return null;
  }

  private getLocalOpenDocs(): string[] {
    const syncFolder = normalizePath(this.settings.syncFolderPath);
    const docs: string[] = [];
    const seen = new Set<string>();

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as any)?.file as TFile | undefined;
      if (file?.path?.startsWith(syncFolder + "/")) {
        const rel = file.path.slice(syncFolder.length + 1);
        if (!seen.has(rel)) {
          seen.add(rel);
          docs.push(rel);
        }
      }
    }
    return docs;
  }

  private onEditorOpened(docPath: string, view: EditorView): void {
    // If we have an active collab session for this doc, the Yjs extension
    // is already registered globally. Nothing extra needed here.
  }

  private onEditorClosed(docPath: string): void {
    // Check if any other views still have this doc open
    const stillOpen = [...this.activeViews.values()].includes(docPath);
    if (!stillOpen) {
      // No more views — schedule deactivation with grace period
      window.setTimeout(async () => {
        const stillOpenLater = [...this.activeViews.values()].includes(docPath);
        if (!stillOpenLater && this.sessions.has(docPath)) {
          await this.deactivateSession(docPath);
        }
      }, 30000); // 30-second grace period
    }
  }

  private broadcastLocalCursors(): void {
    if (!this.transport?.connected) return;

    for (const [view, docPath] of this.activeViews) {
      if (!this.sessions.has(docPath)) continue;
      try {
        const sel = view.state.selection.main;
        this.transport.sendCursor(docPath, sel.anchor, sel.head);
      } catch {
        // View may be destroyed
      }
    }
  }

  private getAllRemoteCursors(): CursorInfo[] {
    const all: CursorInfo[] = [];
    for (const [, session] of this.sessions) {
      all.push(...session.getRemoteCursors());
    }
    return all;
  }

  private scheduleReconnect(): void {
    if (this.destroyed) return;
    if (this.reconnectTimer !== null) return;

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
