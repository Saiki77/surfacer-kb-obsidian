import type { KBSyncSettings } from "../settings";
import type { App } from "obsidian";
import { ConflictModal } from "../ui/conflict-modal";

export type ResolutionResult = {
  content: string;
  action: "keep-local" | "keep-remote" | "merged";
};

export async function resolveConflict(
  app: App,
  settings: KBSyncSettings,
  path: string,
  localContent: string,
  remoteContent: string
): Promise<ResolutionResult> {
  if (settings.conflictStrategy === "prefer-local") {
    return { content: localContent, action: "keep-local" };
  }

  if (settings.conflictStrategy === "prefer-remote") {
    return { content: remoteContent, action: "keep-remote" };
  }

  // "ask" strategy — show modal
  return new Promise<ResolutionResult>((resolve) => {
    const modal = new ConflictModal(
      app,
      path,
      localContent,
      remoteContent,
      (result) => resolve(result)
    );
    modal.open();
  });
}
