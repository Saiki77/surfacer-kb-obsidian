/**
 * CM6 ViewPlugin that highlights recently changed text regions.
 */

import { ViewPlugin, Decoration, DecorationSet, EditorView } from "@codemirror/view";
import type { ChangeRange } from "./diff-computer";

export type HighlightProvider = () => ChangeRange[];

export function highlightDecorationExtension(getRanges: HighlightProvider) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private interval: number;

      constructor(view: EditorView) {
        this.decorations = this.build(view);
        this.interval = window.setInterval(() => {
          this.decorations = this.build(view);
          view.requestMeasure();
        }, 3000);
      }

      update() {}

      build(view: EditorView): DecorationSet {
        const ranges = getRanges();
        if (ranges.length === 0) return Decoration.none;

        const docLen = view.state.doc.length;
        const decos: any[] = [];

        for (const r of ranges) {
          const from = Math.min(Math.max(0, r.from), docLen);
          const to = Math.min(Math.max(from, r.to), docLen);
          if (from >= to) continue;
          decos.push(
            Decoration.mark({
              class: "kb-sync-change-highlight",
            }).range(from, to)
          );
        }

        decos.sort((a: any, b: any) => a.from - b.from);
        try {
          return Decoration.set(decos);
        } catch {
          return Decoration.none;
        }
      }

      destroy() {
        window.clearInterval(this.interval);
      }
    },
    { decorations: (v) => v.decorations }
  );
}
