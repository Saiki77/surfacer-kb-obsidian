export interface SyncFileEntry {
  relativePath: string;
  baseContentHash: string;
  baseModifiedTime: string;
  remoteLastModified: string;
  remoteContentHash: string;
  localLastModified: string;
  localContentHash: string;
  syncState:
    | "synced"
    | "local-modified"
    | "remote-modified"
    | "conflict"
    | "local-new"
    | "remote-new"
    | "local-deleted"
    | "remote-deleted";
}

export interface SyncManifest {
  version: 1;
  lastPullTimestamp: string | null;
  lastPushTimestamp: string | null;
  files: Record<string, SyncFileEntry>;
}

export function createEmptyManifest(): SyncManifest {
  return {
    version: 1,
    lastPullTimestamp: null,
    lastPushTimestamp: null,
    files: {},
  };
}

export class ManifestManager {
  private manifest: SyncManifest;

  constructor(data?: SyncManifest) {
    this.manifest = data?.version === 1 ? data : createEmptyManifest();
  }

  get raw(): SyncManifest {
    return this.manifest;
  }

  getEntry(path: string): SyncFileEntry | undefined {
    return this.manifest.files[path];
  }

  setEntry(path: string, entry: SyncFileEntry): void {
    this.manifest.files[path] = entry;
  }

  removeEntry(path: string): void {
    delete this.manifest.files[path];
  }

  getAllPaths(): string[] {
    return Object.keys(this.manifest.files);
  }

  setLastPull(timestamp: string): void {
    this.manifest.lastPullTimestamp = timestamp;
  }

  setLastPush(timestamp: string): void {
    this.manifest.lastPushTimestamp = timestamp;
  }

  toJSON(): SyncManifest {
    return this.manifest;
  }
}
