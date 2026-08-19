import { el, icSvg } from "./components-base";
import { ui, applyTheme } from "./state";
import { confirmAction } from "./components-dialogs";

// ── 内嵌设置面板（对标 Codex / Claude Code 对话内设置）──
// 标题图标（内联 SVG，笔触随主题 --ic-* 变量切换）
const SET_ICONS = {
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 1v4M12 19v4M4.2 4.2l2.8 2.8M17 17l2.8 2.8M1 12h4M19 12h4M4.2 19.8l2.8-2.8M17 7l2.8-2.8"/>',
  palette:
    '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.9 0 1.5-.6 1.5-1.5 0-.4-.2-.7-.4-1-.2-.3-.4-.6-.4-1 0-.8.7-1.5 1.5-1.5H16c3.3 0 6-2.7 6-6 0-4.4-4.5-8-10-8z"/>',
  compass: '<circle cx="12" cy="12" r="10"/><polygon points="16.24 7.76 14.12 14.12 7.76 16.24 9.88 9.88 16.24 7.76"/>',
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
} as const;

/** 带主题化图标的设置区标题。 */
function setTitle(icon: string, text: string): HTMLElement {
  const t = el("div", "set-section-title");
  t.appendChild(icSvg(icon));
  t.appendChild(el("span", undefined, text));
  return t;
}
const SETTING_TOGGLES: Array<{ key: string; label: string; desc: string }> = [
  { key: "allowShell", label: "允许执行终端命令", desc: "开启后 Agent 可运行 shell 命令（仅 Craft 制作模式可用；高危，建议仅可信环境开启）" },
  { key: "allowNetwork", label: "允许联网检索 / 抓取网页", desc: "开启后 Agent 可使用 web_search / web_fetch 联网查资料（纯 HTTP 请求，非终端命令，默认开启）" },
  { key: "confirmFileWrites", label: "文件写入前确认", desc: "每次写 / 编辑文件都弹窗确认（默认关闭，对齐 Claude Code）" },
  { key: "autoFormat", label: "编辑后自动格式化", desc: "写文件后用 VS Code 注册的格式化器美化（失败静默跳过）" },
  { key: "soundStart", label: "会话开始提示音", desc: "发送任务、Agent 开始执行时播放短提示音" },
  { key: "soundDone", label: "会话完成提示音", desc: "任务完成 / 停止 / 出错时播放提示音" },
  { key: "importAutoRead", label: "导入后自动通读", desc: "导入 Codex / Claude Code 对话后，自动让 Agent 通读工作区并生成摘要，便于无缝继续" },
];

export function openSettingsModal(settings: any): void {
  const existing = document.getElementById("settingsModal");
  if (existing) existing.remove();
  const overlay = el("div", "modal-overlay");
  overlay.id = "settingsModal";
  const box = el("div", "modal");
  const title = el("div", "modal-title");
  title.appendChild(icSvg(SET_ICONS.gear));
  title.appendChild(el("span", undefined, "设置"));
  box.appendChild(title);
  const body = el("div", "modal-body");
  body.style.maxHeight = "60vh";
  body.style.overflowY = "auto";
  for (const t of SETTING_TOGGLES) {
    const row = el("label", "set-row");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!settings?.[t.key];
    cb.addEventListener("change", () => ui.post({ type: "update_setting", key: t.key, value: cb.checked }));
    const text = el("div", "set-text");
    text.appendChild(el("div", "set-label", t.label));
    text.appendChild(el("div", "set-desc", t.desc));
    row.appendChild(cb);
    row.appendChild(text);
    body.appendChild(row);
  }
  // 主题风格：色块切换（默认跟随 VS Code / 原神 / 鸣潮 / 学术 / 工业）
  {
    const themeTitle = setTitle(SET_ICONS.palette, "主题风格");
    body.appendChild(themeTitle);
    const curTheme = settings?.theme || "default";
    const swatches = el("div", "theme-swatches");
    const themeDefs: Array<[string, string, string]> = [
      ["default", "默认", "#9aa3ad"],
      ["genshin", "原神", "#c88a2d"],
      ["wuthering", "鸣潮", "#c9a227"],
      ["academic", "学术", "#3f5d7f"],
      ["industrial", "工业", "#f0a832"],
    ];
    for (const [id, label, color] of themeDefs) {
      const b = el("button", "theme-swatch" + (id === curTheme ? " active" : "")) as HTMLButtonElement;
      b.dataset.theme = id;
      b.title = label;
      const dot = el("span", "theme-dot");
      dot.style.background = color;
      b.appendChild(dot);
      b.appendChild(el("span", "theme-label", label));
      b.addEventListener("click", () => {
        for (const s of Array.from(swatches.querySelectorAll(".theme-swatch"))) s.classList.remove("active");
        b.classList.add("active");
        applyTheme(id); // 立即生效，避免等后端回包
        ui.post({ type: "update_setting", key: "theme", value: id });
      });
      swatches.appendChild(b);
    }
    const themeRow = el("div", "set-row");
    themeRow.appendChild(swatches);
    body.appendChild(themeRow);
  }
  // 沙箱模式：下拉选择（off / readonly / sandbox）
  const sbRow = el("label", "set-row");
  const sel = document.createElement("select");
  sel.className = "set-select";
  const sbVal = settings?.sandboxMode || "off";
  for (const [val, label] of [
    ["off", "off（原样执行）"],
    ["readonly", "readonly（完全禁命令）"],
    ["sandbox", "sandbox（OS 级沙箱）"],
  ] as Array<[string, string]>) {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = label;
    if (val === sbVal) o.selected = true;
    sel.appendChild(o);
  }
  sel.addEventListener("change", () => ui.post({ type: "update_setting", key: "sandboxMode", value: sel.value }));
  const sbText = el("div", "set-text");
  sbText.appendChild(el("div", "set-label", "沙箱模式"));
  sbText.appendChild(el("div", "set-desc", "OS 受限执行档；Windows 无原生沙箱会软降级为进程级受限并告警"));
  sbRow.appendChild(sel);
  sbRow.appendChild(sbText);
  body.appendChild(sbRow);
  // 上下文压缩阈值：自由数字输入（单位 token），并保留常用预设快捷选择
  const cbRow = el("label", "set-row");
  const cbWrap = el("div", "set-input-wrap");
  const cbInput = document.createElement("input");
  cbInput.type = "number";
  cbInput.className = "set-number";
  cbInput.min = "1000";
  cbInput.step = "1000";
  cbInput.value = String(Number(settings?.contextBudget) || 16000);
  cbInput.title = "上下文压缩阈值（token）。达到该值的 85% 时自动压缩历史。";
  const cbQuick = document.createElement("select");
  cbQuick.className = "set-select";
  cbQuick.title = "常用预设快捷选择（也可在左侧直接输入任意数值）";
  const cbQuickDefs: Array<[number, string]> = [
    [4000, "4k"],
    [8000, "8k"],
    [12000, "12k"],
    [16000, "16k"],
    [32000, "32k"],
    [48000, "48k"],
    [64000, "64k"],
    [96000, "96k"],
    [128000, "128k"],
    [200000, "200k"],
  ];
  for (const [val, label] of cbQuickDefs) {
    const o = document.createElement("option");
    o.value = String(val);
    o.textContent = label;
    cbQuick.appendChild(o);
  }
  cbQuick.value = String(Number(cbInput.value)); // 命中则高亮对应预设，否则为空白项
  cbQuick.addEventListener("change", () => {
    if (!cbQuick.value) return;
    cbInput.value = cbQuick.value;
    commitBudget();
  });
  function commitBudget(): void {
    const n = parseInt(cbInput.value, 10);
    const v = Number.isFinite(n) && n >= 1000 ? n : 32000;
    ui.post({ type: "update_setting", key: "contextBudget", value: v });
  }
  cbInput.addEventListener("change", commitBudget);
  cbWrap.appendChild(cbInput);
  cbWrap.appendChild(cbQuick);
  const cbText = el("div", "set-text");
  cbText.appendChild(el("div", "set-label", "上下文压缩阈值"));
  cbText.appendChild(el("div", "set-desc", "对话累计 token 达到该值的 85% 时自动分层压缩历史（另设消息数兜底，≥30 轮必压）。应设为约 70% 的模型上下文窗口——如 LM Studio 设为 8k，这里填 8k 或更低；设过大（如超过模型窗口）会让小模型窗口溢出却从不自动压缩。直接输入任意数值（≥1000），或用右侧预设快捷选择。下次对话生效。"));
  cbRow.appendChild(cbWrap);
  cbRow.appendChild(cbText);
  body.appendChild(cbRow);
  // Context Planner：当前默认 off；实验版本必须通过 Bench 证据再推广。
  const cpRow = el("label", "set-row");
  const cpWrap = el("div", "set-input-wrap");
  const cpSelect = document.createElement("select");
  cpSelect.className = "set-select";
  for (const [val, label] of [
    ["off", "off（原始 agentic search）"],
    ["v1", "v1（Repo Map + Symbol + Dependency）"],
    ["v1.1", "v1.1（v1 + 排除意图/生产路径排序）"],
    ["v1.2", "v1.2（v1.1 retrieval + 结构化 evidence/tool discipline）"],
  ] as Array<[string, string]>) {
    const o = document.createElement("option");
    o.value = val; o.textContent = label; o.selected = val === (settings?.contextPlanner || "off"); cpSelect.appendChild(o);
  }
  cpSelect.addEventListener("change", () => ui.post({ type: "update_setting", key: "contextPlanner", value: cpSelect.value }));
  const cpBudget = document.createElement("input");
  cpBudget.type = "number"; cpBudget.className = "set-number"; cpBudget.min = "256"; cpBudget.max = "12000"; cpBudget.step = "256";
  cpBudget.value = String(Number(settings?.contextPlannerBudget) || 3500);
  cpBudget.title = "Context Planner 注入 token 预算";
  cpBudget.addEventListener("change", () => ui.post({ type: "update_setting", key: "contextPlannerBudget", value: Number(cpBudget.value) || 3500 }));
  cpWrap.appendChild(cpSelect); cpWrap.appendChild(cpBudget);
  const cpText = el("div", "set-text");
  cpText.appendChild(el("div", "set-label", "Context Planner"));
  cpText.appendChild(el("div", "set-desc", "v1.2 保持 v1.1 的 retrieval 排序，只改变 Context Presentation / Tool Selection 指引，用于隔离验证“模型如何使用候选上下文”。默认关闭；请用 Bench A/B 后再决定默认版本。右侧为注入 token 上限。"));
  cpRow.appendChild(cpWrap); cpRow.appendChild(cpText); body.appendChild(cpRow);
  // ── 技能进化闭环：技能管理区 ──
  const skTitle = setTitle(SET_ICONS.compass, "技能管理（技能进化闭环）");
  body.appendChild(skTitle);
  const skDesc = el(
    "div",
    "set-desc",
    "会话结束后自动沉淀的可复用技能标为 pending（待审核）。激活后才可被 Agent 加载使用；可去重合并高相似技能。"
  );
  body.appendChild(skDesc);
  const dedupeBtn = el("button", "primary small", "去重合并重复技能") as HTMLButtonElement;
  dedupeBtn.style.margin = "6px 0 8px";
  dedupeBtn.addEventListener("click", () => ui.post({ type: "dedupe_skills" }));
  body.appendChild(dedupeBtn);
  const skillsMgr = el("div", "skills-mgr");
  skillsMgr.id = "skillsMgr";
  body.appendChild(skillsMgr);
  if (Array.isArray(settings?.skills)) renderSkillsManager(skillsMgr, settings.skills);
  // ── MCP 服务管理区 ──
  const mcTitle = setTitle(SET_ICONS.plug, "MCP 服务管理");
  body.appendChild(mcTitle);
  const mcDesc = el(
    "div",
    "set-desc",
    "已配置的 Model Context Protocol 服务。连接成功后其工具会以 mcp__<server>__<tool> 暴露给 Agent。配置在 settings.json 的 freesek.mcpServers。"
  );
  body.appendChild(mcDesc);
  const mcReconnect = el("button", "primary small", "重新连接") as HTMLButtonElement;
  mcReconnect.style.margin = "6px 0 8px";
  mcReconnect.addEventListener("click", () => ui.post({ type: "reconnect_mcp" }));
  body.appendChild(mcReconnect);
  const mcpMgr = el("div", "mcp-mgr");
  mcpMgr.id = "mcpMgr";
  body.appendChild(mcpMgr);
  mcpMgr.appendChild(el("div", "set-desc", "（加载中…）"));
  // 请求最新 MCP 列表，回传后由 main.ts 的 mcp_servers 消息填充 #mcpMgr
  ui.post({ type: "list_mcp" });
  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const close = el("button", "primary", "完成") as HTMLButtonElement;
  close.addEventListener("click", () => overlay.remove());
  btns.appendChild(close);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.body.appendChild(overlay);
}

/**
 * 技能管理列表渲染（技能进化闭环的审计/回滚 UI）：
 * 按 pending / active / builtin 分组，每组可折叠；每项以卡片形式展示
 * name + status 徽标 + 描述 + 触发词，以及激活 / 停用 / 删除操作。
 * 该容器在每次操作后通过 skills_list 消息整体重绘。
 */
export function renderSkillsManager(container: HTMLElement, skills: any[]): void {
  container.innerHTML = "";
  if (!skills || !skills.length) {
    container.appendChild(el("div", "set-desc", "（暂无技能。会话结束后可自动沉淀可复用技能。）"));
    return;
  }

  const grouped = {
    pending: [] as any[],
    active: [] as any[],
    builtin: [] as any[],
  };
  for (const s of skills) {
    if (s.builtin) grouped.builtin.push(s);
    else if (s.status === "pending") grouped.pending.push(s);
    else grouped.active.push(s);
  }

  const sections: Array<{ key: keyof typeof grouped; label: string; open: boolean }> = [
    { key: "pending", label: "待审核", open: true },
    { key: "active", label: "已激活", open: false },
    { key: "builtin", label: "内置模板", open: false },
  ];

  for (const sec of sections) {
    const list = grouped[sec.key];
    if (!list.length) continue;

    const details = document.createElement("details");
    details.className = "sk-section";
    details.open = sec.open;
    const summary = document.createElement("summary");
    summary.className = "sk-section-summary";
    summary.innerHTML = `<span class="sk-section-title">${sec.label}</span><span class="sk-section-count">${list.length}</span>`;
    details.appendChild(summary);

    const body = el("div", "sk-section-body");
    for (const s of list) {
      body.appendChild(renderSkillCard(s));
    }
    details.appendChild(body);
    container.appendChild(details);
  }
}

function renderSkillCard(s: any): HTMLElement {
  const row = el("div", "sk-row");
  const info = el("div", "sk-info");
  const top = el("div", "sk-top");
  const name = el("span", "sk-name", s.name);
  const badgeTxt = s.builtin
    ? "内置"
    : s.status === "pending"
      ? "待审核"
      : "已激活";
  const badgeCls = s.builtin ? "builtin" : s.status === "pending" ? "pending" : "active";
  const badge = el("span", "sk-badge " + badgeCls, badgeTxt);
  top.appendChild(name);
  top.appendChild(badge);
  info.appendChild(top);
  if (s.description) info.appendChild(el("div", "sk-desc", s.description));
  if (Array.isArray(s.triggers) && s.triggers.length) {
    info.appendChild(el("div", "sk-triggers", `触发：${s.triggers.join("、")}`));
  }
  row.appendChild(info);

  const ops = el("div", "sk-ops");
  if (s.builtin) {
    ops.appendChild(el("span", "sk-hint", "只读 · 可复制到技能目录定制"));
  } else {
    if (s.status === "pending") {
      const act = el("button", "sk-btn primary", "激活") as HTMLButtonElement;
      act.addEventListener("click", () => ui.post({ type: "activate_skill", name: s.name }));
      ops.appendChild(act);
    } else {
      const deact = el("button", "sk-btn", "停用") as HTMLButtonElement;
      deact.addEventListener("click", () => ui.post({ type: "deactivate_skill", name: s.name }));
      ops.appendChild(deact);
    }
    const del = el("button", "sk-btn danger", "删除") as HTMLButtonElement;
    del.addEventListener("click", () => {
      confirmAction(`删除技能「${s.name}」`, "此操作不可撤销。", "删除", () => {
        ui.post({ type: "delete_skill", name: s.name });
      });
    });
    ops.appendChild(del);
  }
  row.appendChild(ops);
  return row;
}

/**
 * MCP 服务管理列表渲染：展示每个 server 的连接状态、传输方式、目标与工具数，
 * 提供「重连」入口（整体重连由后端 reconnect_mcp 完成）。
 */
export function renderMcpManager(container: HTMLElement, servers: any[]): void {
  container.innerHTML = "";
  if (!servers || !servers.length) {
    container.appendChild(
      el(
        "div",
        "set-desc",
        "（未配置 MCP server。请在 settings.json 的 freesek.mcpServers 中配置 stdio/http 服务，然后点「重新连接」。）"
      )
    );
    return;
  }
  for (const s of servers) {
    const row = el("div", "sk-row");
    const info = el("div", "sk-info");
    const top = el("div", "sk-top");
    const name = el("span", "sk-name", s.name || "?");
    const statusCls = s.status === "connected" ? "active" : "pending";
    const statusTxt = s.status === "connected" ? "已连接" : s.status === "error" ? "连接失败" : "未连接";
    const badge = el("span", "sk-badge " + statusCls, statusTxt);
    top.appendChild(name);
    top.appendChild(badge);
    info.appendChild(top);
    info.appendChild(el("div", "set-desc", `传输：${s.transport} · ${s.target || ""}`));
    if (Array.isArray(s.tools) && s.tools.length) {
      const toolList = s.tools.slice(0, 5).join(", ") + (s.tools.length > 5 ? ` +${s.tools.length - 5}` : "");
      info.appendChild(el("div", "set-desc", `工具（${s.tools.length}）：${toolList}`));
    }
    row.appendChild(info);
    container.appendChild(row);
  }
}
