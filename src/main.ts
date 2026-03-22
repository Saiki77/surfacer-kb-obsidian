import { Plugin, addIcon } from "obsidian";
import { KBSyncSettingTab, DEFAULT_SETTINGS, type KBSyncSettings } from "./settings";
import { SyncEngine, type SyncStatus } from "./sync/sync-engine";
import { SyncStatusBar } from "./ui/sync-status-bar";
import { KBSyncSidebarView, VIEW_TYPE_KB_SYNC, type ActivityEntry } from "./ui/sidebar-view";

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
  private pullIntervalId: number | null = null;
  private pushIntervalId: number | null = null;
  private presenceIntervalId: number | null = null;
  private chatIntervalId: number | null = null;

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
      id: "pull-now",
      name: "Pull from S3 now",
      callback: async () => {
        await this.syncEngine.pull();
        await this.persistSyncData();
      },
    });

    this.addCommand({
      id: "push-now",
      name: "Push to S3 now",
      callback: async () => {
        await this.syncEngine.push();
        await this.persistSyncData();
      },
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Open Knowledge Base sidebar",
      callback: () => this.activateSidebar(),
    });

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
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings);
  }

  async saveSettings(): Promise<void> {
    await this.persistSyncData();
    this.syncEngine?.updateSettings(this.settings);
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
