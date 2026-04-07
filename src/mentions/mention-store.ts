/**
 * @mention notification store. Tracks mentions per user in S3.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface MentionNotification {
  id: string;
  mentionedBy: string;
  docPath: string;
  context: string; // surrounding text snippet
  timestamp: string;
  read: boolean;
}

export interface UserMentions {
  user: string;
  mentions: MentionNotification[];
}

function mentionKey(user: string): string {
  return `_mentions/${user}.json`;
}

export async function loadMentions(
  settings: KBSyncSettings,
  user: string
): Promise<MentionNotification[]> {
  try {
    const { body } = await s3.getObject(settings, mentionKey(user));
    const data = JSON.parse(body) as UserMentions;
    return data.mentions || [];
  } catch {
    return [];
  }
}

export async function addMention(
  settings: KBSyncSettings,
  mentionedUser: string,
  mentionedBy: string,
  docPath: string,
  context: string
): Promise<void> {
  const mentions = await loadMentions(settings, mentionedUser);

  // Deduplicate: don't add if same doc + same mentioner within last 5 min
  const recent = mentions.find(
    (m) =>
      m.docPath === docPath &&
      m.mentionedBy === mentionedBy &&
      Date.now() - new Date(m.timestamp).getTime() < 5 * 60 * 1000
  );
  if (recent) return;

  mentions.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    mentionedBy,
    docPath,
    context,
    timestamp: new Date().toISOString(),
    read: false,
  });

  // Keep last 50
  const trimmed = mentions.slice(-50);

  const data: UserMentions = { user: mentionedUser, mentions: trimmed };
  await s3.putObject(
    settings,
    mentionKey(mentionedUser),
    JSON.stringify(data, null, 2),
    {},
    "application/json"
  );
}

export async function markAllRead(
  settings: KBSyncSettings,
  user: string
): Promise<void> {
  const mentions = await loadMentions(settings, user);
  for (const m of mentions) m.read = true;
  const data: UserMentions = { user, mentions };
  await s3.putObject(
    settings,
    mentionKey(user),
    JSON.stringify(data, null, 2),
    {},
    "application/json"
  );
}

/**
 * Scan document content for @mentions and notify mentioned users.
 */
export function extractMentions(text: string, teamUsers: string[]): string[] {
  const mentioned: string[] = [];
  const regex = /@(\w+)/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const name = match[1].toLowerCase();
    const found = teamUsers.find((u) => u.toLowerCase() === name);
    if (found && !mentioned.includes(found)) {
      mentioned.push(found);
    }
  }
  return mentioned;
}
