import { el } from "./components-base";
import { escapeHtml } from "./markdown";
import { ui } from "./state";

export function showPermissionModal(id: string, tool: string, summary: string): void {
  const overlay = el("div", "modal-overlay");
  overlay.id = "permOverlay-" + id;
  const box = el("div", "modal");
  box.appendChild(el("div", "modal-title", "🔐 权限请求"));
  const body = el("div", "modal-body");
  const intro = el("div");
  intro.innerHTML = `工具 <b>${escapeHtml(tool)}</b> 请求执行：`;
  const pre = el("pre", "modal-pre", summary || "(无参数)");
  body.appendChild(intro);
  body.appendChild(pre);
  body.appendChild(el("div", undefined, "是否允许？"));
  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const mk = (label: string, decision: string, cls?: string) => {
    const b = el("button", cls, label) as HTMLButtonElement;
    b.addEventListener("click", () => {
      ui.post({ type: "permission_response", id, decision });
      overlay.remove();
    });
    return b;
  };
  btns.appendChild(mk("允许一次", "allow"));
  btns.appendChild(mk("总是允许", "allow_always", "primary"));
  btns.appendChild(mk("拒绝", "deny"));
  btns.appendChild(mk("总是拒绝", "deny_always", "danger"));
  box.appendChild(body);
  box.appendChild(btns);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

export function removePermissionModal(id: string): void {
  const elModal = document.getElementById("permOverlay-" + id);
  if (elModal) elModal.remove();
}

// ── ask_user 独立提问弹窗（对齐 CodeBuddy / Claude Code AskUserQuestion：居中弹窗 + 可点击选项 + 确认/取消）──
export interface AskCardOptions {
  id: string;
  question: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  /** 用户已作答（选择或提交文本）。 */
  onChoose: (value: string) => void;
  /** 用户点了「取消」。 */
  onCancel: () => void;
}

/** 弹出 ask_user 独立模态框：有 options 渲染可点击选项（单选点击即提交，多选后点「确定」），否则渲染自由文本输入框。 */
export function renderAskCard(_container: HTMLElement, opts: AskCardOptions): void {
  const overlay = el("div", "modal-overlay");
  overlay.id = "askOverlay-" + opts.id;
  const box = el("div", "modal ask-modal");
  const finish = (v: string) => {
    opts.onChoose(v);
    overlay.remove();
  };
  const cancelNow = () => {
    opts.onCancel();
    overlay.remove();
  };

  // 标题行（对齐 CodeBuddy：图标 + 标题 + 右上角关闭）
  const titleRow = el("div", "modal-title-row");
  titleRow.appendChild(el("span", undefined, "❓ FreeSeek 提问"));
  const closeX = el("button", "modal-close", "✕") as HTMLButtonElement;
  closeX.title = "取消";
  closeX.addEventListener("click", cancelNow);
  titleRow.appendChild(closeX);
  box.appendChild(titleRow);

  // 问题文本
  box.appendChild(el("div", "ask-question", opts.question || "请选择或输入你的回答"));

  const body = el("div", "modal-body");
  let okBtn: HTMLButtonElement | null = null;

  if (opts.options && opts.options.length) {
    const list = el("div", "ask-options");
    const selected = new Set<string>();
    for (const o of opts.options) {
      const b = el("button", "ask-option" + (opts.multiSelect ? " multi" : "")) as HTMLButtonElement;
      b.appendChild(el("span", "ask-radio"));
      const main = el("span", "ask-option-main");
      main.appendChild(el("span", "ask-option-label", o.label));
      if (o.description) main.appendChild(el("span", "ask-option-desc", o.description));
      b.appendChild(main);
      b.addEventListener("click", () => {
        if (opts.multiSelect) {
          if (selected.has(o.label)) {
            selected.delete(o.label);
            b.classList.remove("selected");
          } else {
            selected.add(o.label);
            b.classList.add("selected");
          }
          if (okBtn) okBtn.disabled = selected.size === 0;
          return;
        }
        finish(o.label);
      });
      list.appendChild(b);
    }
    body.appendChild(list);
    if (opts.multiSelect) {
      okBtn = el("button", "primary", "确定") as HTMLButtonElement;
      okBtn.disabled = true;
      okBtn.addEventListener("click", () => {
        if (!selected.size) return;
        finish(Array.from(selected).join(", "));
      });
    }
  } else {
    // 自由文本模式：textarea + 提交
    const ta = el("textarea", "ask-input") as HTMLTextAreaElement;
    ta.placeholder = "输入你的回答…（Enter 提交，Shift+Enter 换行）";
    const submit = () => {
      const v = ta.value.trim();
      if (!v) return;
      finish(v);
    };
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });
    body.appendChild(ta);
    okBtn = el("button", "primary", "提交") as HTMLButtonElement;
    okBtn.addEventListener("click", submit);
  }
  box.appendChild(body);

  // 底部按钮：多选/自由文本有主操作（确定/提交），单选时仅「取消」；Esc 关闭
  const btns = el("div", "modal-btns");
  if (okBtn) btns.appendChild(okBtn);
  const cancel = el("button", undefined, "取消") as HTMLButtonElement;
  cancel.addEventListener("click", cancelNow);
  btns.appendChild(cancel);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") cancelNow();
  });
  document.body.appendChild(overlay);
  // 弹窗内自动聚焦（自由文本输入框 / 首个选项）
  const auto = box.querySelector<HTMLElement>(".ask-input, .ask-option");
  if (auto) auto.focus();
}

/** 移除指定 ask 弹窗（超时 / 回合结束时调用）。 */
export function removeAskCard(id: string): void {
  const o = document.getElementById("askOverlay-" + id);
  if (o) o.remove();
}
