/**
 * Approval workflow store. Tracks review requests per document.
 */

import * as s3 from "../aws/s3-client";
import type { KBSyncSettings } from "../settings";

export interface ReviewRequest {
  docPath: string;
  requestedBy: string;
  reviewer: string;
  status: "pending" | "approved" | "rejected" | "changes-requested";
  requestedAt: string;
  reviewedAt?: string;
  reviewComment?: string;
}

function reviewKey(docPath: string): string {
  return `_reviews/${docPath.replace(/\//g, "--")}.json`;
}

export async function loadReview(
  settings: KBSyncSettings,
  docPath: string
): Promise<ReviewRequest | null> {
  try {
    const { body } = await s3.getObject(settings, reviewKey(docPath));
    return JSON.parse(body) as ReviewRequest;
  } catch {
    return null;
  }
}

export async function requestReview(
  settings: KBSyncSettings,
  docPath: string,
  requestedBy: string,
  reviewer: string
): Promise<void> {
  const req: ReviewRequest = {
    docPath,
    requestedBy,
    reviewer,
    status: "pending",
    requestedAt: new Date().toISOString(),
  };
  await s3.putObject(
    settings,
    reviewKey(docPath),
    JSON.stringify(req, null, 2),
    {},
    "application/json"
  );
}

export async function submitReview(
  settings: KBSyncSettings,
  docPath: string,
  status: "approved" | "rejected" | "changes-requested",
  comment: string
): Promise<void> {
  const existing = await loadReview(settings, docPath);
  if (!existing) return;
  existing.status = status;
  existing.reviewedAt = new Date().toISOString();
  existing.reviewComment = comment;
  await s3.putObject(
    settings,
    reviewKey(docPath),
    JSON.stringify(existing, null, 2),
    {},
    "application/json"
  );
}

export async function clearReview(
  settings: KBSyncSettings,
  docPath: string
): Promise<void> {
  await s3.deleteObject(settings, reviewKey(docPath));
}

export async function loadAllReviews(
  settings: KBSyncSettings
): Promise<ReviewRequest[]> {
  const reviews: ReviewRequest[] = [];
  try {
    const items = await s3.listObjects(settings, "_reviews/", 200);
    for (const item of items) {
      if (!item.key.endsWith(".json")) continue;
      try {
        const { body } = await s3.getObject(settings, item.key);
        reviews.push(JSON.parse(body));
      } catch { /* skip */ }
    }
  } catch { /* silently fail */ }
  return reviews;
}
