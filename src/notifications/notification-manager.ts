/**
 * File change notification manager.
 * Detects when starred or recently-viewed docs change.
 */

import type { StarEntry } from "../stars/star-store";
import type { S3ListItem } from "../aws/s3-client";

export interface FileChangeNotification {
  docPath: string;
  reason: "starred" | "recently-viewed";
}

/**
 * Compare current remote files against previous state to find
 * changes in starred or recently-viewed documents.
 */
export function detectChanges(
  currentFiles: S3ListItem[],
  previousFiles: Map<string, string>, // docPath -> lastModified
  starredPaths: Set<string>,
  myName: string
): FileChangeNotification[] {
  const notifications: FileChangeNotification[] = [];

  for (const file of currentFiles) {
    const prevModified = previousFiles.get(file.key);
    if (!prevModified || prevModified === file.lastModified) continue;

    // File changed since last check
    if (starredPaths.has(file.key)) {
      notifications.push({ docPath: file.key, reason: "starred" });
    }
  }

  return notifications;
}

/**
 * Build a snapshot of current file modification times for comparison.
 */
export function buildFileSnapshot(
  files: S3ListItem[]
): Map<string, string> {
  const map = new Map<string, string>();
  for (const f of files) {
    map.set(f.key, f.lastModified);
  }
  return map;
}
