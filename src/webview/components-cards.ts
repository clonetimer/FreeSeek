import { ui } from "./state";
import { stripTags, renderMarkdown, enhanceCodeBlocks } from "./markdown";
import {
  el,
  beginAssistant,
  finishAssistant,
  registerNav,
  addActionBar,
  addUserMessage,
  clearMessages,
  resetNav,
  hideWelcome,
  showWelcome,
  scrollDown,
  followScroll,
  avatarLogo,
  type Round,
} from "./components-base";

export function addAssistantMessage(messagesEl: HTMLElement, text: string): void {
  if (!text) return;
  const bubble = beginAssistant(messagesEl);
  const stream = bubble.querySelector(".stream");
  if (stream) stream.textContent = text;
  finishAssistant(bubble, bubble.closest(".msg.assistant") as HTMLElement | null);
  registerNav(bubble.closest(".msg.assistant") as HTMLElement, "assistant", text);
}

/** 思考过程（reasoning）折叠块：默认收起，可展开查看。始终置于气泡最前（工具/正文之前）。 */
export function ensureReasoning(bubble: HTMLElement): HTMLElement {
  let body = bubble.querySelector(".reasoning-body") as HTMLElement | null;
  if (!body) {
    const det = document.createElement("details");
    det.className = "reasoning";
    det.open = false;
    const sum = el("summary", undefined, "💭 思考过程");
    det.appendChild(sum);
    body = el("div", "reasoning-body");
    det.appendChild(body);
    bubble.insertBefore(det, bubble.firstChild);
  }
  return body;
}

export function addToolCallCard(messagesEl: HTMLElement, name: string, args: string): void {
  const wrap = el("div", "msg assistant");
  const details = document.createElement("details");
  details.className = "tool call";
  details.open = true;
  const header = el("summary", "tool-header", `🔧 调用工具：${name}`);
  details.appendChild(header);
  const body = el("div", "tool-body");
  const pre = el("pre", undefined, args || "(无参数)");
  body.appendChild(pre);
  details.appendChild(body);
  wrap.appendChild(details);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
}

export function addToolResultCard(messagesEl: HTMLElement, text: string, isHistory = false): void {
  const wrap = el("div", "msg assistant");
  const details = document.createElement("details");
  details.className = "tool result";
  details.open = false;
  const header = el("summary", "tool-header", isHistory ? "↩️ 工具返回（历史）" : "↩️ 工具返回");
  details.appendChild(header);
  const body = el("div", "tool-body");
  const pre = el("pre", undefined, text || "(空)");
  body.appendChild(pre);
  details.appendChild(body);
  wrap.appendChild(details);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
}

// ── 文件修改痕迹（diff）卡片：红绿对照 + 接受 / 回滚（对标 Codex 对话内 diff）──
export function createDiffCard(
  messagesEl: HTMLElement,
  info: { id?: string; file: string; kind: string; diff: string; added: number; removed: number }
): void {
  const wrap = el("div", "msg diffcard");
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
    // 计算新文件行号，供点击跳转到编辑器（仅 + 与上下文行能定位）
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
  wrap.appendChild(card);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
}

/** 更新 diff 卡状态（accepted / reverted / failed / gone）。 */
export function setDiffState(id: string, state: string, note?: string): void {
  const cards = document.querySelectorAll<HTMLElement>(".diff-card[data-edit-id]");
  let card: HTMLElement | null = null;
  for (let i = 0; i < cards.length; i++) {
    if (cards[i].dataset.editId === id) {
      card = cards[i];
      break;
    }
  }
  if (!card) return;
  card.querySelector(".diff-actions")?.remove();
  card.querySelector(".diff-state")?.remove();
  const b = el("div", "diff-state " + state);
  if (state === "accepted") b.textContent = "✓ 已接受";
  else if (state === "reverted") b.textContent = "↩ 已回滚" + (note ? `（${note}）` : "");
  else if (state === "failed") b.textContent = "⚠ " + (note || "操作失败");
  else b.textContent = note || state;
  card.appendChild(b);
}

// ── 任务清单卡片 ──
export function renderTodos(messagesEl: HTMLElement, items: unknown[]): void {
  if (ui.todoCard) {
    ui.todoCard.remove();
    ui.todoCard = null;
  }
  if (!items || !items.length) return;
  const wrap = el("div", "msg assistant todos");
  const header = el("div", "header");
  const avatar = el("div", "avatar", "✅");
  header.appendChild(avatar);
  header.appendChild(el("span", "name", "任务清单"));
  wrap.appendChild(header);
  const bubble = el("div", "bubble");
  const ul = el("ul", "todolist") as HTMLUListElement;
  for (const it of items as Array<{ content?: string; status?: string }>) {
    const li = el("li", it.status || "pending");
    const mark = it.status === "completed" ? "☑" : it.status === "in_progress" ? "🔄" : "☐";
    li.textContent = `${mark} ${it.content || ""}`;
    ul.appendChild(li);
  }
  bubble.appendChild(ul);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  ui.todoCard = wrap;
  followScroll(messagesEl);
}

// ── 子智能体折叠块 ──
export function beginSubAgent(messagesEl: HTMLElement, name: string, task: string): HTMLElement {
  const wrap = el("div", "msg assistant subagent");
  const det = document.createElement("details");
  det.className = "tool subagent";
  det.open = true;
  const sum = el("summary", undefined, `🧩 子智能体：${name} — ${task || "（无任务描述）"}`);
  det.appendChild(sum);
  const log = el("div", "sublog");
  det.appendChild(log);
  wrap.appendChild(det);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
  return log;
}

export function appendSubLine(log: HTMLElement, text: string): void {
  const line = el("div", "subline", text);
  log.appendChild(line);
  const messagesEl = log.closest("#messages") as HTMLElement | null;
  if (messagesEl) followScroll(messagesEl);
}

// ── 通知 / 错误气泡 ──
export function addNotification(messagesEl: HTMLElement, title: string, body: string): void {
  const wrap = el("div", "msg assistant");
  const header = el("div", "header");
  const avatar = el("div", "avatar", "🔔");
  header.appendChild(avatar);
  header.appendChild(el("span", "name", title));
  wrap.appendChild(header);
  const bubble = el("div", "bubble", body || undefined);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
}

export function addErrorCard(messagesEl: HTMLElement, message: string): void {
  const wrap = el("div", "msg assistant error");
  const bubble = el("div", "bubble", "⚠️ " + message);
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollDown(messagesEl);
}

export interface SkillDistillPayload {
  name: string;
  filePath: string;
  description: string;
  status: "pending";
}

/**
 * 渲染「新技能待审核」提示卡片，带一键打开技能管理的入口。
 */
export function addSkillDistillCard(
  messagesEl: HTMLElement,
  skill: SkillDistillPayload,
  onReview: () => void
): void {
  const wrap = el("div", "msg assistant skill-distill");
  const header = el("div", "header");
  header.appendChild(el("div", "avatar", "🧪"));
  header.appendChild(el("span", "name", "新技能待审核"));
  wrap.appendChild(header);

  const bubble = el("div", "bubble");
  const title = el("div", "sd-title", skill.name);
  bubble.appendChild(title);
  if (skill.description) {
    bubble.appendChild(el("div", "sd-desc", skill.description));
  }
  const path = el("div", "sd-path", skill.filePath);
  path.title = skill.filePath;
  bubble.appendChild(path);

  const actions = el("div", "sd-actions");
  const reviewBtn = el("button", "sd-btn primary", "打开技能管理") as HTMLButtonElement;
  reviewBtn.onclick = () => {
    reviewBtn.disabled = true;
    reviewBtn.textContent = "已打开";
    onReview();
  };
  actions.appendChild(reviewBtn);
  bubble.appendChild(actions);

  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  followScroll(messagesEl);
}

// ── 历史恢复：清空并整体重绘对话 ──
export function renderConversation(
  messagesEl: HTMLElement,
  messages: unknown[],
  onEditUser?: (index: number, t: string) => void
): void {
  clearMessages(messagesEl);
  resetNav();
  const merged = mergeAdjacentRoleMessages(messages);
  let hasAny = false;
  for (let i = 0; i < merged.length; i++) {
    const m = merged[i];
    if (!m || typeof m.content !== "string") continue;
    if (m.role === "system") continue;
    hasAny = true;
    if (m.role === "user") {
      const content = m.content;
      addUserMessage(
        messagesEl,
        content,
        onEditUser ? () => onEditUser(i, content) : undefined,
        i
      );
    } else if (m.role === "assistant") {
      const wrap = el("div", "msg assistant");
      const header = el("div", "header");
      header.appendChild(avatarLogo());
      header.appendChild(el("span", "name", "FreeSeek"));
      wrap.appendChild(header);
      const bubble = el("div", "bubble");
      const text = stripTags(m.content);
      if (text) {
        bubble.dataset.raw = text;
        bubble.innerHTML = renderMarkdown(text);
        enhanceCodeBlocks(bubble);
      }
      if (m.reasoning_content) {
        ensureReasoning(bubble).textContent = m.reasoning_content;
      }
      if (text) addActionBar(wrap, { copy: text });
      wrap.appendChild(bubble);
      messagesEl.appendChild(wrap);
      registerNav(wrap, "assistant", text || "");
    } else if (m.role === "tool") {
      addToolResultCard(messagesEl, stripTags(m.content), true);
    }
  }
  if (hasAny) hideWelcome();
  else showWelcome();
  scrollDown(messagesEl);
}

/**
 * 合并相邻同角色消息，避免 restore 后同一 assistant 出现多个重复头像，
 * 也让连续用户消息看起来更连贯。
 */
function mergeAdjacentRoleMessages(
  messages: unknown[]
): Array<{ role?: string; content: string; reasoning_content?: string }> {
  const out: Array<{ role?: string; content: string; reasoning_content?: string }> = [];
  const arr = messages as Array<{
    role?: string;
    content?: string;
    reasoning_content?: string;
  }>;
  for (const m of arr) {
    if (!m || typeof m.content !== "string") continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content += last.content ? "\n\n" + m.content : m.content;
      if (m.reasoning_content) {
        last.reasoning_content = (last.reasoning_content || "") + m.reasoning_content;
      }
    } else {
      out.push({
        role: m.role,
        content: m.content,
        reasoning_content: m.reasoning_content,
      });
    }
  }
  return out;
}

/** 在回合气泡内渲染 run_python 生成的图表（matplotlib 等 PNG 的 base64）。 */
export function addPythonChartsToRound(round: Round, charts: unknown[]): void {
  const list = (charts || []) as Array<{ dataUrl?: string; caption?: string }>;
  if (!list.length) return;
  const wrap = el("div", "py-charts");
  wrap.appendChild(el("div", "py-charts-head", "📊 Python 生成的图表"));
  for (const c of list) {
    const fig = el("figure", "py-chart");
    const img = document.createElement("img");
    img.src = c.dataUrl || "";
    img.alt = c.caption || "chart";
    img.className = "py-chart-img";
    fig.appendChild(img);
    if (c.caption) fig.appendChild(el("figcaption", "py-chart-cap", c.caption));
    wrap.appendChild(fig);
  }
  round.bubble.appendChild(wrap);
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
}
