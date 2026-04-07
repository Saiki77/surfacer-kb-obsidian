/**
 * CM6 ViewPlugin that renders comment underlines on annotated text ranges.
 */

import { ViewPlugin, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { CommentThread } from "./comment-store";

export type CommentProvider = () => CommentThread[];
export type CommentClickHandler = (threadId: string) => void;

export function commentDecorationExtension(
  getComments: CommentProvider,
  onClick: CommentClickHandler
) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = this.build(view);

        // Click handler for comment underlines
        view.contentDOM.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          const commentId = target.closest?.("[data-comment-id]")?.getAttribute("data-comment-id");
          if (commentId) onClick(commentId);
        });
      }

      update() {
        // Rebuild every update cycle so new comments appear instantly
        this.decorations = this.build(this.view);
      }

      build(view: EditorView): DecorationSet {
        const comments = getComments();
        if (comments.length === 0) return Decoration.none;

        const docLen = view.state.doc.length;
        const ranges: any[] = [];

        for (const thread of comments) {
          if (thread.status === "resolved") continue;
          const from = Math.min(Math.max(0, thread.anchorStart), docLen);
          const to = Math.min(Math.max(from, thread.anchorEnd), docLen);
          if (from >= to) continue;

          ranges.push(
            Decoration.mark({
              class: "kb-sync-comment-underline",
              attributes: { "data-comment-id": thread.id },
            }).range(from, to)
          );
        }

        ranges.sort((a: any, b: any) => a.from - b.from);
        try {
          return Decoration.set(ranges);
        } catch {
          return Decoration.none;
        }
      }

      destroy() {}
    },
    { decorations: (v) => v.decorations }
  );
}
