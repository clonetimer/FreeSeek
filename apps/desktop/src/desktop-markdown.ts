import { BoundedMarkdownStream, type MarkdownStreamFragment } from "./ui-performance";

function appendInline(target: HTMLElement, text: string): void {
  const token = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let cursor = 0;
  for (const match of text.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) target.append(document.createTextNode(text.slice(cursor, index)));
    const raw = match[0];
    if (raw.startsWith("**")) { const strong = document.createElement("strong"); strong.textContent = raw.slice(2, -2); target.append(strong); }
    else if (raw.startsWith("`")) { const code = document.createElement("code"); code.textContent = raw.slice(1, -1); target.append(code); }
    else { const em = document.createElement("em"); em.textContent = raw.slice(1, -1); target.append(em); }
    cursor = index + raw.length;
  }
  if (cursor < text.length) target.append(document.createTextNode(text.slice(cursor)));
}

/** Append a dependency-free, HTML-safe Markdown subset. Raw HTML is always rendered as text. */
export function appendDesktopMarkdown(target: HTMLElement, source: string): void {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let code: HTMLPreElement | null = null;
  let codeBody: HTMLElement | null = null;
  let list: HTMLUListElement | HTMLOListElement | null = null;
  let listOrdered = false;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const p = document.createElement("p"); appendInline(p, paragraph.join(" ").trim()); target.append(p); paragraph = [];
  };
  const closeList = () => { list = null; };

  for (const line of lines) {
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      flushParagraph(); closeList();
      if (!code) {
        code = document.createElement("pre"); code.className = "md-code";
        codeBody = document.createElement("code"); if (fence[1]) codeBody.dataset.language = fence[1]; code.append(codeBody); target.append(code);
      } else { code = null; codeBody = null; }
      continue;
    }
    if (codeBody) { codeBody.append(document.createTextNode(`${line}\n`)); continue; }
    if (!line.trim()) { flushParagraph(); closeList(); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph(); closeList(); const node = document.createElement(`h${heading[1]!.length}`); appendInline(node, heading[2]!); target.append(node); continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) { flushParagraph(); closeList(); const node = document.createElement("blockquote"); appendInline(node, quote[1]!); target.append(node); continue; }
    const unordered = /^\s*[-*+]\s+(.+)$/.exec(line);
    const ordered = /^\s*\d+[.)]\s+(.+)$/.exec(line);
    if (unordered || ordered) {
      flushParagraph(); const orderedNow = Boolean(ordered);
      if (!list || listOrdered !== orderedNow) { list = document.createElement(orderedNow ? "ol" : "ul"); listOrdered = orderedNow; target.append(list); }
      const item = document.createElement("li"); appendInline(item, (ordered?.[1] ?? unordered?.[1])!); list.append(item); continue;
    }
    if (/^\s*(?:---+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); closeList(); target.append(document.createElement("hr")); continue; }
    closeList(); paragraph.push(line);
  }
  flushParagraph();
}

function appendStreamFragment(target: HTMLElement, fragment: MarkdownStreamFragment): void {
  const prefix = fragment.startsInFence ? `\`\`\`${fragment.fenceLanguage}\n` : "";
  appendDesktopMarkdown(target, prefix + fragment.text);
}

/** Incremental assistant renderer: stable Markdown blocks render once; only the bounded tail is replaced. */
export class IncrementalMarkdownRenderer {
  private readonly stream: BoundedMarkdownStream;
  private readonly stable: HTMLElement;
  private readonly tail: HTMLElement;
  private queued = "";
  private frame: number | null = null;
  private finished = false;

  constructor(private readonly host: HTMLElement) {
    this.stream = new BoundedMarkdownStream();
    this.stable = document.createElement("div"); this.stable.className = "markdown-stable";
    this.tail = document.createElement("div"); this.tail.className = "markdown-stream-tail"; this.tail.setAttribute("aria-live", "off");
    host.replaceChildren(this.stable, this.tail);
  }

  append(chunk: string): void {
    if (!chunk || this.finished) return;
    this.queued += chunk;
    if (this.frame === null) this.frame = window.requestAnimationFrame(() => { this.frame = null; this.flushQueued(); });
  }

  flushQueued(): void {
    if (!this.queued || this.finished) return;
    const chunk = this.queued; this.queued = "";
    const next = this.stream.append(chunk);
    for (const committed of next.commits) appendStreamFragment(this.stable, committed);
    this.tail.textContent = next.tail;
  }

  finish(): void {
    if (this.finished) return;
    if (this.frame !== null) { window.cancelAnimationFrame(this.frame); this.frame = null; }
    this.flushQueued();
    const final = this.stream.finish();
    for (const committed of final.commits) appendStreamFragment(this.stable, committed);
    this.tail.remove(); this.finished = true;
  }
}

/** Plain-text stream used for reasoning; batches chunks per animation frame and never rewrites prior text. */
export class IncrementalTextRenderer {
  private queued = "";
  private frame: number | null = null;
  private finished = false;
  constructor(private readonly host: HTMLElement) { host.textContent = ""; }
  append(chunk: string): void {
    if (!chunk || this.finished) return;
    this.queued += chunk;
    if (this.frame === null) this.frame = window.requestAnimationFrame(() => { this.frame = null; this.flushQueued(); });
  }
  flushQueued(): void { if (this.queued) { this.host.append(document.createTextNode(this.queued)); this.queued = ""; } }
  finish(): void { if (this.frame !== null) { window.cancelAnimationFrame(this.frame); this.frame = null; } this.flushQueued(); this.finished = true; }
}
