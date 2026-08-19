import { el } from "./components-base";
import { ui } from "./state";

export function confirmAction(title: string, bodyText: string, dangerLabel: string, onConfirm: () => void): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal");
  box.appendChild(el("div", "modal-title", title));
  const body = el("div", "modal-body");
  body.appendChild(el("div", "set-text", bodyText));
  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const cancel = el("button", "", "取消") as HTMLButtonElement;
  cancel.addEventListener("click", () => overlay.remove());
  const ok = el("button", "danger", dangerLabel) as HTMLButtonElement;
  ok.addEventListener("click", () => {
    overlay.remove();
    onConfirm();
  });
  btns.appendChild(cancel);
  btns.appendChild(ok);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

/** 自定义输入框（替代 window.prompt——webview 沙箱禁用，导致重命名无法输入）。 */
export function promptInput(title: string, initial: string, placeholder: string, onOk: (value: string) => void): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal");
  box.appendChild(el("div", "modal-title", title));
  const body = el("div", "modal-body");
  const input = document.createElement("input");
  input.className = "rename-input";
  input.value = initial;
  input.placeholder = placeholder;
  input.style.cssText = "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:var(--radius-sm);" +
    "border:1px solid var(--vscode-input-border,rgba(127,127,127,.3));background:var(--vscode-input-background,transparent);" +
    "color:var(--vscode-foreground);outline:none;";
  body.appendChild(input);
  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const cancel = el("button", "", "取消") as HTMLButtonElement;
  cancel.addEventListener("click", () => overlay.remove());
  const ok = el("button", "primary", "确定") as HTMLButtonElement;
  const submit = () => {
    const v = input.value.trim();
    if (v) { overlay.remove(); onOk(v); }
  };
  ok.addEventListener("click", submit);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  btns.appendChild(cancel);
  btns.appendChild(ok);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  input.focus();
  input.select();
}

/** 清空持久记忆确认框（危险操作二次确认）。确认后请求扩展侧删除项目级记忆。 */
export function confirmClearMemory(): void {
  const existing = document.getElementById("clearMemModal");
  if (existing) existing.remove();
  const overlay = el("div", "modal-overlay");
  overlay.id = "clearMemModal";
  const box = el("div", "modal");
  box.appendChild(el("div", "modal-title", "⚠ 清空持久记忆"));
  const body = el("div", "modal-body");
  const warn = el("div", "set-text");
  warn.appendChild(el("div", "set-label", "将删除本项目的全部自动记忆（.agent/memory 下所有条目）。"));
  warn.appendChild(
    el("div", "set-desc", "这些记忆由压缩抽取与 remember 工具写入，跨会话持久。清空后无法恢复，但 Agent 可在后续对话中重新学习。用户级记忆不受影响。")
  );
  body.appendChild(warn);
  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const cancel = el("button", "", "取消") as HTMLButtonElement;
  cancel.addEventListener("click", () => overlay.remove());
  const ok = el("button", "danger", "清空") as HTMLButtonElement;
  ok.addEventListener("click", () => {
    overlay.remove();
    ui.post({ type: "clear_memory" });
  });
  btns.appendChild(cancel);
  btns.appendChild(ok);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}
