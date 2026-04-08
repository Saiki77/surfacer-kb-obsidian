/**
 * CM6 ViewPlugin that renders remote cursor positions and selections
 * from collaborators. Shows colored cursor bars and name labels.
 */

import {
  ViewPlugin,
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import type { CursorInfo } from "./collab-session";

// 6 pastel colors matching the presence system in sidebar-view.ts
const CURSOR_COLORS = [
  "#7eb8da", // blue
  "#81c995", // green
  "#f6a6a6", // red
  "#c4a6e8", // purple
  "#f9c77e", // orange
  "#a6d9d9", // teal
];

function hashUserColor(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 6;
}

class CursorWidget extends WidgetType {
  constructor(
    private userId: string,
    private color: string
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const wrapper = document.createElement("span");
    wrapper.className = "kb-collab-cursor";
    wrapper.style.borderLeft = `2px solid ${this.color}`;
    wrapper.style.marginLeft = "-1px";
    wrapper.style.position = "relative";

    const label = document.createElement("span");
    label.className = "kb-collab-cursor-label";
    label.textContent = this.userId;
    label.style.backgroundColor = this.color;
    label.style.color = "#fff";
    label.style.fontSize = "10px";
    label.style.padding = "1px 4px";
    label.style.borderRadius = "3px";
    label.style.position = "absolute";
    label.style.bottom = "100%";
    label.style.left = "-1px";
    label.style.whiteSpace = "nowrap";
    label.style.lineHeight = "1.2";
    label.style.pointerEvents = "none";
    label.style.fontFamily =
      "var(--font-interface), -apple-system, BlinkMacSystemFont, sans-serif";

    wrapper.appendChild(label);
    return wrapper;
  }

  eq(other: CursorWidget): boolean {
    return this.userId === other.userId && this.color === other.color;
  }
}

export type CursorProvider = () => CursorInfo[];

/**
 * Creates a CM6 extension that renders remote cursors.
 * Pass a function that returns the current remote cursor positions.
 */
export function remoteCursorExtension(getCursors: CursorProvider) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private view: EditorView;

      constructor(view: EditorView) {
        this.view = view;
        this.decorations = this.buildDecorations(view);
      }

      update() {
        // Rebuild on every update cycle for instant cursor movement
        this.decorations = this.buildDecorations(this.view);
      }

      buildDecorations(view: EditorView): DecorationSet {
        const cursors = getCursors();
        if (cursors.length === 0) return Decoration.none;

        const widgets: { pos: number; deco: Decoration }[] = [];
        const docLength = view.state.doc.length;

        for (const cursor of cursors) {
          const colorIdx = hashUserColor(cursor.userId);
          const color = CURSOR_COLORS[colorIdx];

          // Clamp positions to document bounds
          const anchor = Math.min(Math.max(0, cursor.anchor), docLength);
          const head = Math.min(Math.max(0, cursor.head), docLength);

          // Cursor widget at head position
          widgets.push({
            pos: head,
            deco: Decoration.widget({
              widget: new CursorWidget(cursor.userId, color),
              side: 1,
            }),
          });

          // Selection highlight if anchor !== head
          if (anchor !== head) {
            const from = Math.min(anchor, head);
            const to = Math.max(anchor, head);
            widgets.push({
              pos: from,
              deco: Decoration.mark({
                attributes: {
                  style: `background-color: ${color}33;`, // 20% opacity
                },
              }).range(from, to) as any,
            });
          }
        }

        // Sort by position for DecorationSet
        const sorted = widgets
          .filter((w) => !("range" in w.deco))
          .sort((a, b) => a.pos - b.pos);

        const builder: any[] = [];

        // Add cursor widgets
        for (const cursor of cursors) {
          const colorIdx = hashUserColor(cursor.userId);
          const color = CURSOR_COLORS[colorIdx];
          const head = Math.min(Math.max(0, cursor.head), docLength);
          const anchor = Math.min(Math.max(0, cursor.anchor), docLength);

          builder.push(
            Decoration.widget({
              widget: new CursorWidget(cursor.userId, color),
              side: 1,
            }).range(head)
          );

          if (anchor !== head) {
            const from = Math.min(anchor, head);
            const to = Math.max(anchor, head);
            builder.push(
              Decoration.mark({
                attributes: {
                  style: `background-color: ${color}33;`,
                },
              }).range(from, to)
            );
          }
        }

        // Sort ranges by from position (required by DecorationSet)
        builder.sort((a: any, b: any) => a.from - b.from || a.startSide - b.startSide);

        try {
          return Decoration.set(builder);
        } catch {
          return Decoration.none;
        }
      }

      destroy() {}
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
