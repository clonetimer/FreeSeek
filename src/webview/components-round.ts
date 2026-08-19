import { ui } from "./state";
import { renderMarkdown, enhanceCodeBlocks } from "./markdown";
import { el, registerNav, hideWelcome, scrollDown, followScroll, addActionBar, avatarLogo, type Round } from "./components-base";
import { ensureReasoning } from "./components-cards";

export function beginRound(messagesEl: HTMLElement): Round {
  const last = messagesEl.lastElementChild as HTMLElement | null;
  if (last && last.classList.contains("msg") && last.classList.contains("assistant") && last.classList.contains("round")) {
    // 复用未收尾的回合（tool / diff 等可能先于文本到达）
    const b = last.querySelector<HTMLElement>(".bubble");
    const streams = b ? Array.from(b.querySelectorAll<HTMLElement>(".stream")) : [];
    const s = streams[streams.length - 1];
    if (b && s) {
      return { wrap: last, bubble: b, stream: s, hasText: streams.some((x) => !!x.textContent) };
    }
  }
  const wrap = el("div", "msg assistant round");
  const header = el("div", "header");
  header.appendChild(avatarLogo());
  header.appendChild(el("span", "name", "FreeSeek"));
  wrap.appendChild(header);
  const bubble = el("div", "bubble");
  const stream = el("div", "stream");
  bubble.appendChild(stream);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  registerNav(wrap, "assistant", "");
  hideWelcome();
  scrollDown(messagesEl);
  return { wrap, bubble, stream, hasText: false };
}

/** 在回合气泡内显示"正在思考"占位（真正流式文本到达前）。 */
export function showRoundThinking(round: Round): void {
  round.stream.classList.add("thinking");
  round.stream.textContent = "正在思考…";
}

/** 清除回合内的"正在思考"占位（真正内容/推理/工具到达前一直显示）。 */
export function clearRoundThinking(round: Round): void {
  round.stream.classList.remove("thinking");
  if (round.stream.textContent === "正在思考…") round.stream.textContent = "";
}

/**
 * 取当前正文块：若气泡末尾仍是 .stream 则复用；否则（末尾是工具/diff 等子块）
 * 新建一个 .stream 追加到末尾，使文本与工具调用按到达顺序交错展示
 * （对齐 Claude Code / Codex / CodeBuddy：文本 → 工具 → 文本 → 工具 → …）。
 */
function ensureCurrentStream(round: Round): HTMLElement {
  const last = round.bubble.lastElementChild as HTMLElement | null;
  if (last && last.classList.contains("stream")) return last;
  const s = document.createElement("div");
  s.className = "stream";
  round.bubble.appendChild(s);
  round.stream = s;
  return s;
}

/** 追加一段流式正文到回合内（首次追加前清除"正在思考"占位）。 */
export function appendRoundText(round: Round, delta: string): void {
  if (!delta) return; // 空分片不处理，避免误清占位或留下空文本
  if (!round.hasText) clearRoundThinking(round);
  const s = ensureCurrentStream(round);
  s.textContent += delta;
  round.hasText = true;
  round.wrap.classList.add("streaming");
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
}

/** 追加思考过程到回合内（默认收起）。有实际推理内容时即视为有进展，清除"正在思考"占位。 */
export function appendRoundReasoning(round: Round, delta: string): void {
  if (delta) clearRoundThinking(round);
  const body = ensureReasoning(round.bubble);
  body.textContent += delta;
  round.wrap.classList.add("streaming");
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
}

/** 收尾回合：把各正文块做 markdown 渲染，加上操作条；正文为空时移除空的 stream 节点。 */
export function finishRound(round: Round): void {
  round.wrap.classList.remove("streaming");
  const streams = Array.from(round.bubble.querySelectorAll<HTMLElement>(".stream"));
  const raw = streams.map((s) => s.textContent || "").join("");
  // "正在思考"占位不是真实正文：收尾时若仍处于占位态，视为无正文
  const isPlaceholder = streams.length === 1 && streams[0].classList.contains("thinking");
  if (isPlaceholder) clearRoundThinking(round);
  // 若正文为空但有推理内容（如 DeepSeek-R1 类推理模型只吐 reasoning 不吐 content），
  // 把推理内容当作可见答复展示，避免出现"空回复 / 只剩思考占位"的假卡死。
  let fallbackReasoning = "";
  if (!isPlaceholder && !raw.trim()) {
    const rb = round.bubble.querySelector(".reasoning-body");
    if (rb && rb.textContent && rb.textContent.trim()) {
      fallbackReasoning = rb.textContent.trim();
      round.bubble.querySelector(".reasoning")?.remove();
    }
  }
  if (!isPlaceholder && (raw.trim() || fallbackReasoning)) {
    const text = fallbackReasoning || raw;
    round.bubble.dataset.raw = text;
    // 每个正文块独立渲染，保持「文本 → 工具 → 文本 → …」的交错位置；空块移除避免空白占位
    if (fallbackReasoning) {
      streams.forEach((s) => s.remove());
      const rt = document.createElement("div");
      rt.className = "round-text";
      rt.innerHTML = renderMarkdown(fallbackReasoning);
      enhanceCodeBlocks(rt);
      round.bubble.appendChild(rt);
    } else {
      for (const s of streams) {
        const content = s.textContent || "";
        if (!content.trim()) {
          s.remove();
          continue;
        }
        s.classList.remove("stream");
        s.classList.add("round-text");
        s.innerHTML = renderMarkdown(content);
        enhanceCodeBlocks(s);
      }
    }
    addActionBar(round.wrap, { copy: text });
  } else {
    // 无真实正文（纯工具/子智能体回合，或仅思考占位）：移除 stream 节点，避免空白占位
    streams.forEach((s) => s.remove());
  }
}

/** 移除回合（用于 ReAct 文本协议剥离后为空的情况）。 */
export function removeRound(round: Round): void {
  round.wrap.remove();
}

/** 在回合气泡内追加一个工具调用/返回子块。name 为工具名，args 为入参（调用时）。 */
export function addToolToRound(round: Round, kind: "call" | "result", name: string, text: string, isHistory = false): HTMLElement {
  clearRoundThinking(round); // 工具调用/返回都是真实进展，立即去掉"正在思考"占位
  const details = document.createElement("details");
  details.className = "tool " + (kind === "call" ? "call" : "result");
  details.open = false; // 默认折叠，减少长对话视觉噪音，用户可手动展开
  const label = kind === "call" ? `🔧 调用工具：${name}` : isHistory ? `↩️ 工具返回（历史）` : `↩️ 工具返回：${name}`;
  details.appendChild(el("summary", "tool-header", label));
  const body = el("div", "tool-body");
  const pre = el("pre", undefined, text || "(无参数/无输出)");
  body.appendChild(pre);
  details.appendChild(body);
  // 工具卡片按到达顺序追加到气泡末尾；后续文本会由 appendRoundText 新建正文块排在工具卡之后，
  // 从而与 Claude Code / Codex / CodeBuddy 一致：文本 → 工具调用 → 文本 → … 交错展示。
  round.bubble.appendChild(details);
  round.bubble.classList.add("has-tools");
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
  return details;
}

/** 在回合气泡内追加文件 diff 子块。 */
export function addDiffToRound(round: Round, info: {
  id?: string; file: string; kind: string; diff: string; added: number; removed: number;
}): void {
  // 复用 addToolToRound 的样式逻辑？不，diff 结构不同，直接内联构建
  const card = el("div", "diff-card");
  if (info.id) card.dataset.editId = info.id;
  const head = el("div", "diff-head");
  const kindLabel: Record<string, string> = { create: "新建", write: "覆写", edit: "编辑" };
  head.appendChild(el("span", "diff-badge", kindLabel[info.kind] || "修改"));
  head.appendChild(el("span", "diff-file", info.file));
  const stat = el("span", "diff-stat");
  stat.innerHTML = `<span class="add">+${info.added}</span> <span class="del">-${info.removed}</span>`;
  head.appendChild(stat);
  head.style.cursor = "pointer";
  head.title = "在编辑器中打开文件";
  head.addEventListener("click", () => ui.post({ type: "open_file", file: info.file, line: 1 }));
  card.appendChild(head);
  const pre = el("pre", "diff-body");
  let newLine = 0;
  const lines = (info.diff || "").split("\n");
  for (const line of lines) {
    if (line.startsWith("@@")) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) newLine = parseInt(m[1], 10);
    }
    const dl = el("span", "diff-line");
    if (line.startsWith("@@")) dl.classList.add("hunk");
    else if (line.startsWith("+")) dl.classList.add("add");
    else if (line.startsWith("-")) dl.classList.add("del");
    else dl.classList.add("ctx");
    if (line.startsWith("+") || line.startsWith(" ")) {
      dl.dataset.line = String(newLine);
      newLine++;
    }
    dl.textContent = (line === "" ? " " : line) + "\n";
    if (dl.dataset.line) {
      dl.style.cursor = "pointer";
      dl.title = "在编辑器中打开第 " + dl.dataset.line + " 行";
      dl.addEventListener("click", () =>
        ui.post({ type: "open_file", file: info.file, line: parseInt(dl.dataset.line as string, 10) })
      );
    }
    pre.appendChild(dl);
  }
  card.appendChild(pre);
  if (info.id) {
    const actions = el("div", "diff-actions");
    const accept = el("button", "act primary", "✓ 接受") as HTMLButtonElement;
    accept.title = "确认保留本次修改";
    accept.addEventListener("click", () => ui.post({ type: "diff_accept", id: info.id }));
    const revert = el("button", "act danger", "↩ 回滚") as HTMLButtonElement;
    revert.title = "撤销本次修改，恢复修改前内容";
    revert.addEventListener("click", () => ui.post({ type: "diff_revert", id: info.id }));
    actions.appendChild(accept);
    actions.appendChild(revert);
    card.appendChild(actions);
  }
  round.bubble.appendChild(card);
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
}
