// check:max-lines 1450 (待拆 providerUI / handleUser / 消息分发大 switch；v0.17.11 已拆自动补全至 autocomplete.ts，1520→1416，后加侧边栏工具/Hookify/顶部工具下拉绑定；剩余行主要是核心事件接线与消息分发 switch)
/**
 * FreeSeek — Webview 前端入口（esbuild iife bundle）。
 * 只负责 DOM 引用、事件接线与扩展消息分发；渲染逻辑在 components.ts / markdown.ts。
 */
import { ui, setPost, applyTheme, registerPluginThemes } from "./state";
import * as C from "./components";
import { stripTags } from "./markdown";
import { createBridge } from "./bridge";
import { initAutocomplete, showFileAutocomplete, SLASH_COMMANDS } from "./autocomplete";

// 单例宿主桥：真实 VS Code 用 acquireVsCodeApi；浏览器 dev harness 用 mock
const bridge = createBridge();
setPost((m) => bridge.postMessage(m));

// ── DOM 引用 ──
const messagesEl = document.getElementById("messages") as HTMLDivElement;
const inputEl = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send-inn") as HTMLButtonElement;
const newChatBtn = document.getElementById("newChat") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLDivElement;
const modelChip = document.getElementById("modelChip") as HTMLButtonElement;
const modePlanBtn = document.getElementById("modePlanBtn") as HTMLButtonElement;
const modeAskBtn = document.getElementById("modeAskBtn") as HTMLButtonElement;
const modeCraftBtn = document.getElementById("modeCraftBtn") as HTMLButtonElement;
const modeCoderBtn = document.getElementById("modeCoderBtn") as HTMLButtonElement;
const jumpBottomBtn = document.getElementById("jumpBottom") as HTMLButtonElement;
const sandboxChip = document.getElementById("sandboxChip") as HTMLSpanElement;
const sessionSearchEl = document.getElementById("sessionSearch") as HTMLInputElement;
const sessionTitleEl = document.getElementById("sessionTitle") as HTMLSpanElement;
const sessionDropdownEl = document.getElementById("sessionDropdown") as HTMLDivElement;
const sessionDropdownBtn = document.getElementById("sessionDropdownBtn") as HTMLButtonElement;
const sessionDropdownMenu = document.getElementById("sessionDropdownMenu") as HTMLDivElement;
const sbToggleOpenBtn = document.getElementById("sbToggleOpen") as HTMLButtonElement;
const sbToggleBtn = document.getElementById("sbToggle") as HTMLButtonElement;
const sidebarBackdropEl = document.getElementById("sidebar-backdrop") as HTMLElement;
const newChatSbBtn = document.getElementById("newChatSb") as HTMLButtonElement;
const importSbBtn = document.getElementById("importSb") as HTMLButtonElement | null;
const archiveBtn = document.getElementById("archiveBtn") as HTMLButtonElement | null;
const archivedWrap = document.getElementById("archivedWrap") as HTMLDivElement | null;
const sessionListEl = document.getElementById("sessionList") as HTMLDivElement | null;
const schedulesSbBtn = document.getElementById("schedulesSb") as HTMLButtonElement | null;
const hookifySbBtn = document.getElementById("hookifySb") as HTMLButtonElement | null;
const installKitSbBtn = document.getElementById("installKitSb") as HTMLButtonElement | null;
const manageKitsSbBtn = document.getElementById("manageKitsSb") as HTMLButtonElement | null;
const freeServerSbBtn = document.getElementById("freeServerSb") as HTMLButtonElement | null;
const editProvidersSbBtn = document.getElementById("editProvidersSb") as HTMLButtonElement | null;
const sessionLogSbBtn = document.getElementById("sessionLogSb") as HTMLButtonElement | null;
const backToSessionsBtn = document.getElementById("backToSessions") as HTMLButtonElement | null;
const forkBtn = document.getElementById("forkBtn") as HTMLButtonElement;
const cmdBtn = document.getElementById("cmdBtn") as HTMLButtonElement;
const renameBtn = document.getElementById("renameBtn") as HTMLButtonElement;
const modelLabelEl = document.getElementById("modelLabel") as HTMLSpanElement;
const sandboxLabelEl = document.getElementById("sandboxLabel") as HTMLSpanElement;
const addCtxBtn = document.getElementById("addCtx") as HTMLButtonElement;
const attachImgBtn = document.getElementById("attachImg") as HTMLButtonElement;
const imgInput = document.getElementById("imgInput") as HTMLInputElement;
const ctxChipsEl = document.getElementById("ctxChips") as HTMLDivElement;
const quoteToChatBtn = document.getElementById("quoteToChat") as HTMLButtonElement;
const settingsBtn = document.getElementById("settingsBtn") as HTMLButtonElement;
const exportBtn = document.getElementById("exportBtn") as HTMLButtonElement;
const toolsBtn = document.getElementById("toolsBtn") as HTMLButtonElement | null;
const toolsMenuEl = document.getElementById("toolsMenu") as HTMLElement | null;
const ctxLabelEl = document.getElementById("ctxLabel") as HTMLSpanElement;
// 对话跳转导航：右侧竖条
const navRailInner = document.getElementById("navRailInner") as HTMLElement | null;
const navBadge = document.getElementById("navBadge") as HTMLElement | null;
const navTip = document.getElementById("navTip") as HTMLElement | null;
/** 最近一次从扩展下发的设置项（设置面板初始化用）。 */
let uiSettings: any = {};
/** 流式看门狗默认等待时间：模型普通生成 120s 无进展视为超时（推理模型 thinking 阶段可能慢）。 */
const BASE_WATCHDOG_MS = 120_000;
/** 工具执行期间看门狗时间：长命令 / 用户暂时离开期间放宽到 10 分钟。 */
const TOOL_WATCHDOG_MS = 10 * 60 * 1_000;
// 缓存的 MCP server 列表（管理面板渲染用）
let uiMcpServers: any[] = [];

// ── 会话流式状态 ──
let streaming = false;
let currentText: HTMLElement | null = null;
let currentAssistantWrap: HTMLElement | null = null;
/** 当前回合气泡（合并气泡：文本/工具/diff/任务清单/子智能体都在同一气泡内）。 */
let currentRound: C.Round | null = null;
/**
 * 流式看门狗：若发送后 90s 内仍未收到任何 assistant_delta / reasoning_delta / tool / done / error
 * （说明后端真的卡住），主动结束回合、恢复发送按钮、提示用户「请求超时」，避免 UI 永远停在「正在思考」。
 * 收到任意一条进展消息则重置计时（本地慢模型生成期间也会不断刷新），done/error/stopped 才真正清空。
 */
let streamWatchdog: number | null = null;
// 待发送的文件/选区上下文（点击「上下文」按钮或 @ 提及累积，发送时拼入用户消息）
let pendingContexts: Array<{
  file: string;
  language: string;
  selection?: { text: string; start: number; end: number };
  /** @ 提及文件时附带的内容（已读取，发送时直接注入） */
  content?: string;
  /** 内容是否被截断（超大文件只附前 300 行） */
  truncated?: boolean;
}> = [];
// 待发送的图片（base64 data URL），发送时作为 user 消息的 images 附带（需支持视觉的模型）
let pendingImages: Array<{ url: string; name: string }> = [];
// 待引用的历史回复（选中消息文字 → 添加到对话，对齐 Codex「引用历史回复」）
let pendingQuotes: Array<{ seq: number; role: "user" | "assistant"; text: string }> = [];
// 等待队列（对齐 CodeBuddy「对话执行时把新输入加入等待序列」）：Agent 回复中用户输入的文本暂存于此，
// 不立即发送、不丢，本轮结束（后端 queue_state pending=0）后自动作为下一条消息发送。
let pendingUserQueue: string[] = [];

/** 启动流式看门狗：若 timeoutMs 内未收到任何进展，则主动结束并提示用户。 */
function startStreamWatchdog(timeoutMs = BASE_WATCHDOG_MS) {
  clearStreamWatchdog();
  streamWatchdog = window.setTimeout(() => {
    streamWatchdog = null;
    if (!streaming) return;
    // 后端真的卡住了：主动结束回合，恢复 UI
    finishAssistant();
    setStreaming(false);
    C.setStatus(statusEl, "请求超时：未收到模型回复。请检查网络/API Key，或重试。");
    C.addErrorCard(
      messagesEl,
      `请求超时（${Math.round(timeoutMs / 1000)}s 内未收到模型回复）。请检查网络/API Key/服务状态后重试。`
    );
    playDoneSound();
  }, timeoutMs);
}
/** 重置看门狗计时：收到任意进展（delta/tool）时调用，让仍在正常生成的回合不会误超时。 */
function resetStreamWatchdog() {
  if (!streaming) return;
  startStreamWatchdog();
}
/** 清空流式看门狗（收到 done/error/stopped、停止或新建对话时调用）。 */
function clearStreamWatchdog() {
  if (streamWatchdog != null) {
    clearTimeout(streamWatchdog);
    streamWatchdog = null;
  }
}

/** 移除所有 ask_user 提问弹窗（回合结束 / 恢复 / 新建会话时调用）。 */
function removeAllAskCards() {
  document.querySelectorAll('[id^="askOverlay-"]').forEach((e) => e.remove());
}

function setStreaming(on: boolean) {
  streaming = on;
  // 对齐 CodeBuddy「等待队列」：运行时不再禁用输入框，而是允许继续输入（入队），
  // 仅把占位符切换为排队提示，并用角标显示排队数量。
  if (on) {
    inputEl.placeholder = "回复进行中，可继续输入以加入等待队列…";
    sendBtn.disabled = false;
    sendBtn.classList.add("running");
    sendBtn.title = "停止生成";
    sendBtn.innerHTML = '<svg class="ic stop-ic" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
  } else {
    inputEl.placeholder = "输入消息，Enter 发送，Shift+Enter 换行";
    sendBtn.disabled = false;
    sendBtn.classList.remove("running");
    sendBtn.title = "发送";
    sendBtn.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
    inputEl.style.height = "auto";
    autoResize();
  }
  renderQueueBadge();
}

/** 渲染等待队列角标（输入框旁显示 ×N，提示已有 N 条输入在排队）。 */
function renderQueueBadge() {
  let badge = document.getElementById("queueBadge") as HTMLElement | null;
  const n = pendingUserQueue.length;
  if (n <= 0) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("span");
    badge.id = "queueBadge";
    badge.className = "queue-badge";
    // 放在输入框容器右下角（发送按钮左侧）
    const wrap = inputEl.parentElement;
    if (wrap) wrap.insertBefore(badge, sendBtn);
  }
  badge.textContent = `等待队列 ×${n}`;
  badge.title = "已有输入加入等待队列，当前回复结束后自动发送。";
}

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 220) + "px";
}

/** 把历史用户消息载入输入框，便于「重新编辑」后重发（仅用于新发送消息的操作条）。 */
function editInput(text: string) {
  inputEl.value = text;
  autoResize();
  inputEl.focus();
  C.setStatus(statusEl, "已载入历史消息到输入框，编辑后按 Enter 重发。");
}

/** 最近一次 restore 的消息快照（供「原位置编辑」取消时恢复渲染）。 */
let lastRestoredMessages: unknown[] = [];

/** 历史用户消息「重新编辑」：点击后在原气泡内联编辑（对标 Claude Code / CodeBuddy）。 */
function onEditUserCb(index: number, text: string): void {
  if (streaming) {
    C.setStatus(statusEl, "运行中不能编辑，请先停止当前回复。");
    return;
  }
  const wrap = messagesEl.querySelector<HTMLElement>(`.msg.user[data-msg-index="${index}"]`);
  if (!wrap) return;
  C.enterInlineEdit(
    wrap,
    text,
    (newText) => {
      // 后端截断该消息之后的回复并重发；重发后前端会收到 restore(editing) 重绘并接续流式
      ui.post({ type: "edit_user_message", index, text: newText });
      C.setStatus(statusEl, "已重新发送…");
    },
    () => {
      C.renderConversation(messagesEl, lastRestoredMessages, onEditUserCb);
      C.setStatus(statusEl, "已取消编辑。");
      renderNavRail();
    }
  );
}

// ── 提示音（Web Audio API 合成，无需音频资源；受设置面板 soundStart / soundDone 控制）──
let audioCtx: AudioContext | null = null;
function ensureAudioCtx(): AudioContext | null {
  try {
    if (!audioCtx) {
      const AC = window.AudioContext || (window as any).webkitAudioContext;
      if (!AC) return null;
      audioCtx = new AC();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}
function tone(
  ac: AudioContext,
  freq: number,
  start: number,
  dur: number,
  type: OscillatorType,
  vol: number,
  endFreq?: number
) {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  if (endFreq && endFreq !== freq) {
    osc.frequency.exponentialRampToValueAtTime(endFreq, ac.currentTime + start + dur);
  }
  gain.gain.setValueAtTime(0, ac.currentTime + start);
  gain.gain.linearRampToValueAtTime(vol, ac.currentTime + start + 0.015);
  gain.gain.setValueAtTime(vol, ac.currentTime + start + dur - 0.05);
  gain.gain.linearRampToValueAtTime(0, ac.currentTime + start + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.05);
}
/** 会话开始/进行中提示音：两声短促上扬。 */
function playStartSound(): void {
  if (!uiSettings?.soundStart) return;
  const ac = ensureAudioCtx();
  if (!ac) return;
  tone(ac, 740, 0, 0.09, "triangle", 0.15, 988);
  tone(ac, 988, 0.1, 0.12, "triangle", 0.15, 740);
}
/** 会话完成提示音：上行三连音（C-E-G）。 */
function playDoneSound(): void {
  if (!uiSettings?.soundDone) return;
  const ac = ensureAudioCtx();
  if (!ac) return;
  tone(ac, 523.25, 0, 0.1, "sine", 0.18);
  tone(ac, 659.25, 0.1, 0.1, "sine", 0.18);
  tone(ac, 783.99, 0.2, 0.18, "sine", 0.2);
}

/** 发送一条用户消息（prefill 供欢迎页快捷建议使用）。 */
async function send(prefill?: string) {
  let text = (prefill ?? inputEl.value).trim();
  if (!text) return;
  // 对齐 CodeBuddy「等待队列」：Agent 回复中继续输入，不丢、不立即发送，入队等待本轮结束自动发送。
  if (streaming) {
    pendingUserQueue.push(text);
    inputEl.value = "";
    inputEl.style.height = "auto";
    autoResize();
    renderQueueBadge();
    C.setStatus(statusEl, `已加入等待队列（${pendingUserQueue.length} 条），当前回复结束后自动发送。`);
    return;
  }
  // 内置 slash 命令：整条恰好为命令名时展开为预设提示词或执行动作
  if (text === "/clear") {
    ui.post({ type: "newChat" });
    inputEl.value = "";
    inputEl.style.height = "auto";
    return;
  }
  // /compact：触发引擎侧分层压缩（非截断），并在压缩前抽取持久记忆
  if (text === "/compact") {
    ui.post({ type: "compact" });
    inputEl.value = "";
    inputEl.style.height = "auto";
    C.setStatus(statusEl, "正在分层压缩上下文…");
    return;
  }
  // /memory：打开持久记忆文件，并弹出清空确认（查看 / 管理）
  if (text === "/memory") {
    ui.post({ type: "memory_view" });
    C.confirmClearMemory();
    inputEl.value = "";
    inputEl.style.height = "auto";
    C.setStatus(statusEl, "已打开记忆文件；如需清空，请在弹窗中确认。");
    return;
  }
  // /model：切换模型 / 提供商（打开模型选择器，对齐 Claude Code 的 /model）
  if (text === "/model") {
    const menu = document.getElementById("modelMenu") as HTMLElement;
    inputEl.value = "";
    inputEl.style.height = "auto";
    // 拉取最新模型选项后渲染并向上弹出模型菜单
    const opts = await requestModelOptions();
    C.renderModelMenu(opts);
    if (menu.classList.contains("open")) C.closeModelMenu();
    else C.openModelMenu();
    return;
  }
  const cmd = SLASH_COMMANDS.find((c) => c.name === text && c.prompt);
  if (cmd && cmd.prompt) text = cmd.prompt;
  let full = text;
  if (pendingContexts.length) {
    full = text + buildContextBlock(pendingContexts);
    clearContexts();
  }
  if (pendingQuotes.length) {
    full = full + buildQuotesBlock(pendingQuotes);
    pendingQuotes = [];
    renderQuoteChips();
  }
  C.addUserMessage(messagesEl, full, () => editInput(full));
  renderNavRail(); // 用户新消息登记后刷新右侧跳转导航（否则新输入的消息不出现跳转点）
  inputEl.value = "";
  inputEl.style.height = "auto";
  setStreaming(true);
  currentRound = null; // 新一轮回复：清空上一个回合气泡引用，等待后端首条消息重建
  // 在聊天区域（回合气泡内）显示"正在思考"，真正流式文本到达后自动替换
  currentRound = C.beginRound(messagesEl);
  C.showRoundThinking(currentRound);
  playStartSound();
  // 启动看门狗：90s 内无任何进展则主动结束，避免 UI 永远卡在「正在思考」
  startStreamWatchdog();
  C.setStatus(statusEl, "发送成功，等待回复…");
  const payload: any = { type: "user", text: full };
  if (pendingImages.length) {
    payload.images = pendingImages.map((p) => p.url);
    pendingImages = [];
    renderImageChips();
  }
  ui.post(payload);
}

/** 把累积的文件/选区上下文格式化为模型可读块。 */
function buildContextBlock(ctxs: typeof pendingContexts): string {
  const parts = ctxs.map((c) => {
    let s = `文件: ${c.file} (${c.language})`;
    if (c.selection && c.selection.text) {
      s += `\n选中内容 (L${c.selection.start}-L${c.selection.end}):\n\`\`\`${c.language}\n${c.selection.text}\n\`\`\``;
    } else if (c.content != null) {
      // @ 提及文件：直接把内容带给模型，无需模型再 read_file（对标 Claude Code @file）
      s += `\n完整内容${c.truncated ? "（超大文件，已截断前 300 行，如需更多请用 read_file）" : ""}:\n\`\`\`${c.language}\n${c.content}\n\`\`\``;
    } else {
      s += `\n（请在对话中按需引用或让其读取此文件）`;
    }
    return s;
  });
  return `\n\n[附加上下文]\n${parts.join("\n\n")}`;
}

/**
 * 窄侧边栏适配：监听顶栏宽度，过窄时给 body 加 `tb-compact` 类，
 * CSS 会让 tb-btn 只显示图标、隐藏文字/次要元素，避免侧边栏变窄时按键被遮挡。
 * 宽度足够宽时移除类，恢复完整显示。
 */
function setupResponsiveTopbar(): void {
  const topbar = document.getElementById("topbar");
  if (!topbar) return;
  // 阈值：约 360px（小于此时按钮文字会拥挤/遮挡）
  const apply = () => {
    const w = topbar.clientWidth;
    document.body.classList.toggle("tb-compact", w > 0 && w < 360);
  };
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(apply);
    ro.observe(topbar);
  } else {
    window.addEventListener("resize", apply);
  }
  // 初始应用一次
  apply();
}

/** 渲染顶栏会话下拉框（平时只显示当前标题，点击下拉切换）。 */
function renderSessionDropdown(sessions: Array<{ id: string; title: string }>, current: string): void {
  if (!sessionDropdownMenu || !sessionTitleEl) return;
  sessionDropdownMenu.innerHTML = "";
  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "dropdown-item";
    empty.style.opacity = "0.6";
    empty.textContent = "暂无其他会话";
    sessionDropdownMenu.appendChild(empty);
    return;
  }
  for (const s of sessions) {
    const row = document.createElement("div");
    row.className = "dropdown-item-row" + (s.id === current ? " active" : "");
    const dot = document.createElement("span");
    dot.className = "dot";
    const btn = document.createElement("button");
    btn.className = "dropdown-item" + (s.id === current ? " active" : "");
    btn.textContent = s.title || "未命名";
    btn.title = "切换到该会话";
    btn.addEventListener("click", () => {
      closeSessionDropdown();
      if (s.id !== current) ui.post({ type: "switch_session", id: s.id });
    });
    row.appendChild(dot);
    row.appendChild(btn);
    sessionDropdownMenu.appendChild(row);
  }
}

function openSessionDropdown(): void {
  if (!sessionDropdownEl || !sessionDropdownMenu) return;
  sessionDropdownEl.classList.add("open");
  sessionDropdownMenu.classList.add("open");
  const rect = sessionDropdownEl.getBoundingClientRect();
  sessionDropdownMenu.style.left = `${rect.left}px`;
  sessionDropdownMenu.style.top = `${rect.bottom + 4}px`;
  sessionDropdownMenu.style.minWidth = `${rect.width}px`;
}

function closeSessionDropdown(): void {
  if (!sessionDropdownEl || !sessionDropdownMenu) return;
  sessionDropdownEl.classList.remove("open");
  sessionDropdownMenu.classList.remove("open");
}

function toggleSessionDropdown(): void {
  if (!sessionDropdownEl) return;
  if (sessionDropdownEl.classList.contains("open")) closeSessionDropdown();
  else openSessionDropdown();
}

/** 对话跳转：重新渲染右侧竖条导航（每个消息一个圆点，hover 时 JS 显示全局 tooltip）。 */
function renderNavRail(): void {
  if (!navRailInner || !navBadge) return;
  navRailInner.innerHTML = "";
  const items = C.getNavItems();
  if (items.length > 0) {
    navBadge.textContent = String(items.length);
    navBadge.style.display = "";
  } else {
    navBadge.style.display = "none";
  }
  for (const it of items) {
    const dot = document.createElement("div");
    dot.className = `nav-dot ${it.role === "user" ? "user" : "assistant"}`;
    const tipHtml = `<div class="tt-role">${it.role === "user" ? "👤 用户" : "🤖 助手"}</div><div class="tt-text">${escHtml(it.label)}</div>`;
    dot.addEventListener("mouseenter", (e) => {
      positionNavTip(e.clientX, e.clientY, tipHtml);
    });
    dot.addEventListener("mousemove", (e) => {
      if (navTip && navTip.style.display !== "none") positionNavTip(e.clientX, e.clientY, tipHtml);
    });
    dot.addEventListener("mouseleave", hideNavTip);
    dot.addEventListener("click", () => { hideNavTip(); C.scrollToNav(it.id); });
    navRailInner.appendChild(dot);
  }
}
/** 全局 tooltip：填充内容并定位到鼠标旁（右侧优先，靠近屏幕右缘则放左侧）。 */
function positionNavTip(mx: number, my: number, html: string): void {
  if (!navTip) return;
  navTip.innerHTML = html;
  navTip.style.display = "block";
  const w = navTip.offsetWidth || 240;
  const h = navTip.offsetHeight || 80;
  let left = mx + 16;
  if (left + w > window.innerWidth - 8) left = mx - w - 16;
  let top = my - h / 2;
  top = Math.max(8, Math.min(window.innerHeight - h - 8, top));
  navTip.style.left = `${Math.max(8, left)}px`;
  navTip.style.top = `${top}px`;
}
function hideNavTip(): void {
  if (navTip) navTip.style.display = "none";
}
/** HTML 转义（用于 tooltip 文本）。 */
function escHtml(s: string): string {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/** 清空待发送上下文（发送后或新建对话时调用）。 */
function clearContexts(): void {
  pendingContexts = [];
  pendingImages = [];
  pendingQuotes = [];
  ctxChipsEl.innerHTML = "";
  hideQuoteBtn();
}

/** 渲染上下文 chips（文件名 + 选区标记 + 移除按钮）。 */
function renderCtxChips(): void {
  ctxChipsEl.innerHTML = "";
  pendingContexts.forEach((c, i) => {
    const chip = document.createElement("div");
    chip.className = "ctx-chip";
    const name = document.createElement("span");
    name.className = "ctx-name";
    name.textContent = c.file.split(/[\\/]/).pop() ?? "";
    name.title = c.file;
    const tag = document.createElement("span");
    tag.className = "ctx-tag";
    tag.textContent = c.selection ? `选区 L${c.selection.start}-L${c.selection.end}` : "文件";
    const x = document.createElement("button");
    x.className = "ctx-x";
    x.textContent = "×";
    x.title = "移除该上下文";
    x.addEventListener("click", () => {
      pendingContexts.splice(i, 1);
      renderCtxChips();
    });
    chip.appendChild(name);
    chip.appendChild(tag);
    chip.appendChild(x);
    ctxChipsEl.appendChild(chip);
  });
  renderImageChips(); // 文件 chips 之后追加图片 chips
  renderQuoteChips(); // 最后追加引用 chips（内层 innerHTML 清空后需重绘）
}

/** 渲染待发送图片 chips（ctxChipsEl 尾部追加）。 */
function renderImageChips(): void {
  // 只追加图片 chips，不重复添加已渲染的（用 data-img 标记去重）
  document.querySelectorAll<HTMLElement>("[data-img]").forEach((el) => el.remove());
  pendingImages.forEach((p, i) => {
    const chip = document.createElement("div");
    chip.className = "ctx-chip";
    chip.dataset.img = "1";
    const thumb = document.createElement("img");
    thumb.src = p.url;
    thumb.style.cssText = "width:22px;height:22px;object-fit:cover;border-radius:3px;";
    const name = document.createElement("span");
    name.className = "ctx-name";
    name.textContent = p.name;
    const x = document.createElement("button");
    x.className = "ctx-x";
    x.textContent = "×";
    x.title = "移除该图片";
    x.addEventListener("click", () => {
      pendingImages.splice(i, 1);
      renderImageChips();
    });
    chip.appendChild(thumb);
    chip.appendChild(name);
    chip.appendChild(x);
    ctxChipsEl.appendChild(chip);
  });
}

/** 结束当前助手消息（markdown 渲染 + 收尾）。 */
function finishAssistant() {
  if (currentRound) {
    C.finishRound(currentRound);
    currentRound = null;
  }
  if (currentText) {
    C.finishAssistant(currentText, currentAssistantWrap);
  } else if (currentAssistantWrap) {
    // 兜底：当前无活跃气泡，但存在未收尾的助手气泡（如工具调用后直接结束）
    const b = currentAssistantWrap.querySelector(".bubble") as HTMLElement | null;
    if (b) C.finishAssistant(b, currentAssistantWrap);
  }
  currentText = null;
  currentAssistantWrap = null;
}

// ── 输入区事件 ──
inputEl.addEventListener("keydown", (e) => {
  // 排除中文/日文等输入法合成期间的回车：选词用的 Enter 不应触发发送
  if (e.isComposing || (e as any).keyCode === 229) return;
  // 补全弹层打开时，方向键 / Enter / Tab / Esc 优先控制弹层而非发送
  if (C.isAutocompleteOpen()) {
    if (e.key === "ArrowDown") { e.preventDefault(); C.moveAutocomplete(1); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); C.moveAutocomplete(-1); return; }
    if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); C.pickAutocomplete(); return; }
    if (e.key === "Escape") { e.preventDefault(); C.hideAutocomplete(); return; }
  }
  // 回车发送；Shift+Enter 换行（对齐 Claude Code / Codex 习惯）
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
// 注：input 事件的 autoResize + 补全触发已由 initAutocomplete()（autocomplete.ts）统一绑定。
sendBtn.addEventListener("click", () => {
  // 合并的发送/停止按钮：运行时点击=停止，空闲时点击=发送
  if (streaming) {
    ui.post({ type: "stop" });
    clearStreamWatchdog();
    setStreaming(false);
  } else {
    send();
  }
});
newChatBtn.addEventListener("click", () => {
  clearStreamWatchdog();
  ui.post({ type: "newChat" });
});

// 欢迎页快捷建议：点击直接发送（事件委托，welcome 被重建后仍能响应）
document.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>(".suggestion");
  if (b) send(b.dataset.text || "");
});

// ── 链接委托：webview 内点击外部链接 → 主进程用系统浏览器打开 ──
messagesEl.addEventListener("click", (e) => {
  const a = (e.target as HTMLElement).closest("a[href]") as HTMLAnchorElement | null;
  if (a) {
    e.preventDefault();
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    ui.post({ type: "open_link", url: href });
  }
});

// ── 顶栏：模型下拉（替代原生 QuickPick）──
// 一次性等待 model_options 消息（用于点击时主动拉取最新数据，避免 uiLastModelOptions 过期/缺失）
let modelOptionsWaiter: ((msg: C.ModelOptionsMsg) => void) | null = null;
function requestModelOptions(): Promise<C.ModelOptionsMsg> {
  if (uiLastModelOptions) return Promise.resolve(uiLastModelOptions);
  return new Promise((resolve) => {
    modelOptionsWaiter = resolve;
    ui.post({ type: "get_model_options" });
    // 兜底超时：2s 后若没回包，resolve(null)，避免菜单永远打不开
    setTimeout(() => {
      if (modelOptionsWaiter) { modelOptionsWaiter(null as any); modelOptionsWaiter = null; }
    }, 2000);
  });
}
modelChip.addEventListener("click", async (e) => {
  e.stopPropagation();
  const menu = document.getElementById("modelMenu") as HTMLElement;
  if (menu.classList.contains("open")) { C.closeModelMenu(); return; }
  // 先拉取最新模型选项（确保含自动发现的模型），再渲染并打开
  const opts = await requestModelOptions();
  C.renderModelMenu(opts);
  C.openModelMenu();
});
let uiLastModelOptions: C.ModelOptionsMsg | null = null;
document.addEventListener("click", (e) => {
  const menu = document.getElementById("modelMenu") as HTMLElement;
  if (menu && menu.classList.contains("open") && !(e.target as HTMLElement).closest("#modelDropdown")) C.closeModelMenu();
  const emenu = document.getElementById("exportMenu") as HTMLElement | null;
  if (emenu && emenu.classList.contains("open") && !(e.target as HTMLElement).closest("#exportDropdown")) C.closeExportMenu();
  if (toolsMenuEl && toolsMenuEl.classList.contains("open") && !(e.target as HTMLElement).closest("#toolsDropdown")) closeToolsMenu();
  if (sessionDropdownEl?.classList.contains("open") && !(e.target as HTMLElement).closest("#sessionDropdown")) closeSessionDropdown();
});

/** 更新模式分段控件高亮（plan/ask/craft/coder）。 */
function setModeButtons(mode: string): void {
  const active = mode === "plan" || mode === "ask" || mode === "craft" || mode === "coder" ? mode : "coder";
  modePlanBtn.classList.toggle("active", active === "plan");
  modeAskBtn.classList.toggle("active", active === "ask");
  modeCraftBtn.classList.toggle("active", active === "craft");
  modeCoderBtn.classList.toggle("active", active === "coder");
}
modePlanBtn.addEventListener("click", () => ui.post({ type: "setMode", mode: "plan" }));
modeAskBtn.addEventListener("click", () => ui.post({ type: "setMode", mode: "ask" }));
modeCraftBtn.addEventListener("click", () => ui.post({ type: "setMode", mode: "craft" }));
modeCoderBtn.addEventListener("click", () => ui.post({ type: "setMode", mode: "coder" }));

// ── 自由停留滚动：用户上翻阅读旧内容时不强制跟随最新；出现「回到底部」按钮可随时跳回 ──
const updateJumpBtn = (): void => { jumpBottomBtn.classList.toggle("show", !C.nearBottom(messagesEl)); };
messagesEl.addEventListener("scroll", updateJumpBtn, { passive: true });
jumpBottomBtn.addEventListener("click", () => {
  messagesEl.scrollTop = messagesEl.scrollHeight;
  jumpBottomBtn.classList.remove("show");
});

// ── 引用历史回复：选中历史消息文字 → 弹出「添加到对话」→ 注入引用 chips（对齐 Codex 引用历史回复） ──
let lastQuoteMsg: HTMLElement | null = null;
function hideQuoteBtn(): void {
  quoteToChatBtn.classList.remove("show");
  lastQuoteMsg = null;
}
/** 从选区节点向上找所属的历史消息（仅 user / assistant 消息可被引用）。 */
function msgFromNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const el = node instanceof Element ? node : node.parentElement;
  return el ? el.closest<HTMLElement>(".msg.user, .msg.assistant") : null;
}
// 鼠标抬起后（选区已稳定）判定有效选区并在其上方弹出引用按钮
document.addEventListener("mouseup", (e) => {
  if (quoteToChatBtn.contains(e.target as Node)) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const txt = sel ? sel.toString().trim() : "";
    const msg = sel && sel.anchorNode ? msgFromNode(sel.anchorNode) : null;
    if (!msg || txt.length < 2 || !sel || sel.rangeCount === 0) {
      hideQuoteBtn();
      return;
    }
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      hideQuoteBtn();
      return;
    }
    lastQuoteMsg = msg;
    // 按钮浮在选区上方；选区贴近视口顶部时改放下方，避免溢出
    const topPos = rect.top - 34;
    quoteToChatBtn.style.left = Math.max(8, Math.min(rect.left, (window.innerWidth || 0) - 140)) + "px";
    quoteToChatBtn.style.top = (topPos < 8 ? rect.bottom + 8 : topPos) + "px";
    quoteToChatBtn.classList.add("show");
  }, 0);
});
// 点击按钮以外区域 / 滚动时收起引用按钮
document.addEventListener("mousedown", (e) => {
  if (!quoteToChatBtn.contains(e.target as Node)) hideQuoteBtn();
});
messagesEl.addEventListener("scroll", hideQuoteBtn, { passive: true });

quoteToChatBtn.addEventListener("click", () => {
  const sel = window.getSelection();
  const txt = sel ? sel.toString().trim() : "";
  const msg = lastQuoteMsg;
  if (!msg || !txt) return;
  const seq = Number((msg.dataset.navId || "").replace(/\D/g, "")) || 0;
  const role: "user" | "assistant" = msg.classList.contains("user") ? "user" : "assistant";
  pendingQuotes.push({ seq, role, text: txt });
  renderQuoteChips();
  hideQuoteBtn();
  sel?.removeAllRanges();
  inputEl.focus();
});

/** 渲染引用 chips（追加在 ctxChips 尾部，与文件/图片上下文并列）。 */
function renderQuoteChips(): void {
  document.querySelectorAll<HTMLElement>(".quote-chip").forEach((c) => c.remove());
  pendingQuotes.forEach((q, i) => {
    const who = q.role === "user" ? "我" : "助手";
    const chip = document.createElement("div");
    chip.className = "ctx-chip quote-chip";
    const label = document.createElement("span");
    label.className = "ctx-name";
    label.textContent = `📌 引用第 ${q.seq} 轮${who}的回复`;
    label.title = q.text;
    const x = document.createElement("button");
    x.className = "ctx-x";
    x.textContent = "×";
    x.title = "移除引用";
    x.addEventListener("click", () => {
      pendingQuotes.splice(i, 1);
      renderQuoteChips();
    });
    chip.appendChild(label);
    chip.appendChild(x);
    ctxChipsEl.appendChild(chip);
  });
}

/** 把引用块格式化为模型可读的 markdown 引用（对齐 ChatGPT/Codex 把引用注入请求的思路）。 */
function buildQuotesBlock(quotes: typeof pendingQuotes): string {
  const parts = quotes.map((q) => {
    const who = q.role === "user" ? "我" : "FreeSeek";
    const body = q.text
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
    return `> 📌 引用第 ${q.seq} 轮${who}的回复：\n${body}`;
  });
  return "\n\n" + parts.join("\n\n") + "\n";
}
sessionDropdownBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  toggleSessionDropdown();
});
forkBtn.addEventListener("click", () => ui.post({ type: "fork" }));
cmdBtn.addEventListener("click", () => ui.post({ type: "openCommands" }));
renameBtn.addEventListener("click", () => ui.post({ type: "rename" }));
addCtxBtn.addEventListener("click", () => ui.post({ type: "add_context" }));
// 图片选择：读文件为 base64 data URL，加入待发送图片列表
attachImgBtn.addEventListener("click", () => imgInput.click());
imgInput.addEventListener("change", () => {
  const files = Array.from(imgInput.files ?? []);
  imgInput.value = "";
  if (!files.length) return;
  let pending = files.length;
  for (const f of files) {
    if (!f.type.startsWith("image/")) continue;
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? "");
      if (url) {
        pendingImages.push({ url, name: f.name });
        renderImageChips();
      }
      if (--pending <= 0) {
        C.setStatus(statusEl, `已添加 ${pendingImages.length} 张图片，发送时随消息带给模型（需模型支持视觉）。`);
      }
    };
    reader.onerror = () => {
      if (--pending <= 0) C.setStatus(statusEl, "⚠ 部分图片读取失败。");
    };
    reader.readAsDataURL(f);
  }
});
settingsBtn.addEventListener("click", () => C.openSettingsModal(uiSettings));

const settingsBadge = document.createElement("span");
settingsBadge.id = "settingsBadge";
settingsBadge.style.display = "none";
settingsBtn.style.position = "relative";
settingsBtn.appendChild(settingsBadge);
let settingsPendingCount = 0;

function updateSettingsBadge(count: number): void {
  settingsPendingCount = Math.max(0, count);
  if (!settingsBadge) return;
  if (settingsPendingCount <= 0) {
    settingsBadge.style.display = "none";
    settingsBadge.textContent = "";
  } else {
    settingsBadge.style.display = "inline-flex";
    settingsBadge.textContent = settingsPendingCount > 99 ? "99+" : String(settingsPendingCount);
  }
}

function incSettingsBadge(delta = 1): void {
  updateSettingsBadge(settingsPendingCount + delta);
}

exportBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const menu = document.getElementById("exportMenu") as HTMLElement | null;
  if (!menu) return;
  if (!menu.classList.contains("open")) C.openExportMenu();
  else C.closeExportMenu();
});
document.querySelectorAll<HTMLButtonElement>("#exportMenu .dropdown-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const fmt = (btn.dataset.fmt || "md") as string;
    const messages = C.collectMessages();
    ui.post({ type: "export_chat", format: fmt, messages });
    C.closeExportMenu();
    C.setStatus(statusEl, `已请求导出为 ${fmt.toUpperCase()}…`);
  });
});
const importChatBtn = document.getElementById("importChatBtn") as HTMLButtonElement | null;
if (importChatBtn) {
  importChatBtn.addEventListener("click", () => {
    C.closeExportMenu();
    ui.post({ type: "import_chat" });
  });
}

// 「工具」下拉菜单：整合定时任务 / Hookify 规则 / 安装套件 / 启动服务 / 编辑提供商 / 会话日志
function closeToolsMenu() { toolsMenuEl?.classList.remove("open"); }
toolsBtn?.addEventListener("click", (e) => {
  e.stopPropagation();
  if (!toolsMenuEl) return;
  if (toolsMenuEl.classList.contains("open")) closeToolsMenu();
  else toolsMenuEl.classList.add("open");
});
document.querySelectorAll<HTMLButtonElement>("#toolsMenu .dropdown-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const act = btn.dataset.act || "";
    if (act) ui.post({ type: act });
    closeToolsMenu();
  });
});

// ── composer 上方小工具条（CodeBuddy 风格） ──
const tbAddCtx = document.getElementById("tbAddCtx") as HTMLButtonElement | null;
const tbAttachImg = document.getElementById("tbAttachImg") as HTMLButtonElement | null;
const tbFocusTasks = document.getElementById("tbFocusTasks") as HTMLButtonElement | null;
const tbFocusFiles = document.getElementById("tbFocusFiles") as HTMLButtonElement | null;
const tbImportChat = document.getElementById("tbImportChat") as HTMLButtonElement | null;
function focusPanel(id: string) {
  const p = document.getElementById(id) as HTMLDetailsElement | null;
  if (!p) return;
  p.open = true;
  p.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
tbAddCtx?.addEventListener("click", () => ui.post({ type: "add_context" }));
tbAttachImg?.addEventListener("click", () => imgInput.click());
tbFocusTasks?.addEventListener("click", () => focusPanel("tasksPanel"));
tbFocusFiles?.addEventListener("click", () => focusPanel("filesPanel"));
tbImportChat?.addEventListener("click", () => ui.post({ type: "import_conversation" }));

// ── 会话抽屉 ──
sbToggleOpenBtn.addEventListener("click", C.openSidebar);
sbToggleBtn.addEventListener("click", C.closeSidebar);
sidebarBackdropEl.addEventListener("click", C.closeSidebar);
newChatSbBtn.addEventListener("click", () => {
  ui.post({ type: "newChat" });
  C.closeSidebar();
});
importSbBtn?.addEventListener("click", () => {
  ui.post({ type: "import_conversation" });
  C.closeSidebar();
});
// 侧边栏工具入口：转发到扩展命令 / 方法，复用命令面板的既有逻辑
schedulesSbBtn?.addEventListener("click", () => {
  ui.post({ type: "schedules" });
  C.closeSidebar();
});
hookifySbBtn?.addEventListener("click", () => {
  ui.post({ type: "hookify" });
  C.closeSidebar();
});
installKitSbBtn?.addEventListener("click", () => {
  ui.post({ type: "install_kit" });
  C.closeSidebar();
});
manageKitsSbBtn?.addEventListener("click", () => {
  ui.post({ type: "manage_kits" });
  C.closeSidebar();
});
freeServerSbBtn?.addEventListener("click", () => {
  ui.post({ type: "start_free_server" });
  C.closeSidebar();
});
editProvidersSbBtn?.addEventListener("click", () => {
  ui.post({ type: "edit_providers" });
  C.closeSidebar();
});
sessionLogSbBtn?.addEventListener("click", () => {
  ui.post({ type: "open_session_log" });
  C.closeSidebar();
});
// 归档视图：显示/隐藏归档区并请求归档会话列表
function showArchivedView(): void {
  if (archivedWrap && sessionListEl) {
    sessionListEl.style.display = "none";
    archivedWrap.style.display = "block";
    sessionSearchEl.style.display = "none";
  }
  ui.post({ type: "list_archived" });
}
function showSessionsView(): void {
  if (archivedWrap && sessionListEl) {
    archivedWrap.style.display = "none";
    sessionListEl.style.display = "block";
    sessionSearchEl.style.display = "";
  }
}
archiveBtn?.addEventListener("click", showArchivedView);
backToSessionsBtn?.addEventListener("click", showSessionsView);
sessionSearchEl.addEventListener("input", () =>
  C.renderSessions(ui.lastSessions, sessionSearchEl.value, C.closeSidebar)
);

// ── 扩展消息分发 ──
/**
 * 会话归属过滤：流式/会话级消息若带 sessionId 且与当前视图会话不符（后台会话仍在前台执行），
 * 则丢弃不渲染，避免串台到当前视图。无 sessionId 的旧格式消息始终放行。
 */
function forCurrentSession(msg: { sessionId?: string }): boolean {
  if (!msg.sessionId) return true;
  return msg.sessionId === ui.currentViewSessionId;
}
window.addEventListener("message", (event) => {
  const msg = event.data || {};
  switch (msg.type) {
    case "user_injected": {
      // 定时任务/外部投递的用户消息：前端没经过输入框，需由后端通知渲染
      C.addUserMessage(messagesEl, String(msg.text || ""));
      renderNavRail(); // 注入的用户消息同样登记跳转点
      C.setStatus(statusEl, "已注入任务指令，开始执行…");
      break;
    }
    case "assistant_delta": {
      if (!forCurrentSession(msg)) break;
      resetStreamWatchdog();
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.appendRoundText(currentRound, msg.text);
      renderNavRail();
      break;
    }
    case "reasoning_delta": {
      if (!forCurrentSession(msg)) break;
      resetStreamWatchdog();
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.appendRoundReasoning(currentRound, msg.text);
      break;
    }
    case "tool_start":
      if (!forCurrentSession(msg)) break;
      // 工具调用并入当前回合气泡内（同一回复只一个气泡）
      // 长命令执行期间（用户可能离开屏幕）用更宽松的看门狗，避免 90s 被误判超时
      startStreamWatchdog(TOOL_WATCHDOG_MS);
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.addToolToRound(currentRound, "call", msg.name || "", msg.args || "");
      C.setStatus(statusEl, `执行工具：${msg.name}`);
      break;
    case "tool_result":
      if (!forCurrentSession(msg)) break;
      // 工具返回后：若回合仍在进行，回到普通超时预算；若已结束则由 done/stopped 清空
      if (streaming) startStreamWatchdog(BASE_WATCHDOG_MS);
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.addToolToRound(currentRound, "result", msg.name || "工具", msg.result || "");
      break;
    case "python_chart":
      if (!forCurrentSession(msg)) break;
      resetStreamWatchdog();
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.addPythonChartsToRound(currentRound, msg.charts || []);
      break;
    case "file_diff":
      if (!forCurrentSession(msg)) break;
      if (msg.kind === "delete") break; // 删除无 diff 卡片（回收站可恢复），文件列表面板已展示统计
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.addDiffToRound(currentRound, {
        id: msg.id,
        file: msg.file || "",
        kind: msg.kind || "edit",
        diff: msg.diff || "",
        added: msg.added || 0,
        removed: msg.removed || 0,
      });
      break;
    case "diff_state":
      C.setDiffState(String(msg.id || ""), String(msg.state || ""), msg.note);
      break;
    case "strip_toolcall":
      stripRawToolCall();
      break;
    case "step":
      if (!forCurrentSession(msg)) break;
      C.setStatus(statusEl, msg.text);
      break;
    case "context_status":
      if (!forCurrentSession(msg)) break;
      C.setStatus(statusEl, msg.text);
      break;
    case "todos":
      if (!forCurrentSession(msg)) break;
      // 任务列表 → 顶部常驻面板（CodeBuddy 风格）
      C.renderTasksPanel(msg.items || []);
      // 同时在回合气泡内保留一份，便于在该回合内直接看到 todo 进度
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.renderTodosToRound(currentRound, msg.items);
      break;
    case "goal":
      if (!forCurrentSession(msg)) break;
      // 当前目标 → 顶部常驻面板（goal 状态机跨会话持久，前端实时反映阶段变化）
      C.renderGoalPanel(msg.view || null);
      break;
    case "files":
      if (!forCurrentSession(msg)) break;
      // 文件列表面板（常驻）：包含本次回合所有修改文件 + 累计 diff 行数
      C.renderFilesPanel(msg.files || []);
      break;
    case "subagent_start":
      if (!forCurrentSession(msg)) break;
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      ui.currentSubLog = C.beginSubAgentToRound(currentRound, msg.name, msg.task);
      C.setStatus(statusEl, `子智能体运行中：${msg.name}`);
      break;
    case "subagent_tool":
      if (!forCurrentSession(msg)) break;
      if (ui.currentSubLog) C.appendSubLine(ui.currentSubLog, `🔧 ${msg.name}`);
      break;
    case "subagent_result":
      if (!forCurrentSession(msg)) break;
      if (ui.currentSubLog) C.appendSubLine(ui.currentSubLog, `↩️ ${msg.name} 完成`);
      break;
    case "subagent_end":
      if (!forCurrentSession(msg)) break;
      if (ui.currentSubLog) {
        C.appendSubLine(ui.currentSubLog, `📋 结论：${msg.report}`);
        const det = ui.currentSubLog.closest("details") as HTMLElement | null;
        if (det) det.removeAttribute("open");
        ui.currentSubLog = null;
      }
      C.setStatus(statusEl, "子智能体已交回结论。");
      break;
    case "model_info":
      if (msg.label) modelLabelEl.textContent = msg.label;
      break;
    case "model_options":
      uiLastModelOptions = msg;
      // 触发 modelChip 点击时的一次性等待器
      if (modelOptionsWaiter) {
        const w = modelOptionsWaiter;
        modelOptionsWaiter = null;
        w(msg);
      }
      break;
    case "fetch_models_result":
      // 「获取模型」实时拉取结果：派发给添加模型弹窗中的一次性回调
      C.dispatchFetchModelsResult({ reqId: msg.reqId, models: msg.models, error: msg.error });
      break;
    case "file_list":
      // @ 提及文件补全：由 autocomplete.ts 根据是否处于补全上下文决定是否弹出
      showFileAutocomplete((msg.files || []) as string[]);
      break;
    case "settings": {
      uiSettings = msg.settings || {};
      const skills = (msg.skills || []) as Array<{ status: string }>;
      uiSettings.skills = skills;
      registerPluginThemes((msg.pluginThemes || []) as Array<{ name: string; label: string; css: string }>);
      applyTheme(uiSettings.theme || "default");
      updateSettingsBadge(skills.filter((s) => s.status === "pending").length);
      break;
    }
    case "theme":
      // 后端确认主题已持久化后回发，应用并保持本地与配置一致
      applyTheme(String(msg.theme || "default"));
      break;
    case "skills_list": {
      // 技能管理列表更新（激活/停用/删除/去重后回灌，重渲染设置面板的技能区）
      const skills = (msg.skills || []) as Array<{ status: string }>;
      if (uiSettings) uiSettings.skills = skills;
      // 若设置面板当前打开，刷新其技能区块
      const sm = document.getElementById("skillsMgr");
      if (sm && uiSettings) C.renderSkillsManager(sm, uiSettings.skills);
      updateSettingsBadge(skills.filter((s) => s.status === "pending").length);
      break;
    }
    case "skill_distilled": {
      const skill = msg.skill as C.SkillDistillPayload | undefined;
      if (skill && messagesEl) {
        C.addSkillDistillCard(messagesEl, skill, () => {
          if (uiSettings) C.openSettingsModal(uiSettings);
        });
        C.setStatus(statusEl, `🧪 新技能「${skill.name}」待审核`);
        incSettingsBadge();
      }
      break;
    }
    case "agent_mode":
      setModeButtons(msg.mode);
      break;
    case "sandbox_mode": {
      const m = msg.mode || "off";
      sandboxLabelEl.textContent = m;
      sandboxChip.title = "OS 受限执行档：" + m + "（进程级受限，非 OS 级容器隔离）";
      break;
    }
    case "context_added":
      if (msg.error) {
        C.setStatus(statusEl, "⚠ " + msg.error);
      } else {
        pendingContexts.push({
          file: String(msg.file || ""),
          language: String(msg.language || "text"),
          selection: msg.selection,
        });
        renderCtxChips();
        const tag = msg.selection ? `选区 L${msg.selection.start}-L${msg.selection.end}` : "整个文件";
        const base = String(msg.file || "").split(/[\\/]/).pop();
        C.setStatus(statusEl, `已附加上下文：${base}（${tag}）`);
      }
      break;
    case "file_attached":
      // @ 提及文件：后端已读取内容，注入为待发送上下文（对标 Claude Code @file）
      if (msg.error) {
        C.setStatus(statusEl, "⚠ " + msg.error);
      } else {
        pendingContexts.push({
          file: String(msg.file || ""),
          language: String(msg.language || "text"),
          content: String(msg.content ?? ""),
          truncated: !!msg.truncated,
        });
        renderCtxChips();
        const base = String(msg.file || "").split(/[\\/]/).pop();
        C.setStatus(
          statusEl,
          `已附加文件内容：${base}${msg.truncated ? `（截断，共 ${msg.totalLines} 行）` : ""}`
        );
      }
      break;
    case "mcp_status":
      // 仅在有实际 MCP 信息时更新状态栏；未配置/未连接时不刷屏
      {
        const t = String(msg.text || "");
        if (t && !t.includes("未配置") && !t.includes("未连接")) {
          C.setStatus(statusEl, " " + t.split("\n")[0]);
        }
      }
      break;
    case "mcp_servers": {
      // 缓存 MCP server 列表，若 MCP 管理面板打开则重绘
      uiMcpServers = Array.isArray(msg.servers) ? msg.servers : [];
      const mm = document.getElementById("mcpMgr");
      if (mm) C.renderMcpManager(mm, uiMcpServers);
      break;
    }
    case "open_mcp_panel": {
      // 「管理 MCP」命令触发：打开设置面板（内含 MCP 区块）
      if (uiSettings) C.openSettingsModal(uiSettings);
      break;
    }
    case "open_skills_panel": {
      // /skills：打开设置面板（内含技能管理区块）
      if (uiSettings) C.openSettingsModal(uiSettings);
      break;
    }
    case "open_add_model": {
      // 打开「添加模型」webview 内弹窗（对齐 CodeBuddy）
      C.openAddProviderModal();
      break;
    }
    case "assistant_message": {
      // /summarize 等后端生成的助手消息
      C.addAssistantMessage(messagesEl, String(msg.text ?? ""));
      break;
    }
    case "observability": {
      if (!forCurrentSession(msg)) break;
      const t = msg.turns ?? 0;
      const tok = msg.tokens ?? 0;
      const ratio = (msg.ratio ?? 0) as number;
      const r = (ratio * 100).toFixed(0);
      const cost = msg.cost ?? 0;
      const costStr = cost > 0 ? ` · ~$${cost.toFixed(4)}` : "";
      const pin = msg.promptTokens ?? 0;
      const pout = msg.completionTokens ?? 0;
      const tcs = msg.toolCalls ?? 0;
      // 明细审计：输入/输出 token 与工具调用次数（Prompt/Completion 均 >0 时才展示）
      const detail =
        pin > 0 || pout > 0 ? ` · 入 ${pin} / 出 ${pout} tok · 工具 ${tcs} 次` : "";
      C.setStatus(statusEl, `✔ 完成 · ${t} 步 · ~${tok} tok · 上下文 ${r}%${detail}${costStr}`);
      // 顶栏状态芯片：上下文占用 + 持久记忆条数
      const mem = (msg.memoryCount ?? 0) as number;
      if (ctxLabelEl) ctxLabelEl.textContent = `上下文 ${r}% · 记忆 ${mem}`;
      const chip = document.getElementById("ctxState");
      if (chip) {
        chip.classList.toggle("warn", ratio >= 0.7 && ratio < 0.85);
        chip.classList.toggle("high", ratio >= 0.85);
        if (chip) chip.title = `会话审计：${t} 步 · 输入 ${pin} tok · 输出 ${pout} tok · 工具 ${tcs} 次 · ${costStr}`;
      }
      break;
    }
    case "task_notification":
      if (!forCurrentSession(msg)) break;
      if (!currentRound) currentRound = C.beginRound(messagesEl);
      C.addNotificationToRound(currentRound, msg.title || "通知", msg.body || "");
      break;
    case "restore":
      if (msg.sessionId) ui.currentViewSessionId = String(msg.sessionId);
      removeAllAskCards();
      lastRestoredMessages = msg.messages || [];
      C.renderConversation(messagesEl, lastRestoredMessages, onEditUserCb);
      currentRound = null;
      currentText = null;
      currentAssistantWrap = null;
      if (msg.editing) {
        // 原位置编辑重发：重绘截断后的历史并保持运行态，等待流式回复
        setStreaming(true);
        currentRound = C.beginRound(messagesEl);
        C.showRoundThinking(currentRound);
        startStreamWatchdog();
        C.setStatus(statusEl, "已重新发送，等待回复…");
      } else {
        setStreaming(false);
        C.setStatus(statusEl, "已恢复历史对话。");
      }
      renderNavRail();
      break;
    case "background_done": {
      // 后台会话已执行完毕：刷新会话列表，让用户看到该会话的更新（但不渲染进当前视图）。
      ui.post({ type: "get_sessions" });
      playDoneSound();
      break;
    }
    case "permission_request":
      C.showPermissionModal(msg.id, msg.tool || "", msg.summary || "");
      C.setStatus(statusEl, "等待权限确认…");
      break;
    case "permission_timeout":
      C.removePermissionModal(msg.id);
      break;
    case "ask_user":
      if (!forCurrentSession(msg)) break;
      // 等待用户选择/输入期间暂停流式看门狗，避免「提问中」被误判为请求卡死超时
      clearStreamWatchdog();
      C.renderAskCard(messagesEl, {
        id: String(msg.id || ""),
        question: String(msg.question || ""),
        options: Array.isArray(msg.options) ? msg.options : [],
        multiSelect: !!msg.multiSelect,
        onChoose: (value) => {
          ui.post({ type: "ask_choice", id: String(msg.id || ""), value });
          startStreamWatchdog();
        },
        onCancel: () => {
          ui.post({ type: "ask_choice", id: String(msg.id || ""), value: "" });
          startStreamWatchdog();
        },
      });
      C.setStatus(statusEl, "FreeSeek 正在等你回答一个问题…");
      break;
    case "ask_timeout":
      C.removeAskCard(String(msg.id || ""));
      startStreamWatchdog();
      C.setStatus(statusEl, "问题等待超时，已按「未选择」处理。");
      break;
    case "newChat":
      if (msg.sessionId) ui.currentViewSessionId = String(msg.sessionId);
      removeAllAskCards();
      C.clearMessages(messagesEl);
      C.resetNav();
      C.renderTasksPanel([]);
      C.renderFilesPanel([]);
      currentText = null;
      currentAssistantWrap = null;
      currentRound = null;
      clearContexts();
      C.closeSidebar();
      sessionTitleEl.textContent = "新对话";
      setStreaming(false);
      C.setStatus(statusEl, "已开始新对话。");
      C.showWelcome();
      renderNavRail();
      break;
    case "sessions":
      ui.lastSessions = msg.sessions || [];
      C.renderSessions(ui.lastSessions, sessionSearchEl.value, C.closeSidebar);
      break;
    case "archived_sessions":
      C.renderArchivedSessions(msg.sessions || []);
      break;
    case "session_title":
      if (msg.sessionId) ui.currentViewSessionId = String(msg.sessionId);
      sessionTitleEl.textContent = msg.title || "新对话";
      break;
    case "recent_sessions":
      renderSessionDropdown(Array.isArray(msg.sessions) ? msg.sessions : [], msg.current);
      break;
    case "done":
      if (!forCurrentSession(msg)) break;
      clearStreamWatchdog();
      removeAllAskCards();
      finishAssistant();
      setStreaming(false);
      C.setStatus(statusEl, msg.text || "就绪");
      playDoneSound();
      renderNavRail();
      break;
    case "stopped":
      if (!forCurrentSession(msg)) break;
      clearStreamWatchdog();
      removeAllAskCards();
      finishAssistant();
      setStreaming(false);
      C.setStatus(statusEl, "已停止。部分未完成的内容不会保存。");
      playDoneSound();
      break;
    case "error":
      if (!forCurrentSession(msg)) break;
      clearStreamWatchdog();
      removeAllAskCards();
      finishAssistant();
      setStreaming(false);
      C.setStatus(statusEl, "出错：" + msg.message);
      C.addErrorCard(messagesEl, msg.message);
      playDoneSound();
      break;
    case "system":
      C.setStatus(statusEl, msg.text);
      break;
    case "queue_state":
      // 后端权威队列长度：校正本地预览队列（入队即时反馈由 send 维护，此处以后端值对齐）
      if (typeof msg.pending === "number") {
        const n = Math.max(0, msg.pending);
        if (n < pendingUserQueue.length) pendingUserQueue.length = n;
        else while (pendingUserQueue.length < n) pendingUserQueue.push("");
        renderQueueBadge();
      }
      break;
  }
});

/** 隐藏流式显示出来的原始 <tool_call> 块（ReAct 文本协议），改用干净的 tool UI。 */
function stripRawToolCall() {
  if (currentRound) {
    // 多个正文块交错时，<tool_call> 可能落在任一 .stream 块，逐一剥离
    const streams = Array.from(currentRound.bubble.querySelectorAll<HTMLElement>(".stream"));
    for (const s of streams) {
      s.textContent = stripTags(s.textContent || "");
    }
    // 若剥离后为空且无工具/diff/子块，移除该空白回合气泡
    const anyText = streams.some((s) => !!(s.textContent || "").trim());
    if (!anyText && !currentRound.bubble.querySelector(".tool, .diff-card, .round-todos, .round-notification")) {
      C.removeRound(currentRound);
      currentRound = null;
    }
    return;
  }
  if (!currentText) return;
  const stream = currentText.querySelector(".stream");
  const src = stream ? stream.textContent : currentText.textContent;
  const cleaned = stripTags(src || "");
  if (stream) stream.textContent = cleaned;
  else currentText.textContent = cleaned;
  // 若剥离后为空，移除该空白气泡，避免界面出现空助理气泡
  const wrap = currentText.closest(".msg.assistant") as HTMLElement | null;
  if (wrap && !cleaned.trim()) {
    wrap.remove();
    currentText = null;
    currentAssistantWrap = null;
  }
}

C.setStatus(statusEl, "就绪。Enter 发送，Shift+Enter 换行。");
// 窄侧边栏适配：监听顶栏宽度，过窄时切换紧凑模式（按钮只留图标），防止按键被遮挡
setupResponsiveTopbar();
// 通知扩展前端已加载完成；若扩展侧已有对话，会回发 restore
ui.post({ type: "ready" });
// 若扩展侧未回发任何对话（含 dev harness 空状态），确保欢迎页可见
const hasMsg = !!document.querySelector("#messages .msg");
const welcomeEmpty = !document.querySelector("#welcome") || !document.querySelector("#welcome")!.innerHTML.trim();
if (!hasMsg && welcomeEmpty) {
  C.showWelcome();
}

// ── 输入框补全辅助（@提及文件 / /命令）──
// 逻辑已拆至 autocomplete.ts；此处仅注入依赖并启动（autoResize 与补全触发均在其内部绑定）。
initAutocomplete({
  inputEl,
  statusEl,
  post: (m) => ui.post(m),
  autoResize,
  requestModelOptions,
});
