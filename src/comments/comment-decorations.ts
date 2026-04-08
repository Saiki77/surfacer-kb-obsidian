/**
 * CM6 ViewPlugin that renders comment underlines on annotated text ranges.
 * Colors match the comment creator's user color.
 */

import { ViewPlugin, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { CommentThread } from "./comment-store";

const COMMENT_COLORS = [
  "rgba(126, 184, 218, 0.3)", // blue
  "rgba(129, 201, 149, 0.3)", // green
  "rgba(246, 166, 166, 0.3)", // red
  "rgba(196, 166, 232, 0.3)", // purple
  "rgba(249, 199, 126, 0.3)", // orange
  "rgba(166, 217, 217, 0.3)", // teal
];

const COMMENT_BORDER_COLORS = [
  "#7eb8da", "#81c995", "#f6a6a6", "#c4a6e8", "#f9c77e", "#a6d9d9",
];

function hashUserColor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}

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

        view.contentDOM.addEventListener("click", (e) => {
          const target = e.target as HTMLElement;
          const commentId = target.closest?.("[data-comment-id]")?.getAttribute("data-comment-id");
          if (commentId) onClick(commentId);
        });
      }

      update() {
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

          const colorIdx = hashUserColor(thread.createdBy);

          ranges.push(
            Decoration.mark({
              attributes: {
                "data-comment-id": thread.id,
                style: `background-color: ${COMMENT_COLORS[colorIdx]}; border-bottom: 2px solid ${COMMENT_BORDER_COLORS[colorIdx]}; cursor: pointer;`,
              },
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
