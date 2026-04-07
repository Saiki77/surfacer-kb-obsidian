/**
 * Document permissions store. Controls edit access per document.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface DocPermission {
  docPath: string;
  owner: string;
  mode: "editable" | "view-only";
  allowList?: string[]; // users who CAN edit even when view-only
  updatedAt: string;
  updatedBy: string;
}

function permKey(docPath: string): string {
  return `_permissions/${docPath.replace(/\//g, "--")}.json`;
}

export async function loadPermission(
  settings: KBSyncSettings,
  docPath: string
): Promise<DocPermission | null> {
  try {
    const { body } = await s3.getObject(settings, permKey(docPath));
    return JSON.parse(body) as DocPermission;
  } catch {
    return null;
  }
}

export async function setPermission(
  settings: KBSyncSettings,
  docPath: string,
  owner: string,
  mode: "editable" | "view-only",
  updatedBy: string,
  allowList?: string[]
): Promise<void> {
  const perm: DocPermission = {
    docPath,
    owner,
    mode,
    allowList,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  await s3.putObject(
    settings,
    permKey(docPath),
    JSON.stringify(perm, null, 2),
    {},
    "application/json"
  );
}

export async function removePermission(
  settings: KBSyncSettings,
  docPath: string
): Promise<void> {
  await s3.deleteObject(settings, permKey(docPath));
}

export async function loadAllPermissions(
  settings: KBSyncSettings
): Promise<Map<string, DocPermission>> {
  const map = new Map<string, DocPermission>();
  try {
    const items = await s3.listObjects(settings, "_permissions/", 200);
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      try {
        const { body } = await s3.getObject(settings, item.key);
        const perm = JSON.parse(body) as DocPermission;
        map.set(perm.docPath, perm);
      } catch { /* skip */ }
    }
  } catch { /* silently fail */ }
  return map;
}

/**
 * Check if a user can edit a document.
 */
export function canEdit(
  perm: DocPermission | null,
  userName: string
): boolean {
  if (!perm) return true; // No permission set = everyone can edit
  if (perm.mode === "editable") return true;
  if (perm.owner === userName) return true;
  if (perm.allowList?.includes(userName)) return true;
  return false;
}
