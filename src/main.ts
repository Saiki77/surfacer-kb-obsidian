import { Plugin, addIcon, TFolder, normalizePath } from "obsidian";
import { KBSyncSettingTab, DEFAULT_SETTINGS, type KBSyncSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/sync-engine";
import { SyncStatusBar } from "./ui/sync-status-bar";
import { KBSyncSidebarView, VIEW_TYPE_KB_SYNC, type ActivityEntry } from "./ui/sidebar-view";
import { CollabManager } from "./collab/collab-manager";
import { remoteCursorExtension } from "./collab/cursor-decorations";

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
        // Refresh sidebar after sync completes
        if (status === "idle" && this.sidebarView) {
          this.sidebarView.refreshRemoteFiles();
          this.sidebarView.refreshPresence();
          this.sidebarView.refreshHandoffs();
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

    // Global cursor decorations (reads from collabManager)
    this.registerEditorExtension(
      remoteCursorExtension(() => this.collabManager.getAllRemoteCursors())
    );

    // Scan editors on tab switch so collab sessions bind immediately
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.collabManager.scanAndBindEditors();
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

    // Ribbon icon for force sync
    this.addRibbonIcon("kb-sync", "Force KB Sync", async () => {
      await this.syncEngine.forceSync();
      await this.persistSyncData();
    });

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

    const pullMs = this.settings.pullIntervalMinutes * 60 * 1000;
    const pushMs = this.settings.pushIntervalMinutes * 60 * 1000;

    this.pullIntervalId = window.setInterval(async () => {
      await this.syncEngine.pull();
      await this.persistSyncData();
    }, pullMs);
    this.registerInterval(this.pullIntervalId);

    this.pushIntervalId = window.setInterval(async () => {
      await this.syncEngine.push();
      await this.persistSyncData();
    }, pushMs);
    this.registerInterval(this.pushIntervalId);

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

      // Chat refresh (every 30 seconds)
      this.chatIntervalId = window.setInterval(() => {
        if (this.sidebarView) {
          this.sidebarView.refreshChat();
        }
      }, 30 * 1000);
      this.registerInterval(this.chatIntervalId);
    }

    // Collab UI refresh (every 2s — updates collab bar avatars from cursor data)
    if (this.settings.collaborationEnabled && this.settings.wsUrl) {
      this.collabPresenceIntervalId = window.setInterval(() => {
        if (this.sidebarView) {
          this.sidebarView.refreshCollabState();
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
}
