/**
 * Comment thread store. Inline comments on document selections.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface CommentReply {
  id: string;
  user: string;
  text: string;
  timestamp: string;
}

export interface CommentThread {
  id: string;
  docPath: string;
  anchorStart: number;
  anchorEnd: number;
  anchorText: string; // snapshot of selected text for reanchoring
  status: "open" | "resolved";
  createdAt: string;
  createdBy: string;
  replies: CommentReply[];
}

function commentPrefix(docPath: string): string {
  return `_comments/${docPath.replace(/\//g, "--")}/`;
}

function commentKey(docPath: string, commentId: string): string {
  return `${commentPrefix(docPath)}${commentId}.json`;
}

export async function loadComments(
  settings: KBSyncSettings,
  docPath: string
): Promise<CommentThread[]> {
  const threads: CommentThread[] = [];
  try {
    const items = await s3.listObjects(settings, commentPrefix(docPath), 200);
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      try {
        const { body } = await s3.getObject(settings, item.key);
        threads.push(JSON.parse(body));
      } catch { /* skip */ }
    }
  } catch { /* silently fail */ }
  return threads.sort((a, b) => a.anchorStart - b.anchorStart);
}

export async function saveComment(
  settings: KBSyncSettings,
  thread: CommentThread
): Promise<void> {
  await s3.putObject(
    settings,
    commentKey(thread.docPath, thread.id),
    JSON.stringify(thread, null, 2),
    {},
    "application/json"
  );
}

export async function deleteComment(
  settings: KBSyncSettings,
  docPath: string,
  commentId: string
): Promise<void> {
  await s3.deleteObject(settings, commentKey(docPath, commentId));
}

/**
 * Reanchor comments after document edits.
 * Searches for anchorText near the expected position.
 */
export function reanchorComment(
  thread: CommentThread,
  docContent: string
): CommentThread {
  const searchStart = Math.max(0, thread.anchorStart - 200);
  const searchEnd = Math.min(docContent.length, thread.anchorEnd + 200);
  const region = docContent.slice(searchStart, searchEnd);
  const idx = region.indexOf(thread.anchorText);
  if (idx >= 0) {
    const newStart = searchStart + idx;
    return {
      ...thread,
      anchorStart: newStart,
      anchorEnd: newStart + thread.anchorText.length,
    };
  }
  // Fallback: try global search
  const globalIdx = docContent.indexOf(thread.anchorText);
  if (globalIdx >= 0) {
    return {
      ...thread,
      anchorStart: globalIdx,
      anchorEnd: globalIdx + thread.anchorText.length,
    };
  }
  return thread; // Can't find it, keep old positions
}
