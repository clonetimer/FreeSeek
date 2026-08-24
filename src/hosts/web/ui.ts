/**
 * FreeSeek Web Console — 浏览器端单页 UI 模板。
 *
 * 设计约束（对齐 Webview 安全纪律）：
 * - 所有模型/工具文本经 HTML 转义后渲染，杜绝 XSS（不执行任何模型产物）。
 * - UI 只做 ACP session/update 投影的展示与输入；权限决策仍由 Runtime 审批。
 * - 零依赖：原生 fetch + EventSource + DOM，随 Web Console Server 内联下发。
 */

/** 生成 Web Console 浏览器页面（token 由服务端启动时随机生成并经 URL 注入）。 */
export function webConsolePageHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FreeSeek Web Console</title>
<style>
:root{--bg:#101418;--panel:#171c22;--panel2:#1d242c;--fg:#dbe4ee;--muted:#8494a7;
--accent:#4da3ff;--ok:#3fb96f;--warn:#d9a441;--err:#e0564f;--border:#2a333e}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);
font:14px/1.6 "Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;height:100vh;
display:flex;flex-direction:column}
header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:var(--panel);
border-bottom:1px solid var(--border)}
header .brand{font-weight:600}header .ws{font-size:12px;color:var(--muted)}
header .ws.ok{color:var(--ok)}header .ws.err{color:var(--err)}
header select{background:var(--panel2);color:var(--fg);border:1px solid var(--border);
border-radius:6px;padding:3px 8px}
main{flex:1;display:flex;min-height:0}
aside{width:250px;background:var(--panel);border-right:1px solid var(--border);
display:flex;flex-direction:column}
aside .side-head{padding:10px;display:flex;gap:8px;border-bottom:1px solid var(--border)}
aside button{flex:1;background:var(--accent);border:0;color:#fff;border-radius:6px;
padding:6px;cursor:pointer}
aside ul{list-style:none;margin:0;padding:6px;overflow:auto;flex:1}
aside li{padding:7px 9px;border-radius:6px;cursor:pointer;margin-bottom:3px;
white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--muted)}
aside li:hover{background:var(--panel2)}
aside li.active{background:var(--panel2);color:var(--fg)}
aside li .t{font-size:12px}aside li .m{font-size:11px;color:var(--muted)}
section{flex:1;display:flex;flex-direction:column;min-width:0}
#chat{flex:1;overflow:auto;padding:14px 18px;display:flex;flex-direction:column;gap:10px}
.msg{max-width:860px;white-space:pre-wrap;word-break:break-word}
.msg.user{align-self:flex-end;background:#24415f;padding:8px 12px;border-radius:12px 12px 3px 12px}
.msg.agent{align-self:flex-start;background:var(--panel);border:1px solid var(--border);
padding:8px 12px;border-radius:12px 12px 12px 3px}
.msg.thought{align-self:flex-start;color:var(--muted);font-size:12px;font-style:italic;
border-left:3px solid var(--border);padding:2px 10px}
.msg pre{background:#0c0f12;border:1px solid var(--border);border-radius:6px;padding:8px;
overflow:auto;white-space:pre}
.toolcard{align-self:flex-start;border:1px solid var(--border);border-radius:8px;
background:var(--panel);min-width:320px;max-width:860px}
.toolcard>summary{cursor:pointer;padding:6px 10px;font-size:13px;color:var(--muted)}
.toolcard .body{padding:0 10px 8px;font-size:12px;color:var(--muted);white-space:pre-wrap;
word-break:break-word;max-height:240px;overflow:auto}
.toolcard .st{font-size:11px}.toolcard .st.ok{color:var(--ok)}
.toolcard .st.run{color:var(--warn)}.toolcard .st.err{color:var(--err)}
footer{display:flex;gap:8px;padding:10px 14px;background:var(--panel);
border-top:1px solid var(--border)}
footer textarea{flex:1;resize:none;background:var(--panel2);color:var(--fg);
border:1px solid var(--border);border-radius:8px;padding:8px 10px;min-height:42px;
max-height:160px;font:inherit}
footer button{background:var(--accent);border:0;color:#fff;border-radius:8px;
padding:0 18px;cursor:pointer;font-weight:600}
footer button.alt{background:var(--panel2);color:var(--fg);border:1px solid var(--border)}
footer button:disabled{opacity:.45;cursor:not-allowed}
#authgate{position:fixed;inset:0;background:rgba(8,10,13,.92);display:flex;
align-items:center;justify-content:center;z-index:9}
#authgate .card{background:var(--panel);border:1px solid var(--border);border-radius:10px;
padding:22px;width:360px}
#authgate input{width:100%;background:var(--panel2);color:var(--fg);
border:1px solid var(--border);border-radius:6px;padding:8px;margin:10px 0}
#authgate button{width:100%;background:var(--accent);border:0;color:#fff;
border-radius:6px;padding:8px;cursor:pointer}
.hidden{display:none!important}
.permcard.align-self,.eliccard{align-self:flex-start;border:1px solid var(--warn);
background:var(--panel);border-radius:8px;padding:10px 12px;max-width:860px}
.permcard .ph{font-size:13px;color:var(--warn);margin-bottom:6px}
.permcard .po,.eliccard .eo{display:flex;gap:8px;flex-wrap:wrap}
.permcard button,.eliccard button{background:var(--accent);border:0;color:#fff;border-radius:6px;
padding:6px 14px;cursor:pointer}
.permcard button[data-o^='reject'],.eliccard button[data-ok]{background:var(--panel2);
color:var(--fg);border:1px solid var(--border)}
.permcard.resolved,.eliccard.resolved{opacity:.55;border-color:var(--ok)}
.eliccard .eh{font-size:13px;color:var(--accent);margin-bottom:8px}
.eliccard .ef{display:flex;flex-direction:column;gap:8px;margin-bottom:8px}
.eliccard label{display:flex;flex-direction:column;font-size:12px;color:var(--muted)}
.eliccard label input{margin-top:3px;background:var(--panel2);color:var(--fg);
border:1px solid var(--border);border-radius:6px;padding:6px 8px;font:inherit}
</style>
</head>
<body>
<div id="authgate" class="hidden">
  <div class="card"><h3>FreeSeek Web Console</h3>
  <p style="color:var(--muted);font-size:12px">输入启动时打印的访问令牌（仅本机回环服务）</p>
  <input id="tokinput" placeholder="token" autocomplete="off">
  <button id="tokbtn">进入</button></div>
</div>
<header>
  <span class="brand">FreeSeek Web Console</span>
  <span class="ws" id="wsstate">未连接</span>
  <span style="flex:1"></span>
  <select id="modeSel" title="对话模式">
    <option value="coder">Coder</option><option value="craft">Craft</option>
    <option value="plan">Plan</option><option value="ask">Ask</option>
  </select>
  <button id="cancelBtn" class="alt" style="background:var(--panel2);color:var(--fg);
  border:1px solid var(--border);border-radius:6px;padding:3px 10px" disabled>停止</button>
</header>
<main>
  <aside><div class="side-head"><button id="newBtn">+ 新会话</button>
  <button id="reloadBtn" style="background:var(--panel2);border:1px solid var(--border)">刷新</button></div>
  <ul id="sesslist"></ul></aside>
  <section><div id="chat"></div>
  <footer><textarea id="input" placeholder="描述任务…（Enter 发送，Shift+Enter 换行）"></textarea>
  <button id="sendBtn">发送</button></footer></section>
</main>
<script>
"use strict";
const qs = new URLSearchParams(location.search);
let token = qs.get("token") || "";
let currentSession = null;
let evtSource = null;
let streaming = false;
const el = (id) => document.getElementById(id);
const enc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
if (!token) el("authgate").classList.remove("hidden");
el("tokbtn").onclick = () => { token = el("tokinput").value.trim();
  el("authgate").classList.add("hidden"); init(); };

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, Object.assign({
    headers: { "Authorization": "Bearer " + token,
      ...(opts.body ? { "Content-Type": "application/json" } : {}) },
  }, opts));
  if (res.status === 401) { el("authgate").classList.remove("hidden"); throw new Error("令牌无效"); }
  if (res.status === 403) throw new Error("请求来源被拒绝");
  const row = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(row.error || ("HTTP " + res.status));
  return row;
}

function setWs(text, cls) { const w = el("wsstate"); w.textContent = text;
  w.className = "ws " + (cls || ""); }

function addMsg(kind, text) {
  const div = document.createElement("div");
  div.className = "msg " + kind; div.innerHTML = enc(text);
  el("chat").appendChild(div); scrollBottom(); return div;
}
function addToolCard(callId, title) {
  const card = document.createElement("details"); card.className = "toolcard";
  card.dataset.callId = callId;
  card.innerHTML = "<summary>" + enc(title) +
    " <span class='st run'>运行中…</span></summary><div class='body'></div>";
  el("chat").appendChild(card); scrollBottom(); return card;
}
function scrollBottom() { const c = el("chat"); c.scrollTop = c.scrollHeight; }

function renderUpdate(update) {
  const kind = update && update.sessionUpdate;
  if (!kind) return;
  const text = update.content && typeof update.content.text === "string" ? update.content.text : "";
  if (kind === "user_message_chunk") addMsg("user", text);
  else if (kind === "agent_message_chunk") {
    let last = el("chat").lastElementChild;
    if (!last || !last.classList.contains("agent")) last = addMsg("agent", "");
    last.textContent += text; scrollBottom();
  } else if (kind === "agent_thought_chunk") {
    let last = el("chat").lastElementChild;
    if (!last || !last.classList.contains("thought")) last = addMsg("thought", "");
    last.textContent += text; scrollBottom();
  } else if (kind === "tool_call") {
    addToolCard(update.toolCallId || String(Date.now()) + Math.random(),
      "🔧 " + (update.title || update.kind || "工具调用"));
  } else if (kind === "tool_call_update") {
    const card = el("chat").querySelector("[data-call-id='" +
      String(update.toolCallId).replace(/'/g, "") + "']");
    if (!card) return;
    const st = card.querySelector(".st"); const body = card.querySelector(".body");
    const status = update.status || "";
    if (status === "completed") { st.textContent = "完成"; st.className = "st ok"; }
    else if (status === "failed") { st.textContent = "失败"; st.className = "st err"; }
    if (typeof update.content === "string" && update.content) body.textContent = update.content.slice(0, 4000);
    else if (update.content && typeof update.content.text === "string")
      body.textContent = update.content.text.slice(0, 4000);
  } else if (kind === "current_mode_update") {
    if (update.currentModeId) el("modeSel").value = update.currentModeId;
  } else if (kind === "permission_request") {
    // 缺口4：浏览器端交互审批——弹出审批卡，点击按钮回传决策。
    mountPermission(update);
  } else if (kind === "elicitation_request") {
    // 缺口4：浏览器端 ask_user 结构化表单——按 requestedSchema 渲染字段。
    mountElicitation(update);
  }
}

function stopStream() { if (evtSource) { evtSource.close(); evtSource = null; }
  streaming = false; setBusy(false); }

// 缺口4：浏览器端交互审批。弹出审批卡，按 option 回传 decision（allow/reject 形态）。
function mountPermission(update) {
  const wrap = document.createElement("div");
  wrap.className = "permcard";
  const title = (update.toolCall && (update.toolCall.title || update.toolCall.kind)) || "工具调用";
  let opts = (update.options || [{ optionId: "allow_once", name: "允许" }, { optionId: "reject_once", name: "拒绝" }]);
  wrap.innerHTML = "<div class='ph'>⚠ 需要审批：<b>" + enc(title) + "</b></div>" +
    "<div class='po'>" + opts.map((o) => "<button data-o='" + enc(o.optionId) + "'>" + enc(o.name) + "</button>").join("") + "</div>";
  wrap.querySelectorAll("button[data-o]").forEach((b) => {
    b.onclick = async () => {
      wrap.querySelectorAll("button").forEach((x) => x.disabled = true);
      try {
        await api("/session/respond", { method: "POST",
          body: JSON.stringify({ requestId: update.requestId, decision: b.dataset.o }) });
        wrap.classList.add("resolved");
      } catch (e) { b.disabled = false; alert("审批回传失败：" + e.message); }
    };
  });
  el("chat").appendChild(wrap); scrollBottom();
}

// 缺口4：浏览器端 ask_user 结构化表单。按 requestedSchema.properties 渲染输入字段。
function mountElicitation(update) {
  const schema = update.requestedSchema || { type: "object", properties: {} };
  const props = schema.properties || {};
  const required = schema.required || [];
  const wrap = document.createElement("div");
  wrap.className = "eliccard";
  wrap.innerHTML = "<div class='eh'>❓ " + enc(update.message || "需要补充信息") + "</div><div class='ef'></div>" +
    "<div class='eo'><button data-ok='1'>提交</button></div>";
  const body = wrap.querySelector(".ef");
  const fields = {};
  Object.keys(props).forEach((k) => {
    const meta = props[k] || {};
    const label = document.createElement("label");
    label.innerHTML = "<span>" + enc(meta.title || k) + (required.includes(k) ? " *" : "") + "</span>";
    const input = document.createElement("input");
    input.type = meta.type === "integer" || meta.type === "number" ? "number" : "text";
    input.placeholder = meta.description || "";
    input.dataset.k = k;
    label.appendChild(input); body.appendChild(label);
    fields[k] = input;
  });
  wrap.querySelector("button[data-ok]").onclick = async () => {
    const collected = {};
    for (const k in fields) {
      let v = fields[k].value;
      if ((props[k] || {}).type === "integer") v = parseInt(v, 10);
      else if ((props[k] || {}).type === "number") v = parseFloat(v);
      collected[k] = v;
    }
    wrap.querySelectorAll("button").forEach((x) => x.disabled = true);
    try {
      await api("/session/respond", { method: "POST",
        body: JSON.stringify({ requestId: update.requestId, fields: collected }) });
      wrap.classList.add("resolved");
    } catch (e) { wrap.querySelectorAll("button").forEach((x) => x.disabled = false); alert("表单回传失败：" + e.message); }
  };
  el("chat").appendChild(wrap); scrollBottom();
}
function setBusy(on) { el("sendBtn").disabled = on; el("cancelBtn").disabled = !on; }

function openStream(sessionId) {
  stopStream(); streaming = true; setBusy(false);
  evtSource = new EventSource("/api/session/events?sessionId=" +
    encodeURIComponent(sessionId) + "&token=" + encodeURIComponent(token));
  evtSource.onmessage = (e) => {
    let row; try { row = JSON.parse(e.data); } catch { return; }
    const update = row && row.update;
    if (update) renderUpdate(update);
  };
  evtSource.onerror = () => { setWs("连接中断", "err"); };
}

async function selectSession(sessionId, workspace) {
  currentSession = sessionId;
  el("chat").innerHTML = "";
  document.querySelectorAll("#sesslist li").forEach((li) =>
    li.classList.toggle("active", li.dataset.id === sessionId));
  setWs("加载历史…");
  try {
    const row = await api("/session/history", { method: "POST",
      body: JSON.stringify({ sessionId, cwd: workspace || undefined }) });
    (row.updates || []).forEach(renderUpdate);
    if (row.modeId) el("modeSel").value = row.modeId;
    setWs("会话 " + sessionId, "ok");
  } catch (err) { setWs("加载失败：" + err.message, "err"); return; }
  openStream(sessionId);
}

async function refreshSessions() {
  try { const row = await api("/sessions");
    const ul = el("sesslist"); ul.innerHTML = "";
    (row.sessions || []).forEach((s) => {
      const li = document.createElement("li"); li.dataset.id = s.sessionId;
      li.innerHTML = "<div class='t'>" + enc(s.title || s.sessionId) +
        "</div><div class='m'>" + enc(s.updatedAt || "") + "</div>";
      li.onclick = () => selectSession(s.sessionId, s.cwd);
      if (s.sessionId === currentSession) li.classList.add("active");
      ul.appendChild(li);
    });
  } catch (err) { setWs(err.message, "err"); }
}

async function send() {
  const text = el("input").value.trim();
  if (!text || streaming) return;
  if (!currentSession) {
    try { const row = await api("/session/new", { method: "POST", body: "{}" });
      currentSession = row.sessionId; await refreshSessions();
      el("chat").innerHTML = ""; openStream(currentSession);
      setWs("会话 " + currentSession, "ok");
    } catch (err) { setWs(err.message, "err"); return; }
  }
  el("input").value = ""; addMsg("user", text);
  streaming = true; setBusy(true); setWs("Agent 运行中…", "ok");
  try {
    await api("/session/prompt", { method: "POST",
      body: JSON.stringify({ sessionId: currentSession, text }) });
    setWs("回合完成", "ok");
  } catch (err) { setWs(err.message, "err"); }
  finally { streaming = false; setBusy(false); refreshSessions(); }
}

function init() {
  el("newBtn").onclick = () => { currentSession = null; el("chat").innerHTML = "";
    stopStream(); document.querySelectorAll("#sesslist li")
      .forEach((li) => li.classList.remove("active")); setWs("新会话（发送即创建）"); };
  el("reloadBtn").onclick = refreshSessions;
  el("sendBtn").onclick = send;
  el("cancelBtn").onclick = async () => { if (currentSession)
    api("/session/cancel", { method: "POST",
      body: JSON.stringify({ sessionId: currentSession }) }).catch(() => undefined); };
  el("modeSel").onchange = async () => { if (!currentSession) return;
    api("/session/set_mode", { method: "POST", body: JSON.stringify(
      { sessionId: currentSession, modeId: el("modeSel").value }) }).catch(() => undefined); };
  el("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  api("/health").then((h) => setWs("FreeSeek " + (h.version || "") + " · " +
    (h.workspace || ""), "ok")).catch((err) => setWs(err.message, "err"));
  refreshSessions();
}
if (token) init();
</script>
</body>
</html>`;
}
