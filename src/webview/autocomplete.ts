/**
 * 输入框补全逻辑层（@提及文件 / /命令）。
 * 从 main.ts 拆出（减行数）：渲染层在 components-autocomplete.ts，本模块负责
 * 触发检测、补全候选过滤、选中后的插入与副作用（如 /clear /summarize /model）。
 * 仅依赖注入的 inputEl / ui / 状态回调，避免与 main.ts 全局状态耦合。
 */
import * as C from "./components";

/** 内置 slash 命令（对标 Claude Code / Codex 的 /init /review /compact /clear）。 */
export const SLASH_COMMANDS: Array<{ name: string; hint: string; prompt?: string }> = [
  { name: "/init", hint: "生成项目说明文档", prompt: "请分析当前项目的整体结构，生成一份项目说明文档：包含技术栈、目录结构、关键模块职责、构建/运行方式与上手指南。若合适，可写入 README.md 或项目说明文件。" },
  { name: "/review", hint: "全面代码审查", prompt: "请对当前工作区（或当前打开的文件）做一次全面的代码审查：按严重程度（阻塞 / 重要 / 建议）列出问题、潜在风险与改进建议，并给出优先级排序。" },
  { name: "/summarize", hint: "生成当前对话的结构化摘要" },
  { name: "/skills", hint: "查看/管理技能（打开技能管理面板）" },
  { name: "/compact", hint: "分层压缩历史（引擎侧，非截断）" },
  { name: "/memory", hint: "查看/管理持久记忆" },
  { name: "/model", hint: "切换模型 / 提供商（打开模型选择器）" },
  { name: "/clear", hint: "清空当前对话", prompt: "" },
];

export interface AutocompleteDeps {
  /** 输入框元素（读取光标位置、写入文本）。 */
  inputEl: HTMLTextAreaElement;
  /** 状态栏元素（补全相关提示）。 */
  statusEl: HTMLDivElement;
  /** 向扩展主进程发消息。 */
  post: (msg: unknown) => void;
  /** 输入框内容变化后按内容重设高度。 */
  autoResize: () => void;
  /** 拉取最新模型选项（/model 与模型菜单共用）。 */
  requestModelOptions: () => Promise<C.ModelOptionsMsg | null>;
}

/** 输入框补全触发起点（@ 或 / 字符在文本中的位置）；-1 表示无激活补全。 */
let acTriggerStart = -1;

/** 检测输入框光标前是否处于 @ 提及或 / 命令补全上下文。 */
function detectTrigger(): { triggerChar: string; query: string; start: number } | null {
  const caret = deps.inputEl.selectionStart ?? deps.inputEl.value.length;
  const before = deps.inputEl.value.slice(0, caret);
  const m = before.match(/(^|\s)([@/])(\w*)$/);
  if (!m) return null;
  const triggerChar = m[2];
  const query = m[3];
  const start = (m.index ?? 0) + m[1].length;
  return { triggerChar, query, start };
}

/** 把选中的补全项（@文件 或 /命令）插入到触发位置，替换触发文本。 */
function insertCompletion(value: string, prefix: string): void {
  const caret = deps.inputEl.selectionStart ?? deps.inputEl.value.length;
  const start = acTriggerStart;
  const suffix = deps.inputEl.value.slice(caret);
  const insert = prefix + value + " ";
  deps.inputEl.value = deps.inputEl.value.slice(0, start) + insert + suffix;
  const newCaret = start + insert.length;
  deps.inputEl.setSelectionRange(newCaret, newCaret);
  acTriggerStart = -1;
  deps.autoResize();
  deps.inputEl.focus();
}

function onPickAt(item: { value: string }): void {
  insertCompletion(item.value, "@");
  // @ 提及文件：同时向后端请求读取内容并加入待发送上下文（对标 Claude Code @file）
  if (item.value) {
    deps.post({ type: "attach_file", file: item.value.replace(/^@/, "").trim() });
  }
}

async function onPickSlash(item: { value: string }): Promise<void> {
  const cmd = SLASH_COMMANDS.find((c) => c.name === item.value);
  if (cmd && cmd.name === "/clear") {
    deps.post({ type: "newChat" });
    deps.inputEl.value = "";
    deps.inputEl.style.height = "auto";
    acTriggerStart = -1;
    return;
  }
  if (cmd && cmd.name === "/summarize") {
    deps.post({ type: "summarize_chat" });
    C.setStatus(deps.statusEl, "正在生成对话摘要…");
    acTriggerStart = -1;
    return;
  }
  if (cmd && cmd.name === "/skills") {
    deps.post({ type: "open_skills_panel" });
    acTriggerStart = -1;
    return;
  }
  // /model：从补全里选中后直接打开模型选择器（对齐 Claude Code）
  if (cmd && cmd.name === "/model") {
    acTriggerStart = -1;
    const menu = document.getElementById("modelMenu") as HTMLElement;
    const opts = await deps.requestModelOptions();
    C.renderModelMenu(opts);
    if (menu.classList.contains("open")) C.closeModelMenu();
    else C.openModelMenu();
    return;
  }
  if (cmd && cmd.prompt) {
    insertCompletion(cmd.prompt, "");
  } else {
    insertCompletion(item.value, "/");
  }
}

/** 输入框内容变化时，决定是否弹出 / 刷新补全。 */
function onInputAutocomplete(): void {
  const t = detectTrigger();
  if (!t) {
    C.hideAutocomplete();
    return;
  }
  if (t.triggerChar === "@") {
    acTriggerStart = t.start;
    deps.post({ type: "list_files", query: t.query });
  } else {
    acTriggerStart = t.start;
    const cmds = SLASH_COMMANDS.filter((c) => c.name.startsWith("/" + t.query));
    if (cmds.length) {
      C.showAutocomplete(
        cmds.map((c) => ({ label: c.name, value: c.name, hint: c.hint })),
        onPickSlash
      );
    } else {
      C.hideAutocomplete();
    }
  }
}

/** 后端返回文件列表后，若处于 @ 补全上下文则弹出文件补全菜单。 */
export function showFileAutocomplete(files: string[]): void {
  if (acTriggerStart < 0) return;
  if (files.length) C.showAutocomplete(files.map((f) => ({ label: f, value: f })), onPickAt);
  else C.hideAutocomplete();
}

let deps: AutocompleteDeps;

/** 初始化补全模块：绑定输入框 input 事件。 */
export function initAutocomplete(d: AutocompleteDeps): void {
  deps = d;
  d.inputEl.addEventListener("input", () => {
    d.autoResize();
    onInputAutocomplete();
  });
}
