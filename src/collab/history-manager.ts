/**
 * HistoryManager: captures and manages document edit snapshots in S3.
 * Provides Google Sheets-style version history with session grouping.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface HistoryEntry {
  id: string;
  docPath: string;
  userId: string;
  timestamp: string;
  content: string;
  summary: string;
  sessionId: string;
  contentLength: number;
}

const MAX_SNAPSHOTS_PER_DOC = 50;

function historyPrefix(settings: KBSyncSettings, docPath: string): string {
  return `_history/${docPath}/`;
}

function historyKey(settings: KBSyncSettings, docPath: string, id: string): string {
  return `_history/${docPath}/${id}.json`;
}

/**
 * Save a history snapshot to S3.
 * If existingId is provided, updates that entry (same session, same user).
 * Returns the entry ID for subsequent updates.
 */
export async function saveSnapshot(
  settings: KBSyncSettings,
  docPath: string,
  content: string,
  userId: string,
  sessionId: string,
  existingId?: string
): Promise<string> {
  const timestamp = new Date().toISOString();
  const id = existingId || `${timestamp.replace(/[:.]/g, "-")}-${userId}`;

  const entry: HistoryEntry = {
    id,
    docPath,
    userId,
    timestamp,
    content,
    summary: `Edited by ${userId}`,
    sessionId,
    contentLength: content.length,
  };

  await s3.putObject(
    settings,
    historyKey(settings, docPath, id),
    JSON.stringify(entry),
    {},
    "application/json"
  );

  // Enforce max snapshots — delete oldest if over limit (only on new entries)
  if (!existingId) {
    await enforceLimit(settings, docPath);
  }

  return id;
}

/**
 * List all history entries for a document (metadata only, no content).
 * Returns newest first.
 */
export async function listSnapshots(
  settings: KBSyncSettings,
  docPath: string
): Promise<Omit<HistoryEntry, "content">[]> {
  const prefix = historyPrefix(settings, docPath);
  const items = await s3.listObjects(settings, prefix, 100);

  const entries: Omit<HistoryEntry, "content">[] = [];
  for (const item of items) {
    if (!item.key.endsWith(".json")) continue;
    try {
      const { body } = await s3.getObject(settings, item.key);
      const parsed = JSON.parse(body) as HistoryEntry;
      // Return without content to save memory
      entries.push({
        id: parsed.id,
        docPath: parsed.docPath,
        userId: parsed.userId,
        timestamp: parsed.timestamp,
        summary: parsed.summary,
        sessionId: parsed.sessionId,
        contentLength: parsed.contentLength,
      });
    } catch {
      // Skip malformed entries
    }
  }

  // Sort newest first
  entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return entries;
}

/**
 * Load a specific snapshot's full content.
 */
export async function loadSnapshot(
  settings: KBSyncSettings,
  docPath: string,
  snapshotId: string
): Promise<HistoryEntry | null> {
  try {
    const { body } = await s3.getObject(
      settings,
      historyKey(settings, docPath, snapshotId)
    );
    return JSON.parse(body) as HistoryEntry;
  } catch {
    return null;
  }
}

/**
 * Enforce the max snapshot limit per document.
 */
async function enforceLimit(
  settings: KBSyncSettings,
  docPath: string
): Promise<void> {
  const prefix = historyPrefix(settings, docPath);
  const items = await s3.listObjects(settings, prefix, 200);

  if (items.length <= MAX_SNAPSHOTS_PER_DOC) return;

  // Sort by key (timestamp-based, oldest first)
  const sorted = items
    .filter((i) => i.key.endsWith(".json"))
    .sort((a, b) => a.key.localeCompare(b.key));

  const toDelete = sorted.slice(0, sorted.length - MAX_SNAPSHOTS_PER_DOC);
  for (const item of toDelete) {
    await s3.deleteObject(settings, item.key);
  }
}
