/**
 * Dashboard data aggregator. Pulls from presence, reviews, mentions, reads.
 */

import type { PresenceEntry } from "../ui/sidebar-view";
import type { ReviewRequest } from "../reviews/review-store";
import type { MentionNotification } from "../mentions/mention-store";

export interface DashboardData {
  activeEditors: { user: string; docPath: string }[];
  pendingReviews: ReviewRequest[];
  unreadMentions: MentionNotification[];
  recentPresence: PresenceEntry[];
}

export function aggregateDashboard(
  presence: PresenceEntry[],
  reviews: ReviewRequest[],
  mentions: MentionNotification[]
): DashboardData {
  const now = Date.now();
  const activeTtl = 5 * 60 * 1000;

  const activeEditors: { user: string; docPath: string }[] = [];
  const recentPresence: PresenceEntry[] = [];

  for (const p of presence) {
    const age = now - new Date(p.heartbeat).getTime();
    if (age < activeTtl) {
      recentPresence.push(p);
      if (p.workingOn) {
        activeEditors.push({ user: p.user, docPath: p.workingOn });
      }
    }
  }

  const pendingReviews = reviews.filter((r) => r.status === "pending");
  const unreadMentions = mentions.filter((m) => !m.read);

  return { activeEditors, pendingReviews, unreadMentions, recentPresence };
}
