/** Renderer-side budgets for FreeSeek Desktop U5. These bound mounted UI work, not underlying ACP evidence. */
export const DESKTOP_UI_BUDGETS = Object.freeze({
  conversationWindow: 120,
  trajectoryWindow: 160,
  trajectorySearchDetailChars: 4_000,
  trajectoryDetailPreviewChars: 12_000,
  toolBlockPreviewChars: 12_000,
  artifactDiffPreviewChars: 16_000,
  streamTailChars: 8_000,
});

/** Result of projecting text into a fixed Renderer preview budget. */
export interface BoundedTextPreview {
  text: string;
  truncated: boolean;
  omitted: number;
}

/** Return a UI preview without copying more than the configured character budget. */
export function boundedTextPreview(text: string, cap: number): BoundedTextPreview {
  const safeCap = Math.max(0, Math.floor(cap));
  if (text.length <= safeCap) return { text, truncated: false, omitted: 0 };
  return { text: text.slice(0, safeCap), truncated: true, omitted: text.length - safeCap };
}

/** Compute a stable bounded window. An optional anchor is forced into the returned range. */
export function boundedWindow(total: number, requestedStart: number, size: number, anchor?: number): { start: number; end: number } {
  const safeTotal = Math.max(0, Math.floor(total));
  const safeSize = Math.max(1, Math.floor(size));
  if (!safeTotal) return { start: 0, end: 0 };
  const maxStart = Math.max(0, safeTotal - safeSize);
  let start = Math.min(Math.max(0, Math.floor(requestedStart)), maxStart);
  if (anchor !== undefined && Number.isFinite(anchor)) {
    const safeAnchor = Math.min(Math.max(0, Math.floor(anchor)), safeTotal - 1);
    if (safeAnchor < start) start = safeAnchor;
    else if (safeAnchor >= start + safeSize) start = Math.min(maxStart, safeAnchor - safeSize + 1);
  }
  return { start, end: Math.min(safeTotal, start + safeSize) };
}

/**
 * Serialize unknown projected UI detail without first JSON.stringify-ing an arbitrarily large object.
 * This is intentionally a readable preview, not a canonical persistence format.
 */
export function boundedUnknownText(value: unknown, cap: number): BoundedTextPreview {
  const safeCap = Math.max(0, Math.floor(cap));
  let out = "";
  let truncated = false;
  const seen = new Set<object>();

  const append = (text: string): boolean => {
    if (!text || truncated) return !truncated;
    const remaining = safeCap - out.length;
    if (remaining <= 0) { truncated = true; return false; }
    if (text.length <= remaining) { out += text; return true; }
    out += text.slice(0, remaining); truncated = true; return false;
  };
  const visit = (current: unknown, depth: number): void => {
    if (truncated) return;
    if (current === null) { append("null"); return; }
    if (current === undefined) { append("undefined"); return; }
    if (typeof current === "string") { append(depth === 0 ? current : JSON.stringify(current)); return; }
    if (typeof current === "number" || typeof current === "boolean" || typeof current === "bigint") { append(String(current)); return; }
    if (typeof current === "function") { append(`[Function ${current.name || "anonymous"}]`); return; }
    if (typeof current !== "object") { append(String(current)); return; }
    if (seen.has(current)) { append('"[Circular]"'); return; }
    if (depth > 12) { append('"[Depth capped]"'); return; }
    seen.add(current);
    if (Array.isArray(current)) {
      append("[");
      for (let index = 0; index < current.length && !truncated; index++) {
        if (index) append(", ");
        visit(current[index], depth + 1);
      }
      append("]"); seen.delete(current); return;
    }
    append("{");
    const entries = Object.entries(current as Record<string, unknown>);
    for (let index = 0; index < entries.length && !truncated; index++) {
      if (index) append(", ");
      const [key, child] = entries[index]!;
      append(`${JSON.stringify(key)}: `); visit(child, depth + 1);
    }
    append("}"); seen.delete(current);
  };

  visit(value, 0);
  return { text: out, truncated, omitted: truncated ? 1 : 0 };
}

/** Full detail encoding is deliberately deferred to explicit user expansion. */
export function fullUnknownText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const encoded = JSON.stringify(value, null, 2);
    return encoded === undefined ? String(value) : encoded;
  } catch {
    return String(value);
  }
}

function lastBoundaryBefore(text: string, limit: number): number {
  const bounded = Math.min(text.length, Math.max(0, limit));
  const paragraph = text.lastIndexOf("\n\n", bounded);
  if (paragraph >= 0) return paragraph + 2;
  const newline = text.lastIndexOf("\n", bounded);
  if (newline >= 0) return newline + 1;
  const space = text.lastIndexOf(" ", bounded);
  return space >= 0 ? space + 1 : bounded;
}

/** Exact streamed Markdown fragment plus the minimal fence context needed to render it independently. */
export interface MarkdownStreamFragment {
  /** Exact source characters in this fragment. Synthetic render context is never mixed into this text. */
  text: string;
  startsInFence: boolean;
  fenceLanguage: string;
}

interface MarkdownFenceState { open: boolean; language: string; }

function scanFenceState(text: string, initial: MarkdownFenceState): MarkdownFenceState {
  let state = { ...initial };
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (!fence) continue;
    if (state.open) state = { open: false, language: "" };
    else state = { open: true, language: fence[1] ?? "" };
  }
  return state;
}

/**
 * Streaming Markdown accumulator. Completed source fragments are committed once; only a bounded tail is mutable.
 * Fence context is carried separately so forced cuts inside long code blocks still render as code.
 * Concatenating fragment.text + tail always reproduces every received source character exactly.
 */
export class BoundedMarkdownStream {
  private tail = "";
  private tailStartFence: MarkdownFenceState = { open: false, language: "" };
  constructor(private readonly tailCap: number = DESKTOP_UI_BUDGETS.streamTailChars) {}

  private commitPrefix(cut: number): MarkdownStreamFragment {
    const text = this.tail.slice(0, cut);
    const fragment: MarkdownStreamFragment = { text, startsInFence: this.tailStartFence.open, fenceLanguage: this.tailStartFence.language };
    this.tailStartFence = scanFenceState(text, this.tailStartFence);
    this.tail = this.tail.slice(cut);
    return fragment;
  }

  append(chunk: string): { commits: MarkdownStreamFragment[]; tail: string; tailStartsInFence: boolean; tailFenceLanguage: string } {
    if (chunk) this.tail += chunk;
    const commits: MarkdownStreamFragment[] = [];
    while (this.tail.length > this.tailCap) {
      const overflowTarget = this.tail.length - this.tailCap;
      const cut = Math.max(1, lastBoundaryBefore(this.tail, overflowTarget));
      commits.push(this.commitPrefix(cut));
    }
    const lastParagraph = this.tail.lastIndexOf("\n\n");
    if (lastParagraph >= 0) commits.push(this.commitPrefix(lastParagraph + 2));
    return {
      commits, tail: this.tail, tailStartsInFence: this.tailStartFence.open, tailFenceLanguage: this.tailStartFence.language,
    };
  }

  finish(): { commits: MarkdownStreamFragment[]; tail: string; tailStartsInFence: boolean; tailFenceLanguage: string } {
    const commits = this.tail ? [this.commitPrefix(this.tail.length)] : [];
    const state = this.tailStartFence;
    this.tailStartFence = { open: false, language: "" };
    return { commits, tail: "", tailStartsInFence: state.open, tailFenceLanguage: state.language };
  }

  currentTail(): string { return this.tail; }
}
