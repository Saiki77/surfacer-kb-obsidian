import { App, Notice, TFile, TFolder, normalizePath } from "obsidian";
import type { KBSyncSettings } from "../settings";
import { ManifestManager, type SyncFileEntry } from "./manifest-manager";
import {
  detectChanges,
  type LocalFileInfo,
  type RemoteFileInfo,
} from "./change-detector";
import { OfflineQueue } from "./offline-queue";
import { resolveConflict } from "./conflict-resolver";
import * as s3 from "../aws/s3-client";
import { hashContent } from "../utils/hashing";
import {
  parseFrontmatter,
  metadataToS3Headers,
} from "../utils/metadata";
import type { ActivityEntry } from "../ui/sidebar-view";
import { threeWayMerge } from "./three-way-merge";
import * as historyManager from "../collab/history-manager";

export type SyncStatus =
  | "idle"
  | "pulling"
  | "pushing"
  | "offline"
  | "error";

export class SyncEngine {
  private app: App;
  private settings: KBSyncSettings;
  private manifest: ManifestManager;
  private queue: OfflineQueue;
  private locked = false;
  private _status: SyncStatus = "idle";
  private _conflictCount = 0;
  private onStatusChange: (status: SyncStatus, conflicts: number) => void;
  private onActivity: (entry: ActivityEntry) => void;
  private collabChecker: ((path: string) => boolean) | null = null;

  constructor(
    app: App,
    settings: KBSyncSettings,
    manifestData: any,
    queueData: any,
    onStatusChange: (status: SyncStatus, conflicts: number) => void,
    onActivity: (entry: ActivityEntry) => void = () => {}
  ) {
    this.app = app;
    this.settings = settings;
    this.manifest = new ManifestManager(manifestData?.manifest);
    this.queue = new OfflineQueue();
    if (queueData?.queue) this.queue.load(queueData.queue);
    this.onStatusChange = onStatusChange;
    this.onActivity = onActivity;
  }

  private logActivity(
    action: ActivityEntry["action"],
    path: string,
    detail?: string
  ): void {
    this.onActivity({
      timestamp: new Date().toISOString(),
      action,
      path,
      detail,
    });
  }

  get status(): SyncStatus {
    return this._status;
  }

  get conflictCount(): number {
    return this._conflictCount;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  getManifestData(): any {
    return { manifest: this.manifest.toJSON(), queue: this.queue.toJSON() };
  }

  updateSettings(settings: KBSyncSettings): void {
    this.settings = settings;
  }

  setCollabChecker(checker: (path: string) => boolean): void {
    this.collabChecker = checker;
  }

  private isInCollabMode(path: string): boolean {
    return this.collabChecker ? this.collabChecker(path) : false;
  }

  /**
   * Check if a file is currently open in any editor tab.
   * Open files should NEVER be silently overwritten by pull.
   */
  /**
   * Save a backup of content to S3 before overwriting.
   * Backups stored in _backups/{path}/{timestamp}-{source}.md
   */
  private async backupFile(
    relativePath: string,
    content: string,
    source: "local" | "remote"
  ): Promise<void> {
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const backupKey = `_backups/${relativePath}/${ts}-${source}.md`;
      await s3.putObject(this.settings, backupKey, content, {}, "text/markdown");
    } catch {
      // Backup is best-effort — don't block sync
    }
  }

  private isFileOpen(relativePath: string): boolean {
    const fullPath = this.vaultPath(relativePath);
    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = (leaf.view as any)?.file;
      if (file?.path === fullPath) return true;
    }
    return false;
  }

  private setStatus(status: SyncStatus): void {
    this._status = status;
    this.onStatusChange(status, this._conflictCount);
  }

  private async acquireLock(): Promise<boolean> {
    if (this.locked) return false;
    this.locked = true;
    return true;
  }

  private releaseLock(): void {
    this.locked = false;
  }

  private syncFolderPath(): string {
    return normalizePath(this.settings.syncFolderPath);
  }

  private async ensureSyncFolder(): Promise<void> {
    const folderPath = this.syncFolderPath();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      try {
        await this.app.vault.createFolder(folderPath);
      } catch {
        // Folder may already exist (race condition)
      }
    }
  }

  private async getLocalFiles(): Promise<Map<string, LocalFileInfo>> {
    const map = new Map<string, LocalFileInfo>();
    const folderPath = this.syncFolderPath();
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder || !(folder instanceof TFolder)) return map;

    const files = this.app.vault.getMarkdownFiles().filter((f) =>
      f.path.startsWith(folderPath + "/")
    );

    for (const file of files) {
      const relativePath = file.path.slice(folderPath.length + 1);
      const content = await this.app.vault.read(file);
      map.set(relativePath, {
        relativePath,
        contentHash: hashContent(content),
        mtime: new Date(file.stat.mtime).toISOString(),
      });
    }

    return map;
  }

  private async getRemoteFiles(): Promise<Map<string, RemoteFileInfo>> {
    const map = new Map<string, RemoteFileInfo>();
    const items = await s3.listAllObjects(this.settings);
    for (const item of items) {
      if (item.key.endsWith(".md")) {
        map.set(item.key, {
          relativePath: item.key,
          lastModified: item.lastModified,
          size: item.size,
        });
      }
    }
    return map;
  }

  private vaultPath(relativePath: string): string {
    return normalizePath(`${this.syncFolderPath()}/${relativePath}`);
  }

  private async writeLocalFile(
    relativePath: string,
    content: string
  ): Promise<void> {
    const fullPath = this.vaultPath(relativePath);

    // Ensure parent folders exist (create entire path)
    const parts = fullPath.split("/");
    parts.pop();
    for (let i = 1; i <= parts.length; i++) {
      const folderPath = parts.slice(0, i).join("/");
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        try {
          await this.app.vault.createFolder(folderPath);
        } catch {
          // Folder may already exist (race condition)
        }
      }
    }

    const existing = this.app.vault.getAbstractFileByPath(fullPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      try {
        await this.app.vault.create(fullPath, content);
      } catch {
        // File may already exist (vault cache stale) — try modify
        const retryFile = this.app.vault.getAbstractFileByPath(fullPath);
        if (retryFile instanceof TFile) {
          await this.app.vault.modify(retryFile, content);
        }
      }
    }
  }

  private async readLocalFile(relativePath: string): Promise<string | null> {
    const fullPath = this.vaultPath(relativePath);
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      return await this.app.vault.read(file);
    }
    return null;
  }

  private async deleteLocalFile(relativePath: string): Promise<void> {
    const fullPath = this.vaultPath(relativePath);
    const file = this.app.vault.getAbstractFileByPath(fullPath);
    if (file instanceof TFile) {
      await this.app.vault.delete(file);
    }
  }

  private async pushToS3(
    path: string,
    content: string
  ): Promise<void> {
    const { metadata } = parseFrontmatter(content);
    await s3.putObject(
      this.settings,
      path,
      content,
      metadataToS3Headers(metadata)
    );
  }

  private makeSyncedEntry(
    relativePath: string,
    contentHash: string,
    remoteLastModified: string
  ): SyncFileEntry {
    const now = new Date().toISOString();
    return {
      relativePath,
      baseContentHash: contentHash,
      baseModifiedTime: now,
      remoteLastModified,
      remoteContentHash: contentHash,
      localLastModified: now,
      localContentHash: contentHash,
      syncState: "synced",
    };
  }

  async pull(): Promise<void> {
    if (!this.settings.syncEnabled) return;
    if (!(await this.acquireLock())) return;

    try {
      this.setStatus("pulling");

      const online = await s3.checkConnectivity(this.settings);
      if (!online) {
        this.setStatus("offline");
        return;
      }

      await this.ensureSyncFolder();

      // Drain offline queue first
      await this.drainQueue();

      const localFiles = await this.getLocalFiles();
      const remoteFiles = await this.getRemoteFiles();
      const plan = detectChanges(
        this.manifest.toJSON(),
        localFiles,
        remoteFiles
      );

      // Pull: remote changed, local didn't (with backup)
      for (const path of plan.pull) {
        if (this.isInCollabMode(path)) continue;
        if (this.isFileOpen(path)) {
          this.logActivity("pull", path, "Skipped (file open in editor)");
          continue;
        }
        // Backup local version before overwriting (if it exists and has content)
        const localContent = await this.readLocalFile(path);
        if (localContent && localContent.length > 0) {
          await this.backupFile(path, localContent, "local");
        }
        const { body } = await s3.getObject(this.settings, path);
        await this.writeLocalFile(path, body);
        const remote = remoteFiles.get(path)!;
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(path, hashContent(body), remote.lastModified)
        );
        this.logActivity("pull", path, "Updated from remote");
      }

      // New remote files
      for (const path of plan.newRemote) {
        if (this.isInCollabMode(path)) continue;
        const { body } = await s3.getObject(this.settings, path);
        await this.writeLocalFile(path, body);
        const remote = remoteFiles.get(path)!;
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(path, hashContent(body), remote.lastModified)
        );
        this.logActivity("pull", path, "New file from remote");
      }

      // Deleted from remote, local unchanged
      for (const path of plan.deletedRemote) {
        if (this.isFileOpen(path)) {
          this.logActivity("delete", path, "Skipped delete (file open)");
          continue;
        }
        await this.deleteLocalFile(path);
        this.manifest.removeEntry(path);
        this.logActivity("delete", path, "Deleted (removed from remote)");
      }

      // Conflicts
      this._conflictCount = 0;
      for (const path of plan.conflicts) {
        if (this.isInCollabMode(path)) continue;
        if (this.isFileOpen(path)) {
          this.logActivity("conflict", path, "Skipped (file open, local preserved)");
          continue;
        }
        await this.handleConflict(path, localFiles, remoteFiles);
      }

      // Clean up entries for files deleted from both sides
      for (const path of plan.unchanged) {
        if (!localFiles.has(path) && !remoteFiles.has(path)) {
          this.manifest.removeEntry(path);
        }
      }

      this.manifest.setLastPull(new Date().toISOString());
      this.setStatus("idle");

      if (plan.pull.length + plan.newRemote.length > 0) {
        new Notice(
          `KB Sync: Pulled ${plan.pull.length + plan.newRemote.length} file(s)`
        );
      }
    } catch (err) {
      console.error("KB Sync pull error:", err);
      this.setStatus("error");
      new Notice(`KB Sync error: ${(err as Error).message}`);
    } finally {
      this.releaseLock();
    }
  }

  async push(): Promise<void> {
    if (!this.settings.syncEnabled) return;
    if (!(await this.acquireLock())) return;

    try {
      this.setStatus("pushing");

      const online = await s3.checkConnectivity(this.settings);
      if (!online) {
        // Queue local changes for later
        const localFiles = await this.getLocalFiles();
        for (const [path, info] of localFiles) {
          const entry = this.manifest.getEntry(path);
          if (!entry || info.contentHash !== entry.baseContentHash) {
            this.queue.enqueue({
              type: "push",
              relativePath: path,
              contentHash: info.contentHash,
            });
            this.logActivity("offline", path, "Queued for push when online");
          }
        }
        this.setStatus("offline");
        return;
      }

      await this.ensureSyncFolder();
      await this.drainQueue();

      const localFiles = await this.getLocalFiles();
      const remoteFiles = await this.getRemoteFiles();
      const plan = detectChanges(
        this.manifest.toJSON(),
        localFiles,
        remoteFiles
      );

      // Push: local changed, remote didn't (with safety check)
      const pushSessionId = `${Date.now()}-sync`;
      for (const path of plan.push) {
        if (this.isInCollabMode(path)) continue;
        const content = await this.readLocalFile(path);
        if (!content) continue;

        // Safety: verify remote hasn't ALSO changed (MCP/external write)
        const remote = remoteFiles.get(path);
        const manifestEntry = this.manifest.getEntry(path);
        if (remote && manifestEntry && remote.lastModified !== manifestEntry.remoteLastModified) {
          // BOTH sides changed — smart merge using base from manifest
          const remoteContent = (await s3.getObject(this.settings, path)).body;
          // Reconstruct base from local content using manifest hash
          // If we don't have the exact base, use an empty string (treats everything as new)
          const baseContent = manifestEntry.baseContentHash === hashContent(content)
            ? content // Local didn't actually change from base
            : manifestEntry.baseContentHash === hashContent(remoteContent)
              ? remoteContent // Remote didn't actually change from base
              : ""; // Both truly changed, no base available — will produce conflict markers

          // Try to find a real base from history
          let realBase = baseContent;
          if (realBase === "") {
            // Use the content that matches the base hash as base
            // If neither matches, we just merge with conflict markers
            realBase = "";
          }

          const mergeResult = threeWayMerge(realBase, content, remoteContent);

          // Always backup both versions before merging
          await this.backupFile(path, content, "local");
          await this.backupFile(path, remoteContent, "remote");

          if (mergeResult.success) {
            // Clean merge — push the merged content
            await this.pushToS3(path, mergeResult.content);
            await this.writeLocalFile(path, mergeResult.content);
            this.manifest.setEntry(path, this.makeSyncedEntry(path, hashContent(mergeResult.content), new Date().toISOString()));
            this.logActivity("push", path, "Auto-merged local + remote changes");
            new Notice(`Merged: ${path.split("/").pop()}`);
          } else {
            // Conflicts — push merged content with conflict markers, let user resolve
            await this.pushToS3(path, mergeResult.content);
            await this.writeLocalFile(path, mergeResult.content);
            this.manifest.setEntry(path, this.makeSyncedEntry(path, hashContent(mergeResult.content), new Date().toISOString()));
            this.logActivity("conflict", path, `Auto-merged with ${mergeResult.conflicts} conflict(s)`);
            new Notice(`Merged with ${mergeResult.conflicts} conflict(s): ${path.split("/").pop()}`);
          }
          continue;
        }

        await this.pushToS3(path, content);
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(
            path,
            hashContent(content),
            new Date().toISOString()
          )
        );
        this.logActivity("push", path, "Uploaded to remote");
        // Save history snapshot
        try {
          await historyManager.saveSnapshot(
            this.settings,
            path,
            content,
            this.settings.userName || "system",
            pushSessionId
          );
        } catch { /* History save is best-effort */ }
      }

      // New local files
      for (const path of plan.newLocal) {
        if (this.isInCollabMode(path)) continue;
        const content = await this.readLocalFile(path);
        if (!content) continue;
        await this.pushToS3(path, content);
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(
            path,
            hashContent(content),
            new Date().toISOString()
          )
        );
        this.logActivity("push", path, "New file uploaded");
      }

      // Locally deleted files
      for (const path of plan.deletedLocal) {
        await s3.deleteObject(this.settings, path);
        this.manifest.removeEntry(path);
        this.logActivity("delete", path, "Deleted from remote");
      }

      this.manifest.setLastPush(new Date().toISOString());
      this.setStatus("idle");

      const pushed = plan.push.length + plan.newLocal.length;
      if (pushed > 0) {
        new Notice(`KB Sync: Pushed ${pushed} file(s)`);
      }
    } catch (err) {
      console.error("KB Sync push error:", err);
      this.setStatus("error");
      new Notice(`KB Sync error: ${(err as Error).message}`);
    } finally {
      this.releaseLock();
    }
  }

  private async handleConflict(
    path: string,
    localFiles: Map<string, LocalFileInfo>,
    remoteFiles: Map<string, RemoteFileInfo>
  ): Promise<void> {
    const local = localFiles.get(path);
    const remote = remoteFiles.get(path);

    const localContent = local
      ? (await this.readLocalFile(path)) || ""
      : "";
    const remoteContent = remote
      ? (await s3.getObject(this.settings, path)).body
      : "";

    // Check if both sides converged to the same content
    if (
      localContent &&
      remoteContent &&
      hashContent(localContent) === hashContent(remoteContent)
    ) {
      // Converged — just update manifest
      this.manifest.setEntry(
        path,
        this.makeSyncedEntry(
          path,
          hashContent(localContent),
          remote?.lastModified || new Date().toISOString()
        )
      );
      return;
    }

    // Handle delete/modify conflicts
    if (!localContent && remoteContent) {
      // Locally deleted, remotely modified
      const result = await resolveConflict(
        this.app,
        this.settings,
        path,
        "(file deleted locally)",
        remoteContent
      );
      if (result.action === "keep-remote" || result.action === "merged") {
        await this.writeLocalFile(path, result.content);
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(
            path,
            hashContent(result.content),
            remote?.lastModified || new Date().toISOString()
          )
        );
      } else {
        await s3.deleteObject(this.settings, path);
        this.manifest.removeEntry(path);
      }
      return;
    }

    if (localContent && !remoteContent) {
      // Remotely deleted, locally modified
      const result = await resolveConflict(
        this.app,
        this.settings,
        path,
        localContent,
        "(file deleted remotely)"
      );
      if (result.action === "keep-local" || result.action === "merged") {
        const { metadata } = parseFrontmatter(result.content);
        await s3.putObject(
          this.settings,
          path,
          result.content,
          metadataToS3Headers(metadata)
        );
        this.manifest.setEntry(
          path,
          this.makeSyncedEntry(
            path,
            hashContent(result.content),
            new Date().toISOString()
          )
        );
      } else {
        await this.deleteLocalFile(path);
        this.manifest.removeEntry(path);
      }
      return;
    }

    // Both modified — try smart merge first
    await this.backupFile(path, localContent, "local");
    await this.backupFile(path, remoteContent, "remote");

    // Try three-way merge (base = empty string since we may not have the original)
    const mergeResult = threeWayMerge("", localContent, remoteContent);

    let finalContent: string;
    if (mergeResult.success) {
      finalContent = mergeResult.content;
      this.logActivity("conflict", path, "Auto-merged successfully");
      new Notice(`Auto-merged: ${path.split("/").pop()}`);
    } else if (mergeResult.conflicts <= 3) {
      // Few conflicts — use merged content with markers, let user clean up
      finalContent = mergeResult.content;
      this._conflictCount++;
      this.logActivity("conflict", path, `Merged with ${mergeResult.conflicts} conflict(s)`);
      new Notice(`Merged with conflicts: ${path.split("/").pop()}`);
    } else {
      // Too many conflicts — fall back to manual resolution
      this._conflictCount++;
      const result = await resolveConflict(
        this.app,
        this.settings,
        path,
        localContent,
        remoteContent
      );
      finalContent = result.content;
    }

    await this.writeLocalFile(path, finalContent);
    const { metadata } = parseFrontmatter(result.content);
    await s3.putObject(
      this.settings,
      path,
      result.content,
      metadataToS3Headers(metadata)
    );
    this.manifest.setEntry(
      path,
      this.makeSyncedEntry(
        path,
        hashContent(result.content),
        new Date().toISOString()
      )
    );
    this.logActivity("conflict", path, `Resolved: ${result.action}`);
  }

  private async drainQueue(): Promise<void> {
    if (this.queue.isEmpty) return;

    const ops = this.queue.drain();
    for (const op of ops) {
      try {
        if (op.type === "push") {
          const content = await this.readLocalFile(op.relativePath);
          if (content) {
            await this.pushToS3(op.relativePath, content);
            this.manifest.setEntry(
              op.relativePath,
              this.makeSyncedEntry(
                op.relativePath,
                hashContent(content),
                new Date().toISOString()
              )
            );
          }
        } else if (op.type === "delete-remote") {
          await s3.deleteObject(this.settings, op.relativePath);
          this.manifest.removeEntry(op.relativePath);
        }
      } catch (err) {
        console.error(`KB Sync queue drain error for ${op.relativePath}:`, err);
        // Re-queue failed operations
        this.queue.enqueue(op);
      }
    }
  }

  async forceSync(): Promise<void> {
    await this.pull();
    await this.push();
  }

  /**
   * Handle a folder rename in the vault by moving all S3 objects
   * under the old prefix to the new prefix and updating the manifest.
   */
  async handleFolderRename(
    oldFolderRelPath: string,
    newFolderRelPath: string
  ): Promise<void> {
    if (!(await this.acquireLock())) return;

    try {
      this.setStatus("pushing");

      const online = await s3.checkConnectivity(this.settings);
      if (!online) {
        // Can't rename on S3 while offline — queue a full push for later
        this.setStatus("offline");
        return;
      }

      const oldPrefix = oldFolderRelPath.endsWith("/")
        ? oldFolderRelPath
        : oldFolderRelPath + "/";
      const newPrefix = newFolderRelPath.endsWith("/")
        ? newFolderRelPath
        : newFolderRelPath + "/";

      const moved = await s3.renamePrefix(
        this.settings,
        oldPrefix,
        newPrefix
      );

      // Update manifest entries for moved files
      for (const [oldKey, newKey] of moved) {
        const entry = this.manifest.getEntry(oldKey);
        if (entry) {
          this.manifest.removeEntry(oldKey);
          this.manifest.setEntry(newKey, {
            ...entry,
            relativePath: newKey,
          });
        }
        this.logActivity("push", newKey, `Renamed from ${oldKey}`);
      }

      if (moved.length > 0) {
        new Notice(
          `KB Sync: Renamed folder — moved ${moved.length} file(s)`
        );
      }

      this.setStatus("idle");
    } catch (err) {
      console.error("KB Sync folder rename error:", err);
      this.setStatus("error");
      new Notice(`KB Sync error: ${(err as Error).message}`);
    } finally {
      this.releaseLock();
    }
  }

  /**
   * Handle a folder deletion in the vault by removing all S3 objects
   * under that prefix and cleaning up the manifest.
   */
  async handleFolderDelete(folderRelPath: string): Promise<void> {
    if (!(await this.acquireLock())) return;

    try {
      this.setStatus("pushing");

      const online = await s3.checkConnectivity(this.settings);
      if (!online) {
        this.setStatus("offline");
        return;
      }

      const prefix = folderRelPath.endsWith("/")
        ? folderRelPath
        : folderRelPath + "/";

      const items = await s3.listAllObjects(this.settings);
      let deleted = 0;

      for (const item of items) {
        if (item.key.startsWith(prefix)) {
          await s3.deleteObject(this.settings, item.key);
          this.manifest.removeEntry(item.key);
          this.logActivity("delete", item.key, "Deleted (folder removed)");
          deleted++;
        }
      }

      if (deleted > 0) {
        new Notice(`KB Sync: Deleted folder — removed ${deleted} file(s)`);
      }

      this.setStatus("idle");
    } catch (err) {
      console.error("KB Sync folder delete error:", err);
      this.setStatus("error");
      new Notice(`KB Sync error: ${(err as Error).message}`);
    } finally {
      this.releaseLock();
    }
  }
}
