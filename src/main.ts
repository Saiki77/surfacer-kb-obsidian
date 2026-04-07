import { Plugin, Notice, addIcon, TFile, TFolder, normalizePath } from "obsidian";
import { KBSyncSettingTab, DEFAULT_SETTINGS, type KBSyncSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/sync-engine";
import { SyncStatusBar } from "./ui/sync-status-bar";
import { KBSyncSidebarView, VIEW_TYPE_KB_SYNC, type ActivityEntry } from "./ui/sidebar-view";
import { CollabManager } from "./collab/collab-manager";
import { remoteCursorExtension } from "./collab/cursor-decorations";
import * as templateStore from "./templates/template-store";
import * as readStore from "./reads/read-store";
import * as mentionStore from "./mentions/mention-store";
import * as reviewStore from "./reviews/review-store";
import * as permissionStore from "./permissions/permission-store";
import * as commentStore from "./comments/comment-store";
import { commentDecorationExtension } from "./comments/comment-decorations";
import { highlightDecorationExtension } from "./highlights/highlight-decorations";
import { computeChangedRanges, type ChangeRange } from "./highlights/diff-computer";
import * as historyManager from "./collab/history-manager";
import * as notificationManager from "./notifications/notification-manager";

const SYNC_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>`;

interface PluginData {
  settings: KBSyncSettings;
  manifest: any;
  queue: any;
  activityLog?: ActivityEntry[];
}

export default class KBSyncPlugin extends Plugin {
  settings: KBSyncSettings = DEFAULT_SETTINGS;
  private syncEngine!: SyncEngine;
  private statusBar!: SyncStatusBar;
  private sidebarView: KBSyncSidebarView | null = null;
  collabManager!: CollabManager;
  private activeComments: commentStore.CommentThread[] = [];
  private changeHighlightRanges: ChangeRange[] = [];
  highlightEnabled = false;
  private fileSnapshot: Map<string, string> = new Map();
  fileNotifications: notificationManager.FileChangeNotification[] = [];
  private pullIntervalId: number | null = null;
  private pushIntervalId: number | null = null;
  private presenceIntervalId: number | null = null;
  private chatIntervalId: number | null = null;
  private collabPresenceIntervalId: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();

    addIcon("kb-sync", SYNC_ICON);

    // Load persisted sync data
    const allData = (await this.loadData()) as PluginData | null;

    // Status bar
    this.statusBar = new SyncStatusBar(this);

    // Sync engine with activity tracking
    this.syncEngine = new SyncEngine(
      this.app,
      this.settings,
      allData,
      allData,
      (status: SyncStatus, conflicts: number) => {
        this.statusBar.update(
          status,
          conflicts,
          this.syncEngine.queueLength
        );
        // Refresh sidebar after sync completes + detect file changes
        if (status === "idle" && this.sidebarView) {
          this.sidebarView.refreshRemoteFiles();
          this.sidebarView.refreshPresence();
          this.sidebarView.refreshHandoffs();
          // File change notifications
          this.detectFileChanges();
        }
      },
      // Activity callback
      (entry: ActivityEntry) => {
        if (this.sidebarView) {
          this.sidebarView.addActivity(entry);
          this.persistSyncData();
        }
      }
    );

    // Collaboration manager
    this.collabManager = new CollabManager(this.app, this.settings);
    this.syncEngine.setCollabChecker((path) =>
      this.collabManager.isInCollabMode(path)
    );

    // Global CM6 extensions for collaboration (registered ONCE, never duplicated)
    this.registerEditorExtension([
      remoteCursorExtension(() => this.collabManager.getAllRemoteCursors()),
      this.collabManager.getLocalChangeExtension(),
      commentDecorationExtension(
        () => this.activeComments,
        (threadId) => this.openCommentThread(threadId)
      ),
      highlightDecorationExtension(() =>
        this.highlightEnabled ? this.changeHighlightRanges : []
      ),
    ]);

    // Scan editors on tab switch + record read receipts
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.collabManager.scanAndBindEditors();
        // Record read receipt for the active file
        this.recordReadForActiveFile();
      })
    );

    // Register sidebar view
    this.registerView(VIEW_TYPE_KB_SYNC, (leaf) => {
      this.sidebarView = new KBSyncSidebarView(leaf, this);
      // Load persisted activity log
      if (allData?.activityLog) {
        this.sidebarView.loadActivityLog(allData.activityLog);
      }
      return this.sidebarView;
    });

    // Settings tab
    this.addSettingTab(new KBSyncSettingTab(this.app, this));

    // Ribbon icon for force sync (only when collab is NOT active)
    if (!this.settings.collaborationEnabled || !this.settings.wsUrl) {
      this.addRibbonIcon("kb-sync", "Force KB Sync", async () => {
        await this.syncEngine.forceSync();
        await this.persistSyncData();
      });
    }

    // Commands
    this.addCommand({
      id: "force-sync",
      name: "Force sync now",
      callback: async () => {
        await this.syncEngine.forceSync();
        await this.persistSyncData();
      },
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Open Knowledge Base sidebar",
      callback: () => this.activateSidebar(),
    });

    this.addCommand({
      id: "save-as-template",
      name: "Save current file as template",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file || !(file instanceof TFile)) {
          new Notice("No active file to save as template.");
          return;
        }
        const content = await this.app.vault.read(file);
        const name = file.basename;
        await templateStore.saveTemplate(
          this.settings,
          name,
          content,
          "",
          this.settings.userName
        );
        new Notice(`Saved "${name}" as a template.`);
      },
    });

    this.addCommand({
      id: "toggle-lock",
      name: "Toggle document lock (view-only / editable)",
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        const syncFolder = normalizePath(this.settings.syncFolderPath);
        if (!file || !file.path.startsWith(syncFolder + "/")) {
          new Notice("Open a knowledge base file first.");
          return;
        }
        const docPath = file.path.slice(syncFolder.length + 1);
        const existing = await permissionStore.loadPermission(this.settings, docPath);
        if (existing && existing.mode === "view-only") {
          await permissionStore.removePermission(this.settings, docPath);
          new Notice(`Unlocked: ${file.basename}`);
        } else {
          await permissionStore.setPermission(
            this.settings, docPath, this.settings.userName,
            "view-only", this.settings.userName
          );
          new Notice(`Locked: ${file.basename} (view-only for others)`);
        }
      },
    });

    this.addCommand({
      id: "add-comment",
      name: "Add comment on selection",
      editorCallback: async (editor) => {
        const sel = editor.getSelection();
        if (!sel) { new Notice("Select text first."); return; }
        const file = this.app.workspace.getActiveFile();
        const syncFolder = normalizePath(this.settings.syncFolderPath);
        if (!file || !file.path.startsWith(syncFolder + "/")) return;
        const docPath = file.path.slice(syncFolder.length + 1);
        const from = editor.posToOffset(editor.getCursor("from"));
        const to = editor.posToOffset(editor.getCursor("to"));
        const text = prompt("Comment:");
        if (!text) return;
        const thread: commentStore.CommentThread = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          docPath, anchorStart: from, anchorEnd: to, anchorText: sel,
          status: "open", createdAt: new Date().toISOString(),
          createdBy: this.settings.userName,
          replies: [{ id: "1", user: this.settings.userName, text, timestamp: new Date().toISOString() }],
        };
        await commentStore.saveComment(this.settings, thread);
        await this.refreshCommentsForActiveFile();
        new Notice("Comment added.");
      },
    });

    this.addCommand({
      id: "toggle-highlights",
      name: "Toggle recent change highlights",
      callback: async () => {
        this.highlightEnabled = !this.highlightEnabled;
        if (this.highlightEnabled) {
          await this.refreshHighlightsForActiveFile();
          new Notice("Recent changes highlighted.");
        } else {
          this.changeHighlightRanges = [];
          new Notice("Highlights off.");
        }
      },
    });

    // Editor context menu: Add Comment
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu, editor) => {
        const sel = editor.getSelection();
        if (sel) {
          menu.addItem((item) => {
            item.setTitle("Add Comment").setIcon("message-square").onClick(async () => {
              const file = this.app.workspace.getActiveFile();
              const syncFolder = normalizePath(this.settings.syncFolderPath);
              if (!file || !file.path.startsWith(syncFolder + "/")) return;
              const docPath = file.path.slice(syncFolder.length + 1);
              const from = editor.posToOffset(editor.getCursor("from"));
              const to = editor.posToOffset(editor.getCursor("to"));
              const text = prompt("Comment:");
              if (!text) return;
              const thread: commentStore.CommentThread = {
                id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
                docPath, anchorStart: from, anchorEnd: to, anchorText: sel,
                status: "open", createdAt: new Date().toISOString(),
                createdBy: this.settings.userName,
                replies: [{ id: "1", user: this.settings.userName, text, timestamp: new Date().toISOString() }],
              };
              await commentStore.saveComment(this.settings, thread);
              await this.refreshCommentsForActiveFile();
              new Notice("Comment added.");
            });
          });
        }
      })
    );

    // Refresh comments when switching files
    this.registerEvent(
      this.app.workspace.on("file-open", () => {
        this.refreshCommentsForActiveFile();
      })
    );

    // Listen for folder renames and deletes within the sync folder
    this.registerEvent(
      this.app.vault.on("rename", async (file, oldPath) => {
        if (!(file instanceof TFolder)) return;
        const syncFolder = normalizePath(this.settings.syncFolderPath);
        if (
          !file.path.startsWith(syncFolder + "/") &&
          !oldPath.startsWith(syncFolder + "/")
        )
          return;

        const oldRel = oldPath.slice(syncFolder.length + 1);
        const newRel = file.path.slice(syncFolder.length + 1);
        await this.syncEngine.handleFolderRename(oldRel, newRel);
        await this.persistSyncData();
        if (this.sidebarView) this.sidebarView.refreshRemoteFiles();
      })
    );

    this.registerEvent(
      this.app.vault.on("delete", async (file) => {
        if (!(file instanceof TFolder)) return;
        const syncFolder = normalizePath(this.settings.syncFolderPath);
        if (!file.path.startsWith(syncFolder + "/")) return;

        const rel = file.path.slice(syncFolder.length + 1);
        await this.syncEngine.handleFolderDelete(rel);
        await this.persistSyncData();
        if (this.sidebarView) this.sidebarView.refreshRemoteFiles();
      })
    );

    // Start sync intervals (includes presence heartbeat)
    this.startIntervals();

    // Initial pull + open sidebar after vault loads
    this.app.workspace.onLayoutReady(() => {
      this.activateSidebar();
      setTimeout(async () => {
        await this.syncEngine.pull();
        await this.persistSyncData();
        // Initial presence update + team/handoff data load
        if (this.sidebarView) {
          this.sidebarView.updatePresence();
          this.sidebarView.refreshPresence();
          this.sidebarView.refreshHandoffs();
          this.sidebarView.refreshChat();
        }
        // Start collaboration WebSocket if enabled
        this.collabManager.connect();
      }, 3000);
    });
  }

  async forceSync(): Promise<void> {
    await this.syncEngine.forceSync();
    await this.persistSyncData();
    if (this.sidebarView) {
      this.sidebarView.refreshRemoteFiles();
      this.sidebarView.refreshPresence();
      this.sidebarView.refreshHandoffs();
      this.sidebarView.refreshChat();
    }
  }

  async onunload(): Promise<void> {
    this.clearIntervals();
    await this.collabManager.destroy();
    await this.persistSyncData();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_KB_SYNC);
  }

  private async activateSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_KB_SYNC);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: VIEW_TYPE_KB_SYNC, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private startIntervals(): void {
    this.clearIntervals();

    if (!this.settings.syncEnabled) return;

    const collabActive = this.settings.collaborationEnabled && this.settings.wsUrl;

    // When collab is active: pull less frequently (just for new file discovery),
    // skip push entirely (edits go via WebSocket)
    const pullMs = collabActive
      ? 10 * 60 * 1000  // 10 min when collab active
      : this.settings.pullIntervalMinutes * 60 * 1000;

    this.pullIntervalId = window.setInterval(async () => {
      await this.syncEngine.pull();
      await this.persistSyncData();
    }, pullMs);
    this.registerInterval(this.pullIntervalId);

    if (!collabActive) {
      const pushMs = this.settings.pushIntervalMinutes * 60 * 1000;
      this.pushIntervalId = window.setInterval(async () => {
        await this.syncEngine.push();
        await this.persistSyncData();
      }, pushMs);
      this.registerInterval(this.pushIntervalId);
    }

    // Presence heartbeat
    if (this.settings.userName) {
      const presenceMs = this.settings.presenceHeartbeatMinutes * 60 * 1000;
      this.presenceIntervalId = window.setInterval(() => {
        if (this.sidebarView) {
          this.sidebarView.updatePresence();
          this.sidebarView.refreshPresence();
        }
      }, presenceMs);
      this.registerInterval(this.presenceIntervalId);

      // Chat refresh + mention scan (every 30 seconds)
      this.chatIntervalId = window.setInterval(() => {
        if (this.sidebarView) {
          this.sidebarView.refreshChat();
        }
        this.scanMentionsForActiveFile();
      }, 30 * 1000);
      this.registerInterval(this.chatIntervalId);
    }

    // Collab UI refresh (every 2s — updates collab bar + status bar online count)
    if (this.settings.collaborationEnabled && this.settings.wsUrl) {
      this.collabPresenceIntervalId = window.setInterval(() => {
        if (this.sidebarView) {
          this.sidebarView.refreshCollabState();
        }
        // Update status bar with online count or disconnected warning
        const connected = this.collabManager?.isConnected ?? false;
        if (!connected) {
          this.statusBar.update("idle", 0, 0, undefined, true);
        } else {
          const activeFile = this.app.workspace.getActiveFile();
          const syncFolder = this.settings.syncFolderPath;
          if (activeFile?.path?.startsWith(syncFolder + "/")) {
            const docPath = activeFile.path.slice(syncFolder.length + 1);
            const remoteUsers = this.collabManager?.getActiveCollaborators?.(docPath) ?? [];
            this.statusBar.update("idle", 0, 0, 1 + remoteUsers.length);
          } else {
            this.statusBar.update("idle", 0, 0, 1);
          }
        }
      }, 2000);
      this.registerInterval(this.collabPresenceIntervalId);
    }
  }

  private clearIntervals(): void {
    if (this.pullIntervalId !== null) {
      window.clearInterval(this.pullIntervalId);
      this.pullIntervalId = null;
    }
    if (this.pushIntervalId !== null) {
      window.clearInterval(this.pushIntervalId);
      this.pushIntervalId = null;
    }
    if (this.presenceIntervalId !== null) {
      window.clearInterval(this.presenceIntervalId);
      this.presenceIntervalId = null;
    }
    if (this.chatIntervalId !== null) {
      window.clearInterval(this.chatIntervalId);
      this.chatIntervalId = null;
    }
    if (this.collabPresenceIntervalId !== null) {
      window.clearInterval(this.collabPresenceIntervalId);
      this.collabPresenceIntervalId = null;
    }
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  async saveSettings(): Promise<void> {
    await this.persistSyncData();
    this.syncEngine?.updateSettings(this.settings);
    this.collabManager?.updateSettings(this.settings);
    this.startIntervals();
  }

  private async persistSyncData(): Promise<void> {
    const syncData = this.syncEngine?.getManifestData() || {};
    await this.saveData({
      settings: this.settings,
      ...syncData,
      activityLog: this.sidebarView?.getActivityLog() || [],
    });
  }

  async refreshCommentsForActiveFile(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    const syncFolder = normalizePath(this.settings.syncFolderPath);
    if (!file || !file.path.startsWith(syncFolder + "/")) {
      this.activeComments = [];
      return;
    }
    const docPath = file.path.slice(syncFolder.length + 1);
    try {
      const content = await this.app.vault.read(file);
      let threads = await commentStore.loadComments(this.settings, docPath);
      // Reanchor comments based on current content
      threads = threads.map((t) => commentStore.reanchorComment(t, content));
      this.activeComments = threads;
    } catch {
      this.activeComments = [];
    }
  }

  openCommentThread(threadId: string): void {
    if (this.sidebarView) {
      (this.sidebarView as any).showCommentThread?.(threadId, this.activeComments);
    }
  }

  async refreshHighlightsForActiveFile(): Promise<void> {
    if (!this.highlightEnabled) return;
    const file = this.app.workspace.getActiveFile();
    const syncFolder = normalizePath(this.settings.syncFolderPath);
    if (!file || !file.path.startsWith(syncFolder + "/")) {
      this.changeHighlightRanges = [];
      return;
    }
    const docPath = file.path.slice(syncFolder.length + 1);
    try {
      const currentContent = await this.app.vault.read(file);
      const snapshots = await historyManager.listSnapshots(this.settings, docPath);
      // Find the most recent snapshot older than 1 hour
      const cutoff = Date.now() - 60 * 60 * 1000;
      const older = snapshots.find((s) => new Date(s.timestamp).getTime() < cutoff);
      if (!older) { this.changeHighlightRanges = []; return; }
      const snapshot = await historyManager.loadSnapshot(this.settings, docPath, older.id);
      if (!snapshot) { this.changeHighlightRanges = []; return; }
      this.changeHighlightRanges = computeChangedRanges(snapshot.content, currentContent);
    } catch {
      this.changeHighlightRanges = [];
    }
  }

  private detectFileChanges(): void {
    try {
      const currentFiles = this.sidebarView?.getRemoteFiles() ?? [];
      const starredPaths = new Set(
        (this.sidebarView as any)?.userStars?.map((s: any) => s.docPath) ?? []
      );
      if (this.fileSnapshot.size > 0) {
        this.fileNotifications = notificationManager.detectChanges(
          currentFiles, this.fileSnapshot, starredPaths, this.settings.userName
        );
      }
      this.fileSnapshot = notificationManager.buildFileSnapshot(currentFiles);
    } catch { /* best effort */ }
  }

  private lastReadDocPath = "";
  private recordReadForActiveFile(): void {
    const user = this.settings.userName;
    if (!user) return;
    const file = this.app.workspace.getActiveFile();
    const syncFolder = normalizePath(this.settings.syncFolderPath);
    if (!file || !file.path.startsWith(syncFolder + "/")) return;
    const docPath = file.path.slice(syncFolder.length + 1);
    // Debounce: don't re-record the same file
    if (docPath === this.lastReadDocPath) return;
    this.lastReadDocPath = docPath;
    readStore.recordRead(this.settings, docPath, user).catch(() => {});
  }

  /**
   * Scan the active file for @mentions and notify mentioned users.
   */
  async scanMentionsForActiveFile(): Promise<void> {
    const user = this.settings.userName;
    if (!user) return;
    const file = this.app.workspace.getActiveFile();
    const syncFolder = normalizePath(this.settings.syncFolderPath);
    if (!file || !(file instanceof TFile) || !file.path.startsWith(syncFolder + "/")) return;
    const docPath = file.path.slice(syncFolder.length + 1);

    try {
      const content = await this.app.vault.read(file);
      const teamUsers = this.sidebarView?.getPresenceData()?.map((p) => p.user) ?? [];
      const mentioned = mentionStore.extractMentions(content, teamUsers);
      // Get a context snippet (first 80 chars around the mention)
      for (const mentionedUser of mentioned) {
        if (mentionedUser === user) continue; // Don't notify yourself
        const idx = content.toLowerCase().indexOf(`@${mentionedUser.toLowerCase()}`);
        const start = Math.max(0, idx - 20);
        const end = Math.min(content.length, idx + mentionedUser.length + 60);
        const context = content.slice(start, end).replace(/\n/g, " ");
        await mentionStore.addMention(this.settings, mentionedUser, user, docPath, context);
      }
    } catch { /* best effort */ }
  }
}
