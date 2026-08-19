import { el } from "./components-base";
import { ui } from "./state";
import { confirmAction } from "./components-dialogs";
import { openAddProviderModal } from "./components-provider";
import type { ModelOptionsMsg } from "./components-sidebar";

export function openModelMenu(): void {
  const menu = document.getElementById("modelMenu");
  const chip = document.getElementById("modelChip");
  if (!menu) return;
  // 智能定位：菜单向上弹出（chip 在 composer 底栏，下方会被输入框/屏幕边缘遮挡），并尽量向左展开
  // 避免被左侧 VS Code 主侧边栏图标栏遮挡（对齐 CodeBuddy 让菜单在 webview 区域内）。
  if (chip) {
    const r = chip.getBoundingClientRect();
    const menuW = Math.min(320, Math.max(260, (window.innerWidth || 400) - 20));
    const desiredLeft = r.right - menuW;
    const left = Math.max(8, desiredLeft);
    menu.style.left = left + "px";
    menu.style.right = "auto";
    // 向上弹出：bottom = 视口高度 - chip.top + 4px（chip 上方留 4px 间距）
    menu.style.bottom = (window.innerHeight - r.top + 4) + "px";
    menu.style.top = "auto";
    menu.style.width = menuW + "px";
    // 最大高度受 chip 上方可用空间限制
    const aboveSpace = r.top - 8;
    menu.style.maxHeight = Math.max(240, Math.min(aboveSpace, (window.innerHeight || 600) - 40)) + "px";
  }
  menu.classList.add("open");
}

export function closeModelMenu(): void {
  const menu = document.getElementById("modelMenu");
  if (!menu) return;
  menu.classList.remove("open");
  // 关闭后清除 inline 定位，避免下次打开时残留
  menu.style.left = menu.style.right = menu.style.top = menu.style.bottom = menu.style.width = menu.style.maxHeight = "";
}

export function renderModelMenu(options: ModelOptionsMsg | null): void {
  const menu = document.getElementById("modelMenu");
  if (!menu) return;
  menu.innerHTML = "";
  // Auto（智能选择）：置顶默认项，对齐 CodeBuddy 模型面板。未选择或 active 为 __auto__ 时高亮。
  const autoActive = !options || !options.active || options.active.providerId === "__auto__";
  const autoRow = el("div", "dropdown-item-row" + (autoActive ? " active" : ""));
  const autoBtn = el("button", "dropdown-item", `${autoActive ? "✓ " : ""}⚡ Auto（智能选择）`) as HTMLButtonElement;
  autoBtn.title = "由 FreeSeek 自动挑选已配置密钥的可用服务（默认）";
  autoBtn.addEventListener("click", () => {
    ui.post({ type: "set_model", providerId: "__auto__", modelId: "__auto__" });
    closeModelMenu();
  });
  autoRow.appendChild(autoBtn);
  menu.appendChild(autoRow);
  if (!options || !options.providers.length) {
    menu.appendChild(el("div", "dropdown-empty", "未配置提供商"));
  } else {
    for (const p of options.providers) {
      const group = el("div", "dropdown-group");
      // 分组标题行：左侧标题（点选该 provider 首个模型），右侧删除此 provider 的 × 按钮
      const titleRow = el("div", "dropdown-group-title");
      const titleText = el("span", "dgt-text", `${p.name} ${p.toolMode === "react" ? "· ReAct" : "· 原生"}`);
      if (p.models[0]) {
        titleText.style.cursor = "pointer";
        titleText.title = `切换到 ${p.name} / ${p.models[0].name || p.models[0].id}`;
        titleText.addEventListener("click", () => {
          ui.post({ type: "set_model", providerId: p.id, modelId: p.models[0].id });
          closeModelMenu();
        });
      }
      titleRow.appendChild(titleText);
      const delProv = el("button", "dropdown-del-prov", "🗑") as HTMLButtonElement;
      delProv.title = `删除整个提供商「${p.name}」`;
      delProv.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmAction(
          "删除提供商",
          `确定删除提供商「${p.name}」及其全部 ${p.models.length} 个模型？此操作不可撤销。`,
          "删除",
          () => ui.post({ type: "delete_provider", providerId: p.id })
        );
      });
      titleRow.appendChild(delProv);
      group.appendChild(titleRow);
      for (const m of p.models) {
        const isActive =
          !!options.active &&
          options.active.providerId === p.id &&
          options.active.modelId === m.id;
        const row = el("div", "dropdown-item-row" + (isActive ? " active" : ""));
        const item = el(
          "button",
          "dropdown-item",
          `${isActive ? "✓ " : ""}${m.name || m.id}`
        ) as HTMLButtonElement;
        item.dataset.provider = p.id;
        item.dataset.model = m.id;
        item.addEventListener("click", () => {
          ui.post({ type: "set_model", providerId: p.id, modelId: m.id });
          closeModelMenu();
        });
        row.appendChild(item);
        // 单项删除按钮（×）
        const del = el("button", "dropdown-del", "×") as HTMLButtonElement;
        del.title = `删除模型「${m.name || m.id}」`;
        del.addEventListener("click", (e) => {
          e.stopPropagation();
          confirmAction(
            "删除模型",
            `确定删除模型「${m.name || m.id}」（${p.name}）？此操作不可撤销。`,
            "删除",
            () => ui.post({ type: "delete_model", providerId: p.id, modelId: m.id })
          );
        });
        row.appendChild(del);
        group.appendChild(row);
      }
      menu.appendChild(group);
    }
  }
  const footer = el("div", "dropdown-footer");
  const add = el("button", "dropdown-action", "＋ 添加提供商");
  add.addEventListener("click", () => {
    closeModelMenu();
    openAddProviderModal();
  });
  const edit = el("button", "dropdown-action", "⚙ 编辑 providers");
  edit.addEventListener("click", () => {
    ui.post({ type: "open_provider_edit" });
    closeModelMenu();
  });
  footer.appendChild(add);
  footer.appendChild(edit);
  menu.appendChild(footer);
}
