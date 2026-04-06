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
    onlineCount?: number
  ): void {
    let text: string;

    // When collab is active, show online count
    if (onlineCount != null && onlineCount > 0) {
      text = `KB: ${onlineCount} online`;
      this.statusBarEl.setText(text);
      return;
    }

    switch (status) {
      case "pulling":
        text = "KB: Pulling...";
        break;
      case "pushing":
        text = "KB: Pushing...";
        break;
      case "offline":
        text = `KB: Offline${queued > 0 ? ` (${queued} queued)` : ""}`;
        break;
      case "error":
        text = "KB: Error";
        break;
      default:
        if (conflicts > 0) {
          text = `KB: ${conflicts} conflict(s)`;
        } else {
          text = "KB: Synced";
        }
    }

    this.statusBarEl.setText(text);
  }
}
