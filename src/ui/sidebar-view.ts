import { ItemView, WorkspaceLeaf, Modal, setIcon } from "obsidian";
import type KBSyncPlugin from "../main";
import * as s3 from "../aws/s3-client";
import type { S3ListItem } from "../aws/s3-client";
import * as historyManager from "../collab/history-manager";
import type { HistoryEntry } from "../collab/history-manager";

export const VIEW_TYPE_KB_SYNC = "kb-sync-sidebar";

export interface ActivityEntry {
  timestamp: string;
  action: "pull" | "push" | "conflict" | "delete" | "error" | "offline" | "queue-drain" | "ai-process";
  path: string;
  detail?: string;
}

export interface PresenceEntry {
  user: string;
  heartbeat: string;
  workingOn: string;
  openDocs: string[];
  status: "active" | "idle";
  statusMessage?: string;
}

export interface ChatMessage {
  id: string;
  user: string;
  text: string;
  timestamp: string;
}

export interface Handoff {
  id: string;
  from: string;
  to: string;
  status: "open" | "claimed" | "completed";
  createdAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  completedAt: string | null;
  subject: string;
  context: string;
  decisions: string[];
  blockers: string[];
  nextSteps: string[];
  relatedDocs: string[];
  notes: string;
  completionNotes: string | null;
}

type TabName = "files" | "team" | "handoffs" | "chat" | "history";

export class KBSyncSidebarView extends ItemView {
  private plugin: KBSyncPlugin;
  private remoteFiles: S3ListItem[] = [];
  private activityLog: ActivityEntry[] = [];
  private teamPresence: PresenceEntry[] = [];
  private handoffs: Handoff[] = [];
  private chatMessages: ChatMessage[] = [];
  private activeTab: TabName = "files";
  private maxActivityEntries = 200;
  private maxChatMessages = 100;
  private chatInputValue = "";
  private chatInputCursor = 0;
  private historyEntries: Omit<HistoryEntry, "content">[] = [];
  private historyDocPath: string | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: KBSyncPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_KB_SYNC;
  }

  getDisplayText(): string {
    return "Knowledge Base";
  }

  getIcon(): string {
    return "kb-sync";
  }

  async onOpen(): Promise<void> {
    this.render();
    await this.refreshRemoteFiles();

    // Re-render team tab instantly when user switches active file
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        if (this.activeTab === "team") this.render();
      })
    );
  }

  async onClose(): Promise<void> {
    this.contentEl.empty();
  }

  addActivity(entry: ActivityEntry): void {
    this.activityLog.unshift(entry);
    if (this.activityLog.length > this.maxActivityEntries) {
      this.activityLog = this.activityLog.slice(0, this.maxActivityEntries);
    }
    if (this.activeTab === "activity") {
      this.render();
    }
  }

  loadActivityLog(log: ActivityEntry[]): void {
    this.activityLog = log || [];
  }

  getActivityLog(): ActivityEntry[] {
    return this.activityLog;
  }

  getPresenceData(): PresenceEntry[] {
    return this.teamPresence;
  }

  /**
   * Lightweight refresh: only update the collab bar element.
   * Does NOT call render() to avoid destroying the entire sidebar every 2s.
   * Uses vanilla DOM (not Obsidian's createDiv) since we're operating
   * outside the normal render cycle.
   */
  refreshCollabState(): void {
    try {
      // Remove existing bar
      const existing = this.contentEl.querySelector(".kb-sync-collab-bar");
      if (existing) existing.remove();

      if (!this.plugin.settings.collaborationEnabled) return;
      const activeFile = this.app.workspace.getActiveFile();
      const syncFolder = this.plugin.settings.syncFolderPath;
      if (!activeFile || !activeFile.path.startsWith(syncFolder + "/")) return;
      const docPath = activeFile.path.replace(syncFolder + "/", "");

      const isInCollab = this.plugin.collabManager?.isInCollabMode?.(docPath) ?? false;
      if (!isInCollab) return;

      const myName = this.plugin.settings.userName;
      const allUsers: string[] = myName ? [myName] : [];
      const cursorUsers: string[] = this.plugin.collabManager?.getActiveCollaborators?.(docPath) ?? [];
      for (const u of cursorUsers) {
        if (!allUsers.includes(u)) allUsers.push(u);
      }
      if (allUsers.length === 0) return;

      // Build bar with vanilla DOM
      const bar = document.createElement("div");
      bar.className = "kb-sync-collab-bar";

      const dot = document.createElement("span");
      dot.className = "kb-sync-collab-live-dot";
      bar.appendChild(dot);

      const label = document.createElement("span");
      label.className = "kb-sync-collab-live-label";
      label.textContent = "Live";
      bar.appendChild(label);

      for (const user of allUsers) {
        const colorIdx = this.hashUserColor(user);
        const avatar = document.createElement("span");
        avatar.className = `kb-sync-collab-avatar kb-sync-collab-avatar-${colorIdx}`;
        avatar.textContent = user.charAt(0).toUpperCase();
        avatar.setAttribute("aria-label", user);
        bar.appendChild(avatar);
      }

      const names = document.createElement("span");
      names.className = "kb-sync-collab-names";
      names.textContent = allUsers.join(", ");
      bar.appendChild(names);

      // Insert after tab bar, before body
      const body = this.contentEl.querySelector(".kb-sync-sidebar-body");
      if (body) {
        this.contentEl.insertBefore(bar, body);
      }
    } catch {
      // Sidebar might not be fully rendered yet — safe to ignore
    }
  }

  async refreshRemoteFiles(): Promise<void> {
    try {
      this.remoteFiles = await s3.listAllObjects(this.plugin.settings);
      // Filter out operational prefixes
      this.remoteFiles = this.remoteFiles.filter(
        (f) => !f.key.startsWith("_")
      );
      this.remoteFiles.sort((a, b) => a.key.localeCompare(b.key));
      if (this.activeTab === "files") {
        this.render();
      }
    } catch {
      // Silently fail — status bar will show offline/error
    }
  }

  async refreshPresence(): Promise<void> {
    try {
      const items = await s3.listObjects(this.plugin.settings, "_presence/", 50);
      const entries: PresenceEntry[] = [];
      for (const item of items) {
        if (!item.key.endsWith(".json")) continue;
        try {
          const { body } = await s3.getObject(this.plugin.settings, item.key);
          entries.push(JSON.parse(body));
        } catch { /* skip */ }
      }
      this.teamPresence = entries;
      if (this.activeTab === "team") {
        this.render();
      }
    } catch { /* silently fail */ }
  }

  async refreshHandoffs(): Promise<void> {
    try {
      const items = await s3.listObjects(this.plugin.settings, "_handoffs/", 100);
      const handoffs: Handoff[] = [];
      for (const item of items) {
        if (!item.key.endsWith(".json")) continue;
        try {
          const { body } = await s3.getObject(this.plugin.settings, item.key);
          handoffs.push(JSON.parse(body));
        } catch { /* skip */ }
      }
      this.handoffs = handoffs.sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
      );
      if (this.activeTab === "handoffs") {
        this.render();
      }
    } catch { /* silently fail */ }
  }

  async refreshChat(): Promise<void> {
    try {
      const items = await s3.listObjects(this.plugin.settings, "_chat/", 200);
      const messages: ChatMessage[] = [];
      for (const item of items) {
        if (!item.key.endsWith(".json")) continue;
        try {
          const { body } = await s3.getObject(this.plugin.settings, item.key);
          messages.push(JSON.parse(body));
        } catch { /* skip */ }
      }
      this.chatMessages = messages.sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      // Keep only recent messages
      if (this.chatMessages.length > this.maxChatMessages) {
        this.chatMessages = this.chatMessages.slice(-this.maxChatMessages);
      }
      if (this.activeTab === "chat") {
        // Don't re-render if user is actively typing
        const activeEl = document.activeElement;
        if (activeEl?.classList.contains("kb-sync-chat-input")) {
          return;
        }
        this.render();
      }
    } catch { /* silently fail */ }
  }

  async sendChatMessage(text: string): Promise<void> {
    const userName = this.plugin.settings.userName;
    if (!userName || !text.trim()) return;

    const msg: ChatMessage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      user: userName,
      text: text.trim(),
      timestamp: new Date().toISOString(),
    };

    try {
      await s3.putObject(
        this.plugin.settings,
        `_chat/${msg.id}.json`,
        JSON.stringify(msg, null, 2),
        {},
        "application/json"
      );
      this.chatMessages.push(msg);
      if (this.activeTab === "chat") {
        this.render();
      }
    } catch { /* silently fail */ }
  }

  async updatePresence(): Promise<void> {
    const userName = this.plugin.settings.userName;
    if (!userName) return;

    try {
      const tabs = this.getOpenTabInfo();
      const activeTab = tabs.find((t) => t.isActive);
      const entry: PresenceEntry = {
        user: userName,
        heartbeat: new Date().toISOString(),
        workingOn: activeTab?.path || "",
        openDocs: tabs.map((t) => t.path),
        status: "active",
        statusMessage: this.plugin.settings.statusMessage || undefined,
      };
      await s3.putObject(
        this.plugin.settings,
        `_presence/${userName}.json`,
        JSON.stringify(entry, null, 2),
        {},
        "application/json"
      );
    } catch { /* silently fail */ }
  }

  private getOpenTabInfo(): { path: string; isActive: boolean }[] {
    const syncFolder = this.plugin.settings.syncFolderPath;
    const activeFile = this.app.workspace.getActiveFile();
    const tabs: { path: string; isActive: boolean }[] = [];
    const seen = new Set<string>();

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as any)?.file;
      if (file?.path?.startsWith(syncFolder + "/")) {
        const rel = file.path.replace(syncFolder + "/", "");
        if (!seen.has(rel)) {
          seen.add(rel);
          tabs.push({ path: rel, isActive: activeFile?.path === file.path });
        }
      }
    }
    return tabs;
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("kb-sync-sidebar");

    // Tab bar
    const tabBar = contentEl.createDiv({ cls: "kb-sync-tab-bar" });

    const tabs: { id: TabName; label: string }[] = [
      { id: "files", label: "Files" },
      { id: "team", label: "Team" },
      { id: "chat", label: "Chat" },
      { id: "handoffs", label: "Handoffs" },
      { id: "history", label: "History" },
    ];

    for (const tab of tabs) {
      const tabEl = tabBar.createDiv({
        cls: `kb-sync-tab ${this.activeTab === tab.id ? "kb-sync-tab-active" : ""}`,
      });
      tabEl.setText(tab.label);

      // Badge for open handoffs
      if (tab.id === "handoffs") {
        const openCount = this.handoffs.filter((h) => h.status === "open").length;
        if (openCount > 0) {
          tabEl.createSpan({ cls: "kb-sync-tab-badge", text: String(openCount) });
        }
      }

      // Badge for active team members
      if (tab.id === "team") {
        const now = Date.now();
        const activeCount = this.teamPresence.filter(
          (p) => now - new Date(p.heartbeat).getTime() < 5 * 60 * 1000
        ).length;
        if (activeCount > 0) {
          tabEl.createSpan({ cls: "kb-sync-tab-badge kb-sync-badge-green", text: String(activeCount) });
        }
      }

      tabEl.addEventListener("click", () => {
        this.activeTab = tab.id;
        this.render();
        if (tab.id === "files") this.refreshRemoteFiles();
        if (tab.id === "team") this.refreshPresence();
        if (tab.id === "handoffs") this.refreshHandoffs();
        if (tab.id === "chat") {
          this.refreshChat();
          // Ensure file list is loaded for ! autocomplete
          if (this.remoteFiles.length === 0) this.refreshRemoteFiles();
          // Ensure presence is loaded for @ autocomplete
          if (this.teamPresence.length === 0) this.refreshPresence();
        }
        if (tab.id === "history") this.refreshHistory();
      });
    }

    // Live collaborator bar (Google Docs-style)
    try {
      this.renderCollabBar(contentEl);
    } catch {
      // Never let the collab bar crash the entire sidebar render
    }

    // Content
    const body = contentEl.createDiv({ cls: "kb-sync-sidebar-body" });

    try {
      switch (this.activeTab) {
        case "files": this.renderFiles(body); break;
        case "team": this.renderTeam(body); break;
        case "handoffs": this.renderHandoffs(body); break;
        case "chat": this.renderChat(body); break;
        case "history": this.renderHistory(body); break;
      }
    } catch (err) {
      body.createDiv({ cls: "kb-sync-empty", text: "Error rendering tab." });
      console.error("KB Sync sidebar render error:", err);
    }
  }

  // ── Files Tab ──────────────────────────────────────────

  private renderFiles(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "kb-sync-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "kb-sync-toolbar-btn",
      attr: { "aria-label": "Refresh" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshRemoteFiles());

    const countEl = toolbar.createSpan({ cls: "kb-sync-file-count" });
    countEl.setText(`${this.remoteFiles.length} file(s)`);

    if (this.remoteFiles.length === 0) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "No remote files found. Check your S3 configuration.",
      });
      return;
    }

    const tree = this.buildFileTree(this.remoteFiles);
    const list = container.createDiv({ cls: "kb-sync-file-list" });
    this.renderTree(list, tree, 0);
  }

  private buildFileTree(
    files: S3ListItem[]
  ): Map<string, S3ListItem[] | Map<string, any>> {
    const root = new Map<string, any>();
    for (const file of files) {
      const parts = file.key.split("/");
      let current = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i];
        if (!current.has(folder)) {
          current.set(folder, new Map<string, any>());
        }
        current = current.get(folder);
      }
      const filename = parts[parts.length - 1];
      current.set(filename, file);
    }
    return root;
  }

  private renderTree(
    container: HTMLElement,
    tree: Map<string, any>,
    depth: number
  ): void {
    const sortedKeys = Array.from(tree.keys()).sort((a, b) => {
      const aIsFolder = tree.get(a) instanceof Map;
      const bIsFolder = tree.get(b) instanceof Map;
      if (aIsFolder && !bIsFolder) return -1;
      if (!aIsFolder && bIsFolder) return 1;
      return a.localeCompare(b);
    });

    for (const key of sortedKeys) {
      const value = tree.get(key);
      if (value instanceof Map) {
        const folderEl = container.createDiv({ cls: "kb-sync-tree-folder" });
        folderEl.style.paddingLeft = `${depth * 16 + 4}px`;
        const iconEl = folderEl.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, "folder");
        folderEl.createSpan({ text: key, cls: "kb-sync-tree-label" });
        const children = container.createDiv({ cls: "kb-sync-tree-children" });
        this.renderTree(children, value, depth + 1);
        let collapsed = false;
        folderEl.addEventListener("click", () => {
          collapsed = !collapsed;
          children.style.display = collapsed ? "none" : "block";
          setIcon(iconEl, collapsed ? "folder-closed" : "folder");
        });
      } else {
        const file = value as S3ListItem;
        const fileEl = container.createDiv({ cls: "kb-sync-tree-file" });
        fileEl.style.paddingLeft = `${depth * 16 + 4}px`;
        const iconEl = fileEl.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, "file-text");
        fileEl.createSpan({ text: key, cls: "kb-sync-tree-label" });
        const sizeEl = fileEl.createSpan({ cls: "kb-sync-tree-meta" });
        sizeEl.setText(`${(file.size / 1024).toFixed(1)} KB`);
        fileEl.addEventListener("click", () => {
          const localPath = `${this.plugin.settings.syncFolderPath}/${file.key}`;
          const localFile = this.app.vault.getAbstractFileByPath(localPath);
          if (localFile) {
            this.app.workspace.openLinkText(localPath, "", false);
          }
        });
      }
    }
  }

  // ── Team Tab ───────────────────────────────────────────

  private renderTeam(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "kb-sync-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "kb-sync-toolbar-btn",
      attr: { "aria-label": "Refresh" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshPresence());

    if (!this.plugin.settings.userName) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "Set your name in settings to enable presence tracking.",
      });
      return;
    }

    // Status update input
    const statusBar = container.createDiv({ cls: "kb-sync-status-input-bar" });
    const statusInput = statusBar.createEl("input", {
      cls: "kb-sync-status-input",
      attr: { placeholder: "Set your status...", type: "text" },
    });
    statusInput.value = this.plugin.settings.statusMessage || "";
    const statusBtn = statusBar.createEl("button", {
      cls: "kb-sync-status-btn",
      text: "Set",
    });
    statusBtn.addEventListener("click", async () => {
      this.plugin.settings.statusMessage = statusInput.value;
      await this.plugin.saveSettings();
      await this.updatePresence();
      await this.refreshPresence();
    });
    statusInput.addEventListener("keydown", async (e) => {
      if (e.key === "Enter") {
        this.plugin.settings.statusMessage = statusInput.value;
        await this.plugin.saveSettings();
        await this.updatePresence();
        await this.refreshPresence();
      }
    });

    // Get live collab users (from WebSocket cursor data)
    const liveUsers = new Set<string>();
    const collabManager = this.plugin.collabManager;
    if (collabManager) {
      for (const docPath of collabManager.getActiveSessionPaths()) {
        for (const u of collabManager.getActiveCollaborators(docPath)) {
          liveUsers.add(u);
        }
      }
    }

    // Connection status banner
    const isCollabEnabled = this.plugin.settings.collaborationEnabled && this.plugin.settings.wsUrl;
    if (isCollabEnabled) {
      const connected = collabManager?.isConnected ?? false;
      const connBanner = container.createDiv({
        cls: `kb-sync-conn-banner ${connected ? "kb-sync-conn-ok" : "kb-sync-conn-err"}`,
      });
      connBanner.createSpan({
        cls: connected ? "kb-sync-collab-live-dot" : "kb-sync-conn-err-dot",
      });
      connBanner.createSpan({
        text: connected ? "Connected" : "Disconnected — edits won't sync",
      });
    }

    if (this.teamPresence.length === 0 && liveUsers.size === 0) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "No team members detected yet.",
      });
      return;
    }

    const now = Date.now();
    const activeTtl = 5 * 60 * 1000;
    const offlineTtl = 30 * 60 * 1000;

    // Merge S3 presence with live cursor data
    const active = this.teamPresence.filter(
      (p) => liveUsers.has(p.user) || now - new Date(p.heartbeat).getTime() < activeTtl
    );
    const recentlyActive = this.teamPresence.filter((p) => {
      if (liveUsers.has(p.user)) return false;
      const age = now - new Date(p.heartbeat).getTime();
      return age >= activeTtl && age < offlineTtl;
    });
    const offline = this.teamPresence.filter((p) => {
      if (liveUsers.has(p.user)) return false;
      return now - new Date(p.heartbeat).getTime() >= offlineTtl;
    });

    const list = container.createDiv({ cls: "kb-sync-team-list" });

    if (active.length > 0) {
      for (const entry of active) {
        this.renderPresenceCard(list, entry, liveUsers.has(entry.user) ? "active" : "active");
      }
    }

    if (recentlyActive.length > 0) {
      list.createDiv({ cls: "kb-sync-team-divider", text: "Recently active" });
      for (const entry of recentlyActive) {
        this.renderPresenceCard(list, entry, "away");
      }
    }

    if (offline.length > 0) {
      list.createDiv({ cls: "kb-sync-team-divider", text: "Offline" });
      for (const entry of offline) {
        this.renderPresenceCard(list, entry, "offline");
      }
    }
  }

  private hashUserColor(name: string): number {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
    }
    return Math.abs(hash) % 6;
  }

  private renderPresenceCard(
    container: HTMLElement,
    entry: PresenceEntry,
    presenceState: "active" | "away" | "offline"
  ): void {
    const colorIdx = this.hashUserColor(entry.user);
    const card = container.createDiv({
      cls: `kb-sync-presence-card kb-sync-pastel-${colorIdx}${presenceState === "offline" ? " kb-sync-presence-offline" : ""}`,
    });

    const header = card.createDiv({ cls: "kb-sync-presence-header" });

    let dotCls: string;
    if (presenceState === "active") {
      dotCls = `kb-sync-presence-dot kb-sync-dot-active kb-sync-dot-color-${colorIdx}`;
    } else if (presenceState === "away") {
      dotCls = "kb-sync-presence-dot kb-sync-dot-stale";
    } else {
      dotCls = "kb-sync-presence-dot kb-sync-dot-offline";
    }
    header.createSpan({ cls: dotCls });
    header.createSpan({ text: entry.user, cls: "kb-sync-presence-name" });
    if (presenceState === "offline") {
      header.createSpan({ text: "offline", cls: "kb-sync-presence-offline-label" });
    } else {
      header.createSpan({ text: this.formatTime(entry.heartbeat), cls: "kb-sync-presence-time" });
    }

    // Status message
    if (entry.statusMessage) {
      const statusEl = card.createDiv({ cls: "kb-sync-presence-status-msg" });
      statusEl.setText(entry.statusMessage);
    }

    // Don't show file details for offline users
    if (presenceState === "offline") return;

    // Working on (active file)
    if (entry.workingOn) {
      const workingEl = card.createDiv({ cls: "kb-sync-presence-working" });
      workingEl.createSpan({ text: "Working on", cls: "kb-sync-presence-label" });
      const docEl = workingEl.createDiv({ cls: "kb-sync-presence-doc kb-sync-presence-doc-active" });
      const iconEl = docEl.createSpan({ cls: "kb-sync-tree-icon" });
      setIcon(iconEl, "file-text");
      docEl.createSpan({ text: entry.workingOn });
      docEl.addEventListener("click", () => {
        this.app.workspace.openLinkText(
          `${this.plugin.settings.syncFolderPath}/${entry.workingOn}`, "", false
        );
      });
    }

    // Also open (other tabs)
    const otherDocs = entry.openDocs.filter((d) => d !== entry.workingOn);
    if (otherDocs.length > 0) {
      const alsoEl = card.createDiv({ cls: "kb-sync-presence-also" });
      alsoEl.createSpan({ text: "Also open", cls: "kb-sync-presence-label" });
      const docsEl = alsoEl.createDiv({ cls: "kb-sync-presence-docs" });
      for (const doc of otherDocs) {
        const docEl = docsEl.createDiv({ cls: "kb-sync-presence-doc" });
        const iconEl = docEl.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, "file-text");
        docEl.createSpan({ text: doc });
        docEl.addEventListener("click", () => {
          this.app.workspace.openLinkText(
            `${this.plugin.settings.syncFolderPath}/${doc}`, "", false
          );
        });
      }
    }
  }

  // ── Chat Tab ─────────────────────────────────────────

  private renderChat(container: HTMLElement): void {
    if (!this.plugin.settings.userName) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "Set your name in settings to use team chat.",
      });
      return;
    }

    const chatContainer = container.createDiv({ cls: "kb-sync-chat-container" });

    // Messages area
    const messagesEl = chatContainer.createDiv({ cls: "kb-sync-chat-messages" });

    if (this.chatMessages.length === 0) {
      messagesEl.createDiv({
        cls: "kb-sync-empty",
        text: "No messages yet. Start the conversation!",
      });
    } else {
      const currentUser = this.plugin.settings.userName;
      let lastDate = "";

      for (const msg of this.chatMessages) {
        // Day separator
        const msgDate = new Date(msg.timestamp).toDateString();
        if (msgDate !== lastDate) {
          lastDate = msgDate;
          const now = new Date();
          let dateLabel: string;
          if (msgDate === now.toDateString()) {
            dateLabel = "Today";
          } else if (msgDate === new Date(now.getTime() - 86400000).toDateString()) {
            dateLabel = "Yesterday";
          } else {
            dateLabel = new Date(msg.timestamp).toLocaleDateString(undefined, {
              weekday: "short", month: "short", day: "numeric",
            });
          }
          messagesEl.createDiv({ cls: "kb-sync-chat-day", text: dateLabel });
        }

        const isOwn = msg.user === currentUser;
        const colorIdx = this.hashUserColor(msg.user);
        const msgEl = messagesEl.createDiv({
          cls: `kb-sync-chat-msg ${isOwn ? "kb-sync-chat-msg-own" : "kb-sync-chat-msg-other"}`,
        });

        if (!isOwn) {
          const nameEl = msgEl.createDiv({ cls: "kb-sync-chat-msg-name" });
          nameEl.createSpan({
            cls: `kb-sync-chat-name-dot kb-sync-dot-color-${colorIdx}`,
          });
          nameEl.createSpan({ text: msg.user });
        }

        const bubbleEl = msgEl.createDiv({
          cls: `kb-sync-chat-bubble ${isOwn ? `kb-sync-chat-bubble-own kb-sync-chat-own-${colorIdx}` : ""}`,
        });
        this.renderMessageContent(bubbleEl, msg.text);

        const timeEl = msgEl.createDiv({ cls: "kb-sync-chat-msg-time" });
        timeEl.setText(this.formatTimeShort(msg.timestamp));
      }
    }

    // Scroll to bottom
    setTimeout(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }, 0);

    // Input area with autocomplete
    const inputWrapper = chatContainer.createDiv({ cls: "kb-sync-chat-input-wrapper" });
    const autocompleteEl = inputWrapper.createDiv({ cls: "kb-sync-chat-autocomplete" });
    autocompleteEl.style.display = "none";

    const inputBar = inputWrapper.createDiv({ cls: "kb-sync-chat-input-bar" });
    const input = inputBar.createEl("input", {
      cls: "kb-sync-chat-input",
      attr: { placeholder: "Type a message... (! for files, @ for people)", type: "text" },
    });
    // Restore saved input value
    if (this.chatInputValue) {
      input.value = this.chatInputValue;
      setTimeout(() => {
        input.setSelectionRange(this.chatInputCursor, this.chatInputCursor);
      }, 0);
    }
    const sendBtn = inputBar.createEl("button", { cls: "kb-sync-chat-send-btn" });
    setIcon(sendBtn, "send");

    let acItems: { label: string; value: string; icon: string }[] = [];
    let acIndex = 0;
    let acTrigger: { type: "file" | "user"; start: number } | null = null;

    const closeAutocomplete = () => {
      autocompleteEl.style.display = "none";
      autocompleteEl.empty();
      acTrigger = null;
      acItems = [];
      acIndex = 0;
    };

    const renderAutocomplete = () => {
      autocompleteEl.empty();
      if (acItems.length === 0) {
        closeAutocomplete();
        return;
      }
      autocompleteEl.style.display = "block";
      for (let i = 0; i < acItems.length; i++) {
        const item = acItems[i];
        const row = autocompleteEl.createDiv({
          cls: `kb-sync-chat-ac-item${i === acIndex ? " kb-sync-chat-ac-item-active" : ""}`,
        });
        const iconEl = row.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, item.icon);
        row.createSpan({ text: item.label });
        row.addEventListener("mousedown", (e) => {
          e.preventDefault();
          selectAutocomplete(i);
        });
      }
    };

    const selectAutocomplete = (index: number) => {
      if (!acTrigger || index < 0 || index >= acItems.length) return;
      const item = acItems[index];
      const val = input.value;
      const before = val.slice(0, acTrigger.start);
      const triggerChar = acTrigger.type === "file" ? "!" : "@";
      const after = val.slice(input.selectionStart || val.length);
      input.value = `${before}${triggerChar}${item.value} ${after}`;
      const cursorPos = before.length + triggerChar.length + item.value.length + 1;
      input.setSelectionRange(cursorPos, cursorPos);
      input.focus();
      closeAutocomplete();
    };

    const updateAutocomplete = () => {
      const val = input.value;
      const cursor = input.selectionStart || val.length;

      // Scan backwards from cursor to find a trigger
      let triggerPos = -1;
      let triggerType: "file" | "user" | null = null;
      for (let i = cursor - 1; i >= 0; i--) {
        if (val[i] === " " || val[i] === "\t") break;
        if (val[i] === "!" && (i === 0 || val[i - 1] === " ")) {
          triggerPos = i;
          triggerType = "file";
          break;
        }
        if (val[i] === "@" && (i === 0 || val[i - 1] === " ")) {
          triggerPos = i;
          triggerType = "user";
          break;
        }
      }

      if (triggerPos < 0 || !triggerType) {
        closeAutocomplete();
        return;
      }

      const query = val.slice(triggerPos + 1, cursor).toLowerCase();
      acTrigger = { type: triggerType, start: triggerPos };

      if (triggerType === "file") {
        acItems = this.remoteFiles
          .filter((f) => f.key.toLowerCase().includes(query))
          .slice(0, 8)
          .map((f) => ({ label: f.key, value: f.key, icon: "file-text" }));
      } else {
        const seen = new Set<string>();
        acItems = this.teamPresence
          .filter((p) => {
            if (seen.has(p.user)) return false;
            seen.add(p.user);
            return p.user.toLowerCase().includes(query);
          })
          .slice(0, 8)
          .map((p) => ({ label: p.user, value: p.user, icon: "user" }));
      }

      acIndex = 0;
      renderAutocomplete();
    };

    input.addEventListener("input", () => {
      this.chatInputValue = input.value;
      this.chatInputCursor = input.selectionStart || 0;
      updateAutocomplete();
    });
    input.addEventListener("blur", () => {
      this.chatInputValue = input.value;
      this.chatInputCursor = input.selectionStart || 0;
      // Delay to allow mousedown on autocomplete items
      setTimeout(closeAutocomplete, 150);
    });

    const doSend = async () => {
      const text = input.value;
      if (!text.trim()) return;
      closeAutocomplete();
      input.value = "";
      this.chatInputValue = "";
      this.chatInputCursor = 0;
      await this.sendChatMessage(text);
    };

    sendBtn.addEventListener("click", doSend);
    input.addEventListener("keydown", (e) => {
      if (acTrigger && acItems.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          acIndex = (acIndex + 1) % acItems.length;
          renderAutocomplete();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          acIndex = (acIndex - 1 + acItems.length) % acItems.length;
          renderAutocomplete();
          return;
        }
        if (e.key === "Tab" || (e.key === "Enter" && acItems.length > 0)) {
          e.preventDefault();
          selectAutocomplete(acIndex);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          closeAutocomplete();
          return;
        }
      }
      if (e.key === "Enter") doSend();
    });
  }

  private renderMessageContent(container: HTMLElement, text: string): void {
    // Split on !file/path and @username mentions
    const parts = text.split(/(![^\s]+|@\w+)/g);
    for (const part of parts) {
      if (part.startsWith("!") && part.length > 1) {
        const filePath = part.slice(1);
        const span = container.createSpan({ cls: "kb-sync-chat-mention-file" });
        const iconEl = span.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, "file-text");
        span.createSpan({ text: filePath });
        span.addEventListener("click", (e) => {
          e.stopPropagation();
          this.app.workspace.openLinkText(
            `${this.plugin.settings.syncFolderPath}/${filePath}`, "", false
          );
        });
      } else if (part.startsWith("@") && part.length > 1) {
        const userName = part.slice(1);
        const colorIdx = this.hashUserColor(userName);
        const span = container.createSpan({ cls: "kb-sync-chat-mention-user" });
        span.createSpan({ cls: `kb-sync-chat-mention-dot kb-sync-dot-color-${colorIdx}` });
        span.createSpan({ text: part });
      } else if (part) {
        container.appendText(part);
      }
    }
  }

  // ── Handoffs Tab ───────────────────────────────────────

  private renderHandoffs(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "kb-sync-toolbar" });
    const refreshBtn = toolbar.createEl("button", {
      cls: "kb-sync-toolbar-btn",
      attr: { "aria-label": "Refresh" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshHandoffs());

    const openHandoffs = this.handoffs.filter((h) => h.status === "open");
    const claimedHandoffs = this.handoffs.filter((h) => h.status === "claimed");
    const completedHandoffs = this.handoffs.filter((h) => h.status === "completed");

    if (this.handoffs.length === 0) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "No hand-offs yet. Hand-offs are created in Claude Code when finishing work sessions.",
      });
      return;
    }

    const list = container.createDiv({ cls: "kb-sync-handoff-list" });

    if (openHandoffs.length > 0) {
      list.createDiv({ cls: "kb-sync-handoff-section-header", text: `Open (${openHandoffs.length})` });
      for (const h of openHandoffs) {
        this.renderHandoffCard(list, h);
      }
    }

    if (claimedHandoffs.length > 0) {
      list.createDiv({ cls: "kb-sync-handoff-section-header", text: `In Progress (${claimedHandoffs.length})` });
      for (const h of claimedHandoffs) {
        this.renderHandoffCard(list, h);
      }
    }

    if (completedHandoffs.length > 0) {
      list.createDiv({ cls: "kb-sync-handoff-section-header", text: `Completed (${completedHandoffs.length})` });
      for (const h of completedHandoffs.slice(0, 10)) {
        this.renderHandoffCard(list, h);
      }
    }
  }

  private renderHandoffCard(container: HTMLElement, handoff: Handoff): void {
    const card = container.createDiv({ cls: "kb-sync-handoff-card" });

    const header = card.createDiv({ cls: "kb-sync-handoff-header" });

    const statusIcon = header.createSpan({ cls: "kb-sync-handoff-status" });
    if (handoff.status === "open") {
      statusIcon.setText("🟢");
    } else if (handoff.status === "claimed") {
      statusIcon.setText("🟡");
    } else {
      statusIcon.setText("✅");
    }

    header.createSpan({ text: handoff.subject, cls: "kb-sync-handoff-subject" });

    const meta = card.createDiv({ cls: "kb-sync-handoff-meta" });
    meta.setText(
      `${handoff.from} → ${handoff.to} · ${this.formatTime(handoff.createdAt)}${handoff.claimedBy ? ` · claimed by ${handoff.claimedBy}` : ""}`
    );

    // Expandable details
    let expanded = false;
    const detailsEl = card.createDiv({ cls: "kb-sync-handoff-details" });
    detailsEl.style.display = "none";

    card.addEventListener("click", () => {
      expanded = !expanded;
      detailsEl.style.display = expanded ? "block" : "none";
      card.toggleClass("kb-sync-handoff-expanded", expanded);
    });

    // Context
    if (handoff.context) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Context" });
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-text", text: handoff.context });
    }

    // Decisions
    if (handoff.decisions.length > 0) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Decisions" });
      const dl = detailsEl.createEl("ul", { cls: "kb-sync-handoff-detail-list" });
      for (const d of handoff.decisions) {
        dl.createEl("li", { text: d });
      }
    }

    // Blockers
    if (handoff.blockers.length > 0) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Blockers" });
      const bl = detailsEl.createEl("ul", { cls: "kb-sync-handoff-detail-list" });
      for (const b of handoff.blockers) {
        bl.createEl("li", { text: b, cls: "kb-sync-handoff-blocker" });
      }
    }

    // Next steps
    if (handoff.nextSteps.length > 0) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Next Steps" });
      const nl = detailsEl.createEl("ul", { cls: "kb-sync-handoff-detail-list" });
      for (const n of handoff.nextSteps) {
        nl.createEl("li", { text: n });
      }
    }

    // Related docs
    if (handoff.relatedDocs.length > 0) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Related Docs" });
      const rd = detailsEl.createDiv({ cls: "kb-sync-handoff-related" });
      for (const doc of handoff.relatedDocs) {
        const link = rd.createSpan({ cls: "kb-sync-handoff-doc-link", text: doc });
        link.addEventListener("click", (e) => {
          e.stopPropagation();
          const localPath = `${this.plugin.settings.syncFolderPath}/${doc}`;
          this.app.workspace.openLinkText(localPath, "", false);
        });
      }
    }

    // Notes
    if (handoff.notes) {
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-label", text: "Notes" });
      detailsEl.createDiv({ cls: "kb-sync-handoff-detail-text", text: handoff.notes });
    }
  }

  // ── Activity Tab ───────────────────────────────────────

  private renderActivity(container: HTMLElement): void {
    const toolbar = container.createDiv({ cls: "kb-sync-toolbar" });
    const clearBtn = toolbar.createEl("button", {
      cls: "kb-sync-toolbar-btn",
      attr: { "aria-label": "Clear log" },
    });
    setIcon(clearBtn, "trash-2");
    clearBtn.addEventListener("click", () => {
      this.activityLog = [];
      this.render();
    });

    const countEl = toolbar.createSpan({ cls: "kb-sync-file-count" });
    countEl.setText(`${this.activityLog.length} event(s)`);

    if (this.activityLog.length === 0) {
      container.createDiv({
        cls: "kb-sync-empty",
        text: "No sync activity yet.",
      });
      return;
    }

    // Group entries by day
    const dayGroups = this.groupByDay(this.activityLog);

    for (const [dayLabel, entries] of dayGroups) {
      const group = container.createDiv({ cls: "kb-sync-day-group" });

      // Day header with stats
      const header = group.createDiv({ cls: "kb-sync-day-header" });
      header.createSpan({ text: dayLabel, cls: "kb-sync-day-label" });

      const stats = header.createDiv({ cls: "kb-sync-day-stats" });
      const pulls = entries.filter((e) => e.action === "pull").length;
      const pushes = entries.filter((e) => e.action === "push").length;
      const conflicts = entries.filter((e) => e.action === "conflict").length;
      const errors = entries.filter((e) => e.action === "error").length;
      if (pulls > 0) stats.createSpan({ cls: "kb-sync-day-stat kb-sync-stat-pull", text: `${pulls}\u2193` });
      if (pushes > 0) stats.createSpan({ cls: "kb-sync-day-stat kb-sync-stat-push", text: `${pushes}\u2191` });
      if (conflicts > 0) stats.createSpan({ cls: "kb-sync-day-stat kb-sync-stat-conflict", text: `${conflicts}\u26A1` });
      if (errors > 0) stats.createSpan({ cls: "kb-sync-day-stat kb-sync-stat-error", text: `${errors}\u2716` });

      // Sub-group by file path
      const fileGroups = new Map<string, ActivityEntry[]>();
      for (const entry of entries) {
        const arr = fileGroups.get(entry.path) || [];
        arr.push(entry);
        fileGroups.set(entry.path, arr);
      }

      for (const [filePath, fileEntries] of fileGroups) {
        const fileEl = group.createDiv({ cls: "kb-sync-day-file" });
        const fileHeader = fileEl.createDiv({ cls: "kb-sync-day-file-header" });
        const iconEl = fileHeader.createSpan({ cls: "kb-sync-tree-icon" });
        setIcon(iconEl, "file-text");
        fileHeader.createSpan({ text: filePath, cls: "kb-sync-day-file-name" });

        fileHeader.addEventListener("click", () => {
          const localPath = `${this.plugin.settings.syncFolderPath}/${filePath}`;
          this.app.workspace.openLinkText(localPath, "", false);
        });

        for (const entry of fileEntries) {
          const actionEl = fileEl.createDiv({ cls: "kb-sync-day-action" });
          const actionIcon = actionEl.createSpan({ cls: "kb-sync-day-action-icon" });
          setIcon(actionIcon, this.activityIcon(entry.action));
          actionIcon.addClass(`kb-sync-activity-${entry.action}`);
          actionEl.createSpan({ text: this.activityLabel(entry.action), cls: "kb-sync-day-action-label" });
          actionEl.createSpan({ text: this.formatTimeShort(entry.timestamp), cls: "kb-sync-day-action-time" });
        }
      }
    }
  }

  private groupByDay(entries: ActivityEntry[]): Map<string, ActivityEntry[]> {
    const groups = new Map<string, ActivityEntry[]>();
    const now = new Date();
    const today = now.toDateString();
    const yesterday = new Date(now.getTime() - 86400000).toDateString();

    for (const entry of entries) {
      const d = new Date(entry.timestamp);
      const ds = d.toDateString();
      let label: string;

      if (ds === today) {
        label = "Today";
      } else if (ds === yesterday) {
        label = "Yesterday";
      } else {
        const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
        if (diffDays < 7) {
          label = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
        } else {
          label = d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
        }
      }

      const arr = groups.get(label) || [];
      arr.push(entry);
      groups.set(label, arr);
    }

    return groups;
  }

  private formatTimeShort(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  // ── Helpers ────────────────────────────────────────────

  private activityIcon(action: ActivityEntry["action"]): string {
    switch (action) {
      case "pull": return "download";
      case "push": return "upload";
      case "conflict": return "alert-triangle";
      case "delete": return "trash-2";
      case "error": return "x-circle";
      case "offline": return "wifi-off";
      case "queue-drain": return "check-circle";
      case "ai-process": return "sparkles";
    }
  }

  private activityLabel(action: ActivityEntry["action"]): string {
    switch (action) {
      case "pull": return "Pulled";
      case "push": return "Pushed";
      case "conflict": return "Conflict resolved";
      case "delete": return "Deleted";
      case "error": return "Error";
      case "offline": return "Queued (offline)";
      case "queue-drain": return "Queue drained";
      case "ai-process": return "AI processed";
    }
  }

  // ── Live Collaborator Bar ───────────────────────────

  private renderCollabBar(contentEl: HTMLElement): void {
    if (!this.plugin.settings.collaborationEnabled) return;

    const activeFile = this.app.workspace.getActiveFile();
    const syncFolder = this.plugin.settings.syncFolderPath;
    if (!activeFile || !activeFile.path.startsWith(syncFolder + "/")) return;

    const docPath = activeFile.path.replace(syncFolder + "/", "");
    const myName = this.plugin.settings.userName;

    // Check if we have an active collab session for this file
    const isInCollab = this.plugin.collabManager?.isInCollabMode?.(docPath) ?? false;
    if (!isInCollab) return;

    // Start with yourself (always show in live bar when collab is active)
    const allUsers: string[] = myName ? [myName] : [];

    // Add collaborators from WebSocket cursor data (instant)
    const cursorUsers: string[] = this.plugin.collabManager?.getActiveCollaborators?.(docPath) ?? [];
    for (const u of cursorUsers) {
      if (!allUsers.includes(u)) allUsers.push(u);
    }

    // Also check S3 presence as fallback
    const now = Date.now();
    for (const p of this.teamPresence) {
      if (p.user === myName || allUsers.includes(p.user)) continue;
      if (now - new Date(p.heartbeat).getTime() > 5 * 60 * 1000) continue;
      if (p.openDocs.includes(docPath) || p.workingOn === docPath) {
        allUsers.push(p.user);
      }
    }

    if (allUsers.length === 0) return;

    const bar = contentEl.createDiv({ cls: "kb-sync-collab-bar" });
    bar.createSpan({ cls: "kb-sync-collab-live-dot" });
    bar.createSpan({
      text: "Live",
      cls: "kb-sync-collab-live-label",
    });

    for (const user of allUsers) {
      const colorIdx = this.hashUserColor(user);
      const avatar = bar.createSpan({
        cls: `kb-sync-collab-avatar kb-sync-collab-avatar-${colorIdx}`,
      });
      avatar.setText(user.charAt(0).toUpperCase());
      avatar.setAttribute("aria-label", user);
    }

    bar.createSpan({
      text: allUsers.join(", "),
      cls: "kb-sync-collab-names",
    });
  }

  // ── History Tab ──────────────────────────────────────

  async refreshHistory(): Promise<void> {
    const activeFile = this.app.workspace.getActiveFile();
    const syncFolder = this.plugin.settings.syncFolderPath;

    if (!activeFile || !activeFile.path.startsWith(syncFolder + "/")) {
      this.historyDocPath = null;
      this.historyEntries = [];
      if (this.activeTab === "history") this.render();
      return;
    }

    const docPath = activeFile.path.replace(syncFolder + "/", "");
    this.historyDocPath = docPath;

    try {
      this.historyEntries = await historyManager.listSnapshots(
        this.plugin.settings,
        docPath
      );
      if (this.activeTab === "history") this.render();
    } catch {
      this.historyEntries = [];
      if (this.activeTab === "history") this.render();
    }
  }

  private renderHistory(container: HTMLElement): void {
    if (!this.historyDocPath) {
      const empty = container.createDiv({ cls: "kb-sync-history-empty" });
      empty.setText("Open a knowledge base file to view its edit history.");
      return;
    }

    // Header
    const header = container.createDiv({ cls: "kb-sync-history-header" });
    const iconEl = header.createSpan({ cls: "kb-sync-tree-icon" });
    setIcon(iconEl, "file-text");
    header.createSpan({
      text: this.historyDocPath,
      cls: "kb-sync-history-doc-name",
    });

    // Refresh button
    const refreshBtn = header.createEl("button", {
      cls: "kb-sync-toolbar-btn",
      attr: { "aria-label": "Refresh history" },
    });
    setIcon(refreshBtn, "refresh-cw");
    refreshBtn.addEventListener("click", () => this.refreshHistory());

    if (this.historyEntries.length === 0) {
      const empty = container.createDiv({ cls: "kb-sync-history-empty" });
      empty.setText("No edit history yet for this document.");
      return;
    }

    // Group by session
    const sessions = this.groupBySession(this.historyEntries);
    const list = container.createDiv({ cls: "kb-sync-history-list" });

    for (const session of sessions) {
      const sessionEl = list.createDiv({ cls: "kb-sync-history-session" });

      // Session header
      const sessionHeader = sessionEl.createDiv({ cls: "kb-sync-history-session-header" });
      const firstEntry = session[0];
      sessionHeader.createSpan({
        text: this.formatHistoryTime(firstEntry.timestamp),
        cls: "kb-sync-history-session-time",
      });

      // Entries in this session
      for (let i = 0; i < session.length; i++) {
        const entry = session[i];
        const entryEl = sessionEl.createDiv({ cls: "kb-sync-history-entry" });

        // User dot
        const colorIdx = this.hashUserColor(entry.userId);
        entryEl.createSpan({
          cls: `kb-sync-presence-dot kb-sync-dot-color-${colorIdx}`,
        });

        // User name
        entryEl.createSpan({
          text: entry.userId,
          cls: "kb-sync-history-user",
        });

        // Time
        entryEl.createSpan({
          text: this.formatTimeShort(entry.timestamp),
          cls: "kb-sync-history-time",
        });

        // Size delta
        const prevLength = i + 1 < session.length ? session[i + 1].contentLength : 0;
        const delta = entry.contentLength - prevLength;
        if (prevLength > 0) {
          const deltaText = delta >= 0 ? `+${delta}` : `${delta}`;
          const deltaCls = delta >= 0 ? "kb-sync-history-delta-pos" : "kb-sync-history-delta-neg";
          entryEl.createSpan({
            text: `${deltaText} chars`,
            cls: `kb-sync-history-delta ${deltaCls}`,
          });
        } else {
          entryEl.createSpan({
            text: `${entry.contentLength} chars`,
            cls: "kb-sync-history-delta",
          });
        }

        // Click to view/restore
        entryEl.addEventListener("click", async () => {
          const full = await historyManager.loadSnapshot(
            this.plugin.settings,
            this.historyDocPath!,
            entry.id
          );
          if (full) {
            new HistoryPreviewModal(this.app, this.plugin, full).open();
          }
        });
        entryEl.style.cursor = "pointer";
      }
    }
  }

  private groupBySession(
    entries: Omit<HistoryEntry, "content">[]
  ): Omit<HistoryEntry, "content">[][] {
    const groups: Omit<HistoryEntry, "content">[][] = [];
    let current: Omit<HistoryEntry, "content">[] = [];
    let currentSession = "";

    for (const entry of entries) {
      if (entry.sessionId !== currentSession) {
        if (current.length > 0) groups.push(current);
        current = [entry];
        currentSession = entry.sessionId;
      } else {
        current.push(entry);
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  private formatHistoryTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin} minutes ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)} hours ago`;
    if (diffMin < 2880) return "Yesterday";
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    });
  }

  private formatTime(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMin = Math.floor(diffMs / 60000);

    if (diffMin < 1) return "just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    if (diffMin < 1440) return `${Math.floor(diffMin / 60)}h ago`;
    return d.toLocaleDateString();
  }
}

// ── History Preview Modal ────────────────────────────

class HistoryPreviewModal extends Modal {
  private plugin: KBSyncPlugin;
  private entry: HistoryEntry;

  constructor(app: any, plugin: KBSyncPlugin, entry: HistoryEntry) {
    super(app);
    this.plugin = plugin;
    this.entry = entry;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass("kb-sync-history-modal");

    // Header
    const header = contentEl.createDiv({ cls: "kb-sync-history-modal-header" });
    header.createEl("h3", {
      text: `Version by ${this.entry.userId}`,
    });
    header.createDiv({
      text: new Date(this.entry.timestamp).toLocaleString(),
      cls: "kb-sync-history-modal-time",
    });
    header.createDiv({
      text: `${this.entry.contentLength} characters`,
      cls: "kb-sync-history-modal-meta",
    });

    // Content preview
    const preview = contentEl.createEl("textarea", {
      cls: "kb-sync-history-modal-content",
    });
    preview.value = this.entry.content;
    preview.readOnly = true;

    // Restore button
    const actions = contentEl.createDiv({ cls: "kb-sync-history-modal-actions" });
    const restoreBtn = actions.createEl("button", {
      text: "Restore this version",
      cls: "mod-cta",
    });
    restoreBtn.addEventListener("click", async () => {
      await this.restoreVersion();
      this.close();
    });

    const cancelBtn = actions.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async restoreVersion(): Promise<void> {
    const syncFolder = this.plugin.settings.syncFolderPath;
    const fullPath = `${syncFolder}/${this.entry.docPath}`;
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file) {
      await this.app.vault.modify(file as any, this.entry.content);
      const { Notice } = await import("obsidian");
      new Notice(`Restored version from ${new Date(this.entry.timestamp).toLocaleString()}`);
    }
  }
}
