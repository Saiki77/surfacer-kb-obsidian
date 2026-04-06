import type { Plugin } from "obsidian";
import type { SyncStatus } from "../sync/sync-engine";

export class SyncStatusBar {
  private statusBarEl: HTMLElement;

  constructor(plugin: Plugin) {
    this.statusBarEl = plugin.addStatusBarItem();
    this.update("idle", 0, 0);
  }

  update(
    status: SyncStatus,
    conflicts: number,
    queued: number,
    onlineCount?: number,
    disconnected?: boolean
  ): void {
    // Collab disconnected warning (highest priority)
    if (disconnected) {
      this.statusBarEl.setText("KB: Disconnected");
      this.statusBarEl.style.color = "var(--text-error)";
      return;
    }

    this.statusBarEl.style.color = "";

    // When collab is active, show online count
    if (onlineCount != null && onlineCount > 0) {
      this.statusBarEl.setText(`KB: ${onlineCount} online`);
      return;
    }

    switch (status) {
      case "pulling":
        this.statusBarEl.setText("KB: Pulling...");
        break;
      case "pushing":
        this.statusBarEl.setText("KB: Pushing...");
        break;
      case "offline":
        this.statusBarEl.setText(`KB: Offline${queued > 0 ? ` (${queued} queued)` : ""}`);
        break;
      case "error":
        this.statusBarEl.setText("KB: Error");
        break;
      default:
        this.statusBarEl.setText(conflicts > 0 ? `KB: ${conflicts} conflict(s)` : "KB: Synced");
    }
  }
}
