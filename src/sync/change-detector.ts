import type { SyncManifest } from "./manifest-manager";

export interface LocalFileInfo {
  relativePath: string;
  contentHash: string;
  mtime: string;
}

export interface RemoteFileInfo {
  relativePath: string;
  lastModified: string;
  size: number;
}

export interface SyncPlan {
  pull: string[];
  push: string[];
  conflicts: string[];
  newRemote: string[];
  newLocal: string[];
  deletedRemote: string[];
  deletedLocal: string[];
  converged: string[];
  unchanged: string[];
}

export function detectChanges(
  manifest: SyncManifest,
  localFiles: Map<string, LocalFileInfo>,
  remoteFiles: Map<string, RemoteFileInfo>
): SyncPlan {
  const plan: SyncPlan = {
    pull: [],
    push: [],
    conflicts: [],
    newRemote: [],
    newLocal: [],
    deletedRemote: [],
    deletedLocal: [],
    converged: [],
    unchanged: [],
  };

  // Collect all known paths
  const allPaths = new Set<string>();
  for (const path of Object.keys(manifest.files)) allPaths.add(path);
  for (const path of localFiles.keys()) allPaths.add(path);
  for (const path of remoteFiles.keys()) allPaths.add(path);

  for (const path of allPaths) {
    const entry = manifest.files[path];
    const local = localFiles.get(path);
    const remote = remoteFiles.get(path);

    if (entry && local && remote) {
      // CASE A: File exists everywhere
      const remoteChanged =
        remote.lastModified !== entry.remoteLastModified;
      const localChanged =
        local.contentHash !== entry.baseContentHash;

      if (!remoteChanged && !localChanged) {
        plan.unchanged.push(path);
      } else if (remoteChanged && !localChanged) {
        plan.pull.push(path);
      } else if (!remoteChanged && localChanged) {
        plan.push.push(path);
      } else {
        // Both changed — could be converged or conflict
        // We mark as conflict here; sync engine will download and check hashes
        plan.conflicts.push(path);
      }
    } else if (!entry && !local && remote) {
      // CASE B: New in S3 only
      plan.newRemote.push(path);
    } else if (entry && local && !remote) {
      // CASE C: Deleted from S3
      const localChanged =
        local.contentHash !== entry.baseContentHash;
      if (localChanged) {
        plan.conflicts.push(path);
      } else {
        plan.deletedRemote.push(path);
      }
    } else if (entry && !local && remote) {
      // CASE D: Deleted locally
      const remoteChanged =
        remote.lastModified !== entry.remoteLastModified;
      if (remoteChanged) {
        plan.conflicts.push(path);
      } else {
        plan.deletedLocal.push(path);
      }
    } else if (!entry && local && remote) {
      // CASE E: Both exist but no manifest entry (first sync or reset)
      // Mark as conflict; sync engine will compare content
      plan.conflicts.push(path);
    } else if (!entry && local && !remote) {
      // CASE F: New local file
      plan.newLocal.push(path);
    } else if (entry && !local && !remote) {
      // CASE G: Deleted from both sides
      plan.unchanged.push(path);
    }
  }

  return plan;
}
