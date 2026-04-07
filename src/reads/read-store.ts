/**
 * Read receipts store. Tracks who has read each document.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface ReadReceipt {
  user: string;
  readAt: string;
}

export interface DocReads {
  docPath: string;
  readers: ReadReceipt[];
}

function readKey(docPath: string): string {
  // Encode path to safe S3 key: replace / with --
  return `_reads/${docPath.replace(/\//g, "--")}.json`;
}

export async function loadReads(
  settings: KBSyncSettings,
  docPath: string
): Promise<DocReads> {
  try {
    const { body } = await s3.getObject(settings, readKey(docPath));
    return JSON.parse(body) as DocReads;
  } catch {
    return { docPath, readers: [] };
  }
}

export async function recordRead(
  settings: KBSyncSettings,
  docPath: string,
  user: string
): Promise<void> {
  const data = await loadReads(settings, docPath);
  const existing = data.readers.findIndex((r) => r.user === user);
  const now = new Date().toISOString();
  if (existing >= 0) {
    data.readers[existing].readAt = now;
  } else {
    data.readers.push({ user, readAt: now });
  }
  await s3.putObject(
    settings,
    readKey(docPath),
    JSON.stringify(data, null, 2),
    {},
    "application/json"
  );
}

/**
 * Batch load read receipts for multiple docs.
 */
export async function loadAllReads(
  settings: KBSyncSettings
): Promise<Map<string, DocReads>> {
  const map = new Map<string, DocReads>();
  try {
    const items = await s3.listObjects(settings, "_reads/", 500);
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      try {
        const { body } = await s3.getObject(settings, item.key);
        const data = JSON.parse(body) as DocReads;
        map.set(data.docPath, data);
      } catch { /* skip */ }
    }
  } catch { /* silently fail */ }
  return map;
}
