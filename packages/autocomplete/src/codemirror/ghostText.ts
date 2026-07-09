/**
 * CodeMirror 6 inline ghost-text completion.
 *
 * Renders the pending LLM suggestion as dimmed inline text at the cursor;
 * Tab accepts, Escape dismisses, any edit or cursor move invalidates. Fetching
 * is debounced and superseded requests are aborted.
 *
 * This intentionally does NOT use @codemirror/autocomplete's dropdown — the
 * kernel/static completion sources keep the dropdown; multi-line LLM
 * suggestions render as ghost text alongside it.
 */
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";

export interface GhostTextContext {
  prefix: string;
  suffix: string;
  state: EditorState;
}

export type GhostTextFetcher = (
  ctx: GhostTextContext,
  opts: { signal: AbortSignal; onChunk: (text: string) => void },
) => Promise<string>;

export interface GhostTextOptions {
  /** Idle time after the last edit before a fetch fires. Default 400 ms. */
  debounceMs?: number;
  /**
   * Skip fetching when the prefix (trimmed) is shorter than this. Default 0:
   * with notebook-level context (other cells) available to the fetcher, even
   * an empty cell is completable — gate in the fetcher, which can see that
   * context, not here. Set >0 only for context-free single-document use.
   */
  minPrefixLength?: number;
  /**
   * When this returns true at fetch time, the fetch is skipped — e.g. while a
   * completion DROPDOWN is open, so the two UIs don't stack and ghost turns
   * aren't burned while the user browses the list. Injected as a predicate so
   * this package needs no dependency on @codemirror/autocomplete.
   */
  holdWhen?: (state: unknown) => boolean; // untyped: avoids dual @codemirror/state identities across workspace boundaries
}

const setGhost = StateEffect.define<{ pos: number; text: string } | null>();

class GhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: GhostWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ghost-text";
    span.style.opacity = "0.45";
    span.style.whiteSpace = "pre-wrap";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
  get lineBreaks(): number {
    return (this.text.match(/\n/g) ?? []).length;
  }
}

const ghostField = StateField.define<{ pos: number; text: string } | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setGhost)) return e.value;
    // Any document change or cursor move invalidates the suggestion.
    if (tr.docChanged || tr.selection) return null;
    return value;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (value): DecorationSet => {
      if (!value || !value.text) return Decoration.none;
      return Decoration.set([
        Decoration.widget({
          widget: new GhostWidget(value.text),
          side: 1,
        }).range(value.pos),
      ]);
    }),
});

export function acceptGhostText(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost || !ghost.text) return false;
  view.dispatch({
    changes: { from: ghost.pos, insert: ghost.text },
    selection: { anchor: ghost.pos + ghost.text.length },
    effects: setGhost.of(null),
    userEvent: "input.complete",
  });
  return true;
}

export function dismissGhostText(view: EditorView): boolean {
  const ghost = view.state.field(ghostField, false);
  if (!ghost) return false;
  view.dispatch({ effects: setGhost.of(null) });
  return true;
}

export function ghostText(fetcher: GhostTextFetcher, options: GhostTextOptions = {}): Extension {
  const debounceMs = options.debounceMs ?? 400;
  const minPrefixLength = options.minPrefixLength ?? 0;

  const plugin = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private controller: AbortController | null = null;
      // In-flight fetches (supersession can briefly overlap two). While > 0 the
      // editor root carries .cm-ai-pending so themes can signal "computing"
      // (e.g. tint the cursor) instead of leaving the wait invisible.
      private inflight = 0;

      constructor(private view: EditorView) {}

      private trackFetch(delta: 1 | -1): void {
        this.inflight += delta;
        this.view.dom.classList.toggle("cm-ai-pending", this.inflight > 0);
      }

      update(update: ViewUpdate): void {
        if (!update.docChanged) return;
        // Any user-driven edit triggers a fetch — typing, paste, delete,
        // undo/redo — EXCEPT accepting a suggestion (that would immediately
        // re-fetch on its own output). The kind of edit doesn't matter: the
        // model can complete from whatever state the edit produced.
        const isUserEdit = update.transactions.some(
          (tr) =>
            (tr.isUserEvent("input") && !tr.isUserEvent("input.complete")) ||
            tr.isUserEvent("delete") ||
            tr.isUserEvent("undo") ||
            tr.isUserEvent("redo") ||
            tr.isUserEvent("move"),
        );
        if (!isUserEdit) return;
        this.schedule();
      }

      private schedule(): void {
        if (this.timer) clearTimeout(this.timer);
        this.controller?.abort();
        this.timer = setTimeout(() => this.fetch(), debounceMs);
      }

      private async fetch(): Promise<void> {
        const { state } = this.view;
        if (!this.view.hasFocus) return;
        if (options.holdWhen?.(state)) return; // e.g. kernel dropdown open
        const pos = state.selection.main.head;
        if (!state.selection.main.empty) return;
        const prefix = state.sliceDoc(0, pos);
        const suffix = state.sliceDoc(pos);
        if (prefix.trim().length < minPrefixLength) return;

        this.controller = new AbortController();
        const { signal } = this.controller;
        const startDoc = state.doc;
        const stale = () => signal.aborted || this.view.state.doc !== startDoc;

        let streamed = "";
        this.trackFetch(1);
        try {
          const full = await fetcher(
            { prefix, suffix, state },
            {
              signal,
              onChunk: (text) => {
                if (stale()) return;
                streamed += text;
                this.view.dispatch({ effects: setGhost.of({ pos, text: streamed }) });
              },
            },
          );
          if (stale()) return;
          if (full) this.view.dispatch({ effects: setGhost.of({ pos, text: full }) });
        } catch {
          /* aborted or backend error — ghost text simply doesn't appear */
        } finally {
          this.trackFetch(-1);
        }
      }

      destroy(): void {
        if (this.timer) clearTimeout(this.timer);
        this.controller?.abort();
        this.inflight = 0;
        this.view.dom.classList.remove("cm-ai-pending");
      }
    },
  );

  return [
    ghostField,
    plugin,
    Prec.highest(
      keymap.of([
        { key: "Tab", run: acceptGhostText },
        { key: "Escape", run: dismissGhostText },
      ]),
    ),
  ];
}
