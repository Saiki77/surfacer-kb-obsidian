/**
 * Star/bookmark store. Per-user starred docs stored in S3.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface StarEntry {
  docPath: string;
  starredAt: string;
}

export interface UserStars {
  user: string;
  stars: StarEntry[];
}

function starKey(settings: KBSyncSettings, user: string): string {
  return `_stars/${user}.json`;
}

export async function loadStars(
  settings: KBSyncSettings,
  user: string
): Promise<StarEntry[]> {
  try {
    const { body } = await s3.getObject(settings, starKey(settings, user));
    const data = JSON.parse(body) as UserStars;
    return data.stars || [];
  } catch {
    return [];
  }
}

export async function saveStars(
  settings: KBSyncSettings,
  user: string,
  stars: StarEntry[]
): Promise<void> {
  const data: UserStars = { user, stars };
  await s3.putObject(
    settings,
    starKey(settings, user),
    JSON.stringify(data, null, 2),
    {},
    "application/json"
  );
}

export async function toggleStar(
  settings: KBSyncSettings,
  user: string,
  docPath: string
): Promise<{ starred: boolean; stars: StarEntry[] }> {
  const stars = await loadStars(settings, user);
  const idx = stars.findIndex((s) => s.docPath === docPath);
  let starred: boolean;
  if (idx >= 0) {
    stars.splice(idx, 1);
    starred = false;
  } else {
    stars.push({ docPath, starredAt: new Date().toISOString() });
    starred = true;
  }
  await saveStars(settings, user, stars);
  return { starred, stars };
}
