/**
 * FreeSeek Webview 组件层基础：元素创建 / 滚动 / 导航 / 欢迎页 / 消息卡片 / 回合气泡（Round）。
 * 入口 main.ts 只负责事件接线与消息分发；各类组件渲染分散在各 components-*.ts。
 * 卡片样式类名与 extension.ts getHtml 中的 CSS 一一对应。
 */
import { renderMarkdown, enhanceCodeBlocks, copyText } from "./markdown";

// ── 基础工具 ──

/** 创建元素：el("div", "cls", "文本")。 */
export function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** 创建内联 SVG 图标（class=ic，笔触样式随主题 --ic-* 变量切换）。 */
export function icSvg(path: string): HTMLElement {
  const wrap = document.createElement("span");
  wrap.innerHTML = `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return wrap.firstElementChild as HTMLElement;
}

/** 主题 Logo 图形集：同一图形在不同 data-theme 下显示不同形状（CSS 显隐，欢迎页 / 助手头像共用）。 */
export const LOGO_SVGS = `
  <svg class="ic lg lg-d" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 16.5c2.4-2.2 5-2.2 7.5 0s5 2.2 7.5 0 5-2.2 7.5 0"/><path d="M2.5 20.5c2.4-2.2 5-2.2 7.5 0s5 2.2 7.5 0 5-2.2 7.5 0"/><circle cx="19" cy="6.5" r="2.6"/></svg>
  <svg class="ic lg lg-g" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c3 3 4 6 4 9.5 0 3.5-1 6.5-4 9.5"/><path d="M12 2.5c-3 3-4 6-4 9.5 0 3.5 1 6.5 4 9.5"/><path d="M21.5 12c-3 3-6 4-9.5 4-3.5 0-6.5-1-9.5-4"/><path d="M21.5 12c-3-3-6-4-9.5-4-3.5 0-6.5 1-9.5 4"/></svg>
  <svg class="ic lg lg-w" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l7 16H5z"/><path d="M12 20l7-16H5z"/></svg>
  <svg class="ic lg lg-a" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
  <svg class="ic lg lg-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>`;

/** 主题化助手头像：同一图形集随 data-theme 切换（与欢迎页 Logo 一致）。 */
export function avatarLogo(): HTMLElement {
  const a = el("div", "avatar");
  a.innerHTML = LOGO_SVGS;
  return a;
}

export function setStatus(statusEl: HTMLElement | null, text: string): void {
  if (statusEl) statusEl.textContent = text;
}

export function setStatusHtml(statusEl: HTMLElement | null, html: string): void {
  if (statusEl) statusEl.innerHTML = html;
}

export function scrollDown(messagesEl: HTMLElement): void {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 底部跟随阈值（px）：距容器底部小于该值视为"贴底"，流式追加才自动跟随。 */
export const FOLLOW_BOTTOM_PX = 96;

/** 是否处于"贴底"状态（用户没有上翻阅读旧内容）。 */
export function nearBottom(messagesEl: HTMLElement): boolean {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight <= FOLLOW_BOTTOM_PX;
}

/** 智能跟随：用户贴底时滚到最新；用户上翻阅读旧内容时保持其位置，不强制跳走（对齐 CodeBuddy 等成熟工具）。 */
export function followScroll(messagesEl: HTMLElement): void {
  if (nearBottom(messagesEl)) messagesEl.scrollTop = messagesEl.scrollHeight;
}

/** 对话跳转（书签）导航：每添加一条消息卡片时登记其 DOM 锚点 + 摘要，供"跳转"菜单定位。 */
let navSeq = 0;
let navUserSeq = 0;
const navItems: Array<{ id: string; role: string; label: string }> = [];

/** 重置导航登记（renderConversation / clearMessages 时调用）。 */
export function resetNav(): void {
  navItems.length = 0;
  navSeq = 0;
  navUserSeq = 0;
}

/** 给一个消息卡片登记导航锚点（data-nav-id），并维护摘要列表。 */
export function registerNav(wrap: HTMLElement, role: "user" | "assistant" | "tool" | "other", text: string): void {
  navSeq++;
  const id = "nav-" + navSeq;
  wrap.dataset.navId = id;
  // 右侧导航条只跳转用户问题：仅登记 user 消息的圆点，不显示助手回复。
  if (role !== "user") return;
  navUserSeq++;
  const clean = (text || "").replace(/\s+/g, " ").trim().slice(0, 28);
  navItems.push({ id, role, label: `#${navUserSeq} 👤 ${clean}` });
}

/** 返回当前导航摘要列表（供跳转菜单渲染）。 */
export function getNavItems(): Array<{ id: string; label: string; role: string }> {
  return navItems.map((n) => ({ id: n.id, label: n.label, role: n.role }));
}

/** 跳转到某个导航锚点并高亮闪烁。 */
export function scrollToNav(id: string): void {
  const el = document.querySelector<HTMLElement>(`[data-nav-id="${id}"]`);
  const container = document.getElementById("messages");
  if (!el || !container) return;
  el.scrollIntoView({ behavior: "smooth", block: "start" });
  el.classList.add("nav-flash");
  setTimeout(() => el.classList.remove("nav-flash"), 900);
}

/** 关闭对话跳转下拉菜单。 */
export function closeNavMenu(): void {
  document.getElementById("navMenu")?.classList.remove("open");
}

export function hideWelcome(): void {
  const w = document.getElementById("welcome");
  if (w) w.style.display = "none";
}

const WELCOME_HTML = `
  <div class="welcome-card">
    <div class="welcome-logo">${LOGO_SVGS}</div>
    <h2>FreeSeek</h2>
    <p class="welcome-subtitle">本地优先 Coding Agent · VS Code</p>
    <div class="welcome-tips">
      <span><kbd>Enter</kbd> 发送</span>
      <span><kbd>Shift+Enter</kbd> 换行</span>
      <span>☰ 会话列表</span>
    </div>
    <div class="welcome-suggestions">
      <button class="suggestion" data-text="解释当前项目的结构与技术栈"><span class="sg-icon">✨</span><span class="sg-text">解释当前项目</span></button>
      <button class="suggestion" data-text="检查代码并找出潜在的 bug"><span class="sg-icon">🐛</span><span class="sg-text">找出潜在 bug</span></button>
      <button class="suggestion" data-text="为项目补充单元测试"><span class="sg-icon">🧪</span><span class="sg-text">补充单元测试</span></button>
      <button class="suggestion" data-text="审查当前工作区并给出改进建议"><span class="sg-icon">🔍</span><span class="sg-text">代码审查</span></button>
    </div>
  </div>
`;

export function showWelcome(): void {
  let w = document.getElementById("welcome");
  if (!w) {
    const messagesEl = document.getElementById("messages");
    if (!messagesEl) return;
    w = document.createElement("div");
    w.id = "welcome";
    w.className = "welcome";
    messagesEl.appendChild(w);
  }
  // 若 welcome 容器为空（如 dev harness 已清空静态 fallback），重新填充动态结构
  if (!w.innerHTML.trim()) {
    w.innerHTML = WELCOME_HTML;
  }
  w.style.display = "block";
  w.style.margin = "auto 0"; // 配合 #messages 的 flex 布局保持垂直居中
}

/** 清空消息卡片，保留欢迎页 DOM，避免 newChat / restore 后空白。 */
export function clearMessages(messagesEl: HTMLElement): void {
  messagesEl.querySelectorAll(".msg").forEach((e) => e.remove());
}

// ── 消息级操作条：复制 / 重新编辑（悬停显示）──
export function addActionBar(wrap: HTMLElement, opts: { copy?: string; onEdit?: () => void }): void {
  const bar = el("div", "msg-actions");
  if (opts.copy !== undefined) {
    const c = el("button", "act", "复制") as HTMLButtonElement;
    c.addEventListener("click", () => copyText(opts.copy ?? "", c));
    bar.appendChild(c);
  }
  if (opts.onEdit) {
    const e = el("button", "act", "重新编辑");
    e.addEventListener("click", () => opts.onEdit?.());
    bar.appendChild(e);
  }
  wrap.appendChild(bar);
}

// ── 消息卡片 ──

export function addUserMessage(
  messagesEl: HTMLElement,
  text: string,
  onEdit?: () => void,
  index?: number
): void {
  const wrap = el("div", "msg user");
  if (index !== undefined) wrap.dataset.msgIndex = String(index);
  const displayText = text.trim() || "（图片消息）";
  const bubble = el("div", "bubble", displayText);
  wrap.appendChild(bubble);
  addActionBar(wrap, { copy: text, onEdit });
  messagesEl.appendChild(wrap);
  registerNav(wrap, "user", text);
  hideWelcome();
  scrollDown(messagesEl);
}

/**
 * 原地编辑一条用户消息：把气泡内容替换为 textarea + 「保存/取消」按钮。
 * 保存后调用 onSave(新文本)；取消调用 onCancel()。两者都会先把气泡恢复原状。
 */
export function enterInlineEdit(
  wrap: HTMLElement,
  text: string,
  onSave: (t: string) => void,
  onCancel: () => void
): void {
  const bubble = wrap.querySelector<HTMLElement>(".bubble");
  if (!bubble) return;
  const bb: HTMLElement = bubble;
  const bar = wrap.querySelector<HTMLElement>(".action-bar");
  const prevHtml = bb.innerHTML;
  bb.innerHTML = "";
  bb.classList.add("editing");
  const ta = document.createElement("textarea");
  ta.className = "edit-ta";
  ta.value = text;
  ta.spellcheck = false;
  bb.appendChild(ta);
  const btnRow = el("div", "edit-btns");
  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "primary";
  saveBtn.textContent = "保存并重新发送";
  saveBtn.addEventListener("click", () => {
    const val = ta.value.trim();
    if (!val) return;
    restore();
    onSave(val);
  });
  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.textContent = "取消";
  cancelBtn.addEventListener("click", () => {
    restore();
    onCancel();
  });
  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  bb.appendChild(btnRow);
  if (bar) bar.style.display = "none";
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);

  function restore(): void {
    bb.classList.remove("editing");
    bb.innerHTML = prevHtml;
    if (bar) bar.style.display = "";
  }
}

/** 开始一条助手消息，返回其气泡元素（供流式追加文本）。 */
export function beginAssistant(messagesEl: HTMLElement): HTMLElement {
  const wrap = el("div", "msg assistant");
  const header = el("div", "header");
  const avatar = avatarLogo();
  header.appendChild(avatar);
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
  return bubble;
}

/** 结束一条助手消息：markdown 渲染 + 代码块美化 + 操作条。 */
export function finishAssistant(bubble: HTMLElement, wrap: HTMLElement | null): void {
  const stream = bubble.querySelector(".stream");
  const raw = (stream ? stream.textContent : bubble.textContent) || "";
  bubble.classList.remove("streaming");
  bubble.dataset.raw = raw;
  bubble.innerHTML = renderMarkdown(raw);
  enhanceCodeBlocks(bubble);
  if (wrap) addActionBar(wrap, { copy: raw });
}

// ── 单回合气泡（Round）：把文本 + 工具 + diff + 任务清单 + 子智能体都归入同一个 assistant 气泡，
//    对齐 Codex / Claude Code / CodeBuddy —— 一段回复只出现一个气泡，内部用子块分隔。 ──

export interface Round {
  /** 外层 .msg.assistant 包裹元素 */
  wrap: HTMLElement;
  /** .bubble 内容容器（stream / tool / diff / todos 都追加到这里） */
  bubble: HTMLElement;
  /** 当前流式正文块（工具卡插入后可能切换为新块，见 components-round.ts ensureCurrentStream） */
  stream: HTMLElement;
  /** 是否已有任何流式正文（决定 finishRound 时是否渲染 markdown 正文） */
  hasText: boolean;
}
