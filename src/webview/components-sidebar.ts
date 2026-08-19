import { el } from "./components-base";
import { ui } from "./state";
import { confirmAction, promptInput } from "./components-dialogs";

// ── 会话抽屉（侧边栏）：分组 / 搜索 / 新建 / 删除 / 重命名 ──
function groupKey(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
  if (diffDays <= 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (diffDays <= 7) return "近 7 天";
  return d.toLocaleDateString("zh-CN", { year: "numeric", month: "long" });
}

function mkSact(label: string, danger: boolean, fn: () => void): HTMLButtonElement {
  const b = el("button", "sact" + (danger ? " danger" : ""), label) as HTMLButtonElement;
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    fn();
  });
  return b;
}

export function openSidebar(): void {
  const sidebar = document.getElementById("sidebar");
  const backdrop = document.getElementById("sidebar-backdrop");
  sidebar?.classList.add("open");
  backdrop?.classList.add("open");
  ui.post({ type: "get_sessions" });
}

export function closeSidebar(): void {
  document.getElementById("sidebar")?.classList.remove("open");
  document.getElementById("sidebar-backdrop")?.classList.remove("open");
}

/** 渲染会话列表（按日期分组 + 搜索过滤），每项含 打开 / 重命名 / 删除。 */
export function renderSessions(
  sessions: unknown[],
  filter: string,
  onClose: () => void
): void {
  const list = document.getElementById("sessionList");
  if (!list) return;
  list.innerHTML = "";
  const q = (filter || "").toLowerCase();
  const items = sessions as Array<{
    id: string;
    title?: string;
    preview?: string;
    updatedAt?: number;
    count?: number;
  }>;
  const filtered = items.filter(
    (s) => !q || ((s.title || "") + (s.preview || "")).toLowerCase().includes(q)
  );
  if (!filtered.length) {
    list.appendChild(
      el("div", "sm", items.length ? "没有匹配的会话。" : "还没有历史对话。")
    );
    return;
  }
  const groups = new Map<string, typeof filtered>();
  for (const s of filtered) {
    const g = groupKey(s.updatedAt || 0);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(s);
  }
  for (const [g, group] of groups) {
    list.appendChild(el("div", "session-group", g));
    for (const s of group) {
      const item = el("div", "session-item");
      item.appendChild(el("div", "st", s.title || "（无标题）"));
      item.appendChild(el("div", "sp", s.preview || ""));
      item.appendChild(
        el("div", "sm", `${new Date(s.updatedAt || 0).toLocaleString()} · ${s.count || 0} 条`)
      );
      const actions = el("div", "sactions");
      actions.appendChild(
        mkSact("打开", false, () => {
          ui.post({ type: "switch_session", id: s.id });
          onClose();
        })
      );
      actions.appendChild(
        mkSact("重命名", false, () => {
          promptInput("重命名会话", s.title || "", "输入新的会话名称", (t) => {
            if (t) ui.post({ type: "rename_session", id: s.id, title: t });
          });
        })
      );
      actions.appendChild(
        mkSact("归档", false, () => {
          ui.post({ type: "archive_session", id: s.id });
        })
      );
      actions.appendChild(
        mkSact("删除", true, () => {
          confirmAction("删除会话", `确定删除「${s.title || "未命名"}」？此操作不可撤销。`, "删除", () => {
            ui.post({ type: "delete_session", id: s.id });
          });
        })
      );
      item.appendChild(actions);
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".sactions")) return;
        ui.post({ type: "switch_session", id: s.id });
        onClose();
      });
      list.appendChild(item);
    }
  }
}

/** 渲染已归档会话列表（恢复 / 删除）。 */
export function renderArchivedSessions(sessions: unknown[]): void {
  const list = document.getElementById("archivedList");
  if (!list) return;
  list.innerHTML = "";
  const items = sessions as Array<{ id: string; title?: string; updatedAt?: number }>;
  if (!items.length) {
    list.appendChild(el("div", "sm", "暂无已归档的会话。"));
    return;
  }
  for (const s of items) {
    const item = el("div", "session-item archived");
    item.appendChild(el("div", "st", s.title || "（无标题）"));
    item.appendChild(el("div", "sm", `归档于 ${new Date(s.updatedAt || 0).toLocaleString()}`));
    const actions = el("div", "sactions");
    actions.appendChild(
      mkSact("恢复", false, () => ui.post({ type: "unarchive_session", id: s.id }))
    );
    actions.appendChild(
      mkSact("删除", true, () => {
        confirmAction("删除已归档会话", `确定删除「${s.title || "未命名"}」？此操作不可撤销。`, "删除", () => {
          ui.post({ type: "delete_session", id: s.id });
        });
      })
    );
    item.appendChild(actions);
    list.appendChild(item);
  }
}

// ── 模型下拉菜单（多提供商分组，替代原生 QuickPick）──
export interface ModelOptionsMsg {
  providers: Array<{
    id: string;
    name: string;
    toolMode: string;
    models: Array<{ id: string; name?: string }>;
  }>;
  active: { providerId: string; modelId: string } | null;
}
