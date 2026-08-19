import { el, followScroll, type Round } from "./components-base";
import { ui } from "./state";

export function renderTasksPanel(items: unknown[]): void {
  const body = document.getElementById("tasksBody");
  const count = document.getElementById("tasksCount");
  if (!body) return;
  body.innerHTML = "";
  const list = (items || []) as Array<{ content?: string; status?: string }>;
  if (!list.length) {
    body.appendChild(el("div", "ipanel-empty", "尚无任务"));
    if (count) count.textContent = "—";
    return;
  }
  const done = list.filter((t) => t.status === "completed").length;
  if (count) count.textContent = `${done}/${list.length}`;
  for (const it of list) {
    const st = it.status || "pending";
    const row = el("div", `ipanel-row ${st} fs-${st === "completed" ? "ok" : st === "in_progress" ? "accent" : "muted"}`);
    const mark = st === "completed" ? "☑" : st === "in_progress" ? "🔄" : "☐";
    row.appendChild(el("span", "ipanel-icon", mark));
    row.appendChild(el("span", "ipanel-text", it.content || ""));
    body.appendChild(row);
  }
}

/** 渲染「当前目标」常驻面板。view: {objective, phase, roundsStarted, maxRounds, blockedReason}。 */
export function renderGoalPanel(view: unknown): void {
  const body = document.getElementById("goalBody");
  const count = document.getElementById("goalCount");
  if (!body) return;
  body.innerHTML = "";
  const v = view as {
    objective?: string;
    phase?: string;
    roundsStarted?: number;
    maxRounds?: number;
    blockedReason?: string;
  } | null;
  if (!v || !v.objective) {
    body.appendChild(el("div", "ipanel-empty", "未登记目标"));
    if (count) count.textContent = "—";
    return;
  }
  const rounds = v.roundsStarted || 0;
  if (count) count.textContent = `${rounds}${v.maxRounds ? "/" + v.maxRounds : ""}`;
  const phase = v.phase || "active";
  const phaseLabel: Record<string, string> = { active: "进行中", paused: "已暂停", blocked: "受阻", complete: "已完成" };
  const icon: Record<string, string> = { active: "🎯", paused: "⏸", blocked: "⛔", complete: "✅" };
  const color = phase === "active" ? "accent" : phase === "complete" ? "ok" : phase === "blocked" ? "err" : "muted";
  const row = el("div", `ipanel-row ${phase} fs-${color}`);
  row.appendChild(el("span", "ipanel-icon", icon[phase] || "🎯"));
  row.appendChild(el("span", "ipanel-text", v.objective || ""));
  body.appendChild(row);
  const meta = el("div", "ipanel-meta", `${phaseLabel[phase] || phase} · 轮次 ${v.roundsStarted || 0}${v.maxRounds ? " / " + v.maxRounds : ""}`);
  body.appendChild(meta);
  if (v.blockedReason) {
    body.appendChild(el("div", "ipanel-meta fs-err", `原因：${v.blockedReason}`));
  }
}

/** 渲染顶部文件列表面板（常驻）。files: [{file, added, removed, kind, ids, reads}]。 */
export function renderFilesPanel(files: unknown[]): void {
  const body = document.getElementById("filesBody");
  const count = document.getElementById("filesCount");
  if (!body) return;
  body.innerHTML = "";
  const list = (files || []) as Array<{
    file?: string;
    added?: number;
    removed?: number;
    kind?: string;
    ids?: string[];
    reads?: number;
  }>;
  if (!list.length) {
    body.appendChild(el("div", "ipanel-empty", "尚无文件活动"));
    if (count) count.textContent = "—";
    return;
  }
  if (count) count.textContent = `${list.length} 个文件`;
  for (const f of list) {
    const row = el("div", "ipanel-row");
    const kindIcon: Record<string, string> = { create: "✚", write: "⤴", edit: "✎", delete: "🗑", read: "👁" };
    row.appendChild(el("span", "ipanel-icon", kindIcon[f.kind || "edit"] || "📄"));
    row.appendChild(el("span", "ipanel-text", f.file || ""));
    const stat = el("span", "ipanel-stat");
    if (f.kind === "read") {
      stat.innerHTML = `<span class="fs-muted">已读 ${f.reads || 1} 次</span>`;
    } else if (f.kind === "delete") {
      stat.innerHTML = `<span class="del">-${f.removed || 0} 行</span>`;
    } else {
      stat.innerHTML = `<span class="add">+${f.added || 0}</span> <span class="del">-${f.removed || 0}</span>`;
    }
    row.appendChild(stat);
    row.title = `${f.file} · 点击在编辑器中打开`;
    row.style.cursor = "pointer";
    row.addEventListener("click", () => ui.post({ type: "open_file", file: f.file || "", line: 1 }));
    body.appendChild(row);
  }
}

/** 在回合气泡内渲染任务清单子块（更新复用）。 */
export function renderTodosToRound(round: Round, items: unknown[]): void {
  // 移除旧的任务清单子块
  round.bubble.querySelectorAll(".round-todos").forEach((e) => e.remove());
  if (!items || !items.length) return;
  const wrap = el("div", "round-todos");
  const header = el("div", "todos-header", "✅ 任务清单");
  wrap.appendChild(header);
  const ul = el("ul", "todolist") as HTMLUListElement;
  for (const it of items as Array<{ content?: string; status?: string }>) {
    const li = el("li", it.status || "pending");
    const mark = it.status === "completed" ? "☑" : it.status === "in_progress" ? "🔄" : "☐";
    li.textContent = `${mark} ${it.content || ""}`;
    ul.appendChild(li);
  }
  wrap.appendChild(ul);
  round.bubble.appendChild(wrap);
}

/** 在回合气泡内开启子智能体折叠块，返回其日志容器。 */
export function beginSubAgentToRound(round: Round, name: string, task: string): HTMLElement {
  const det = document.createElement("details");
  det.className = "tool subagent round-sub";
  det.open = true;
  det.appendChild(el("summary", undefined, `🧩 子智能体：${name} — ${task || "（无任务描述）"}`));
  const log = el("div", "sublog");
  det.appendChild(log);
  round.bubble.appendChild(det);
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
  return log;
}

/** 在回合气泡内追加通知子块。 */
export function addNotificationToRound(round: Round, title: string, body: string): void {
  const box = el("div", "round-notification");
  const head = el("div", "notif-head", `🔔 ${title}`);
  box.appendChild(head);
  if (body) box.appendChild(el("div", "notif-body", body));
  round.bubble.appendChild(box);
  const me = round.wrap.closest("#messages") as HTMLElement | null;
  if (me) followScroll(me);
}
