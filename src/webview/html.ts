// check:max-lines 1100
import * as vscode from "vscode";

/**
 * 构建聊天 Webview 的完整 HTML 模板（从 extension.ts 的 getHtml 拆分而来，减少主文件体积）。
 * 动态注入仅 4 处：csp / nonce / scriptUri / mermaidUri，其余为静态 HTML/CSS/JS。
 * 注意：本文件为纯模板，无业务逻辑；新增内嵌面板/样式时优先加在这里。
 */
export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview.js"));
  const mermaidUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "mermaid.js"));
  const nonce = Date.now().toString(36);
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} data: https:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FreeSeek</title>
<style>
  :root {
    color-scheme: light dark;
    --radius: 10px;
    --radius-sm: 6px;
    /* FreeSeek 语义色 token（对齐 codex styles.md：主色/成功/警告/错误/中性语义，
       全部映射到 VS Code 主题变量，主题切换自动跟随；新增组件一律引用这些 token） */
    --fs-accent: var(--vscode-textLink-foreground, #4daafc);
    --fs-ok: var(--vscode-charts-green, #3fb950);
    --fs-warn: var(--vscode-charts-yellow, #d29922);
    --fs-err: var(--vscode-charts-red, #f85149);
    --fs-fg-muted: var(--vscode-descriptionForeground, #9da5b4);
    --fs-border: var(--vscode-panel-border, rgba(127,127,127,.25));
    --fs-border-strong: var(--vscode-editorWidget-border, var(--fs-border-strong));
    --fs-bg-soft: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft));
    --fs-bg-hover: var(--vscode-toolbar-hoverBackground, var(--fs-bg-hover));
    --fs-bg-strong: var(--vscode-badge-background, var(--fs-bg-strong));
  }

  /* ── 主题风格：body[data-theme] 覆盖核心变量实现多套皮肤。
     default 不设 data-theme，完全跟随 VS Code 编辑器主题；其余主题独立配色，
     通过覆盖 --vscode-* 变量让所有引用自动生效（含 --fs-* token 的嵌套解析）。 ── */

  /* 原神风格：暖米金、柔和圆润 */
  body[data-theme="genshin"] {
    color-scheme: light;
    --vscode-editor-background: #fbf7ef;
    --vscode-foreground: #4a3f33;
    --vscode-descriptionForeground: #8a7b66;
    --vscode-sideBar-background: #f5efe3;
    --vscode-titleBar-inactiveBackground: #f0e8d6;
    --vscode-panel-border: #e7dcc3;
    --vscode-editorWidget-border: #d9cba8;
    --vscode-focusBorder: #d4a13c;
    --vscode-button-background: #d4a13c;
    --vscode-button-foreground: #fffdf8;
    --vscode-button-secondaryBackground: #f0e7d4;
    --vscode-button-secondaryForeground: #6b5a41;
    --vscode-badge-background: #d4a13c;
    --vscode-badge-foreground: #fffdf8;
    --vscode-input-background: #fffdf8;
    --vscode-input-foreground: #4a3f33;
    --vscode-input-border: #e7dcc3;
    --vscode-textLink-foreground: #b8842a;
    --vscode-charts-green: #6f9a4e;
    --vscode-charts-yellow: #d4a13c;
    --vscode-charts-red: #c25b45;
    --vscode-charts-blue: #5a8fae;
    --vscode-errorForeground: #c25b45;
    --vscode-inputValidation-errorBackground: #fbe9e3;
    --vscode-inputValidation-errorBorder: #d98a72;
    --vscode-inputValidation-errorForeground: #a03c2c;
    --vscode-editor-inactiveSelectionBackground: #f3ead6;
    --vscode-toolbar-hoverBackground: #eee3cc;
    --vscode-symbolIcon-keywordForeground: #a87f2c;
    --vscode-font-family: "Yuanti SC", "YouYuan", "Microsoft YaHei", "PingFang SC", sans-serif;
    --vscode-editor-font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  }
  body[data-theme="genshin"] #topbar { border-bottom:1px solid #d9cba8; }
  body[data-theme="genshin"] .msg.assistant .avatar {
    background: linear-gradient(135deg, #e8c66b, #b8842a);
  }
  body[data-theme="genshin"] .welcome h2 { color: #8a6d23; }

  /* 鸣潮风格：黑金冷冽、锐利切割 */
  body[data-theme="wuthering"] {
    color-scheme: dark;
    --radius: 4px;
    --radius-sm: 2px;
    --vscode-editor-background: #0d0f12;
    --vscode-foreground: #d7dbe0;
    --vscode-descriptionForeground: #8f98a3;
    --vscode-sideBar-background: #14171b;
    --vscode-titleBar-inactiveBackground: #181c22;
    --vscode-panel-border: #2a2f36;
    --vscode-editorWidget-border: #39404a;
    --vscode-focusBorder: #c9a227;
    --vscode-button-background: #c9a227;
    --vscode-button-foreground: #101210;
    --vscode-button-secondaryBackground: #1e232a;
    --vscode-button-secondaryForeground: #b8bec6;
    --vscode-badge-background: #c9a227;
    --vscode-badge-foreground: #101210;
    --vscode-input-background: #171a1f;
    --vscode-input-foreground: #d7dbe0;
    --vscode-input-border: #2a2f36;
    --vscode-textLink-foreground: #d4b34a;
    --vscode-charts-green: #3fa06b;
    --vscode-charts-yellow: #c9a227;
    --vscode-charts-red: #d2504a;
    --vscode-charts-blue: #4a8fd4;
    --vscode-errorForeground: #d2504a;
    --vscode-inputValidation-errorBackground: #3a1d1a;
    --vscode-inputValidation-errorBorder: #8a4a40;
    --vscode-inputValidation-errorForeground: #e8a79f;
    --vscode-editor-inactiveSelectionBackground: #1b2027;
    --vscode-toolbar-hoverBackground: #20252d;
    --vscode-symbolIcon-keywordForeground: #c9a227;
    --vscode-font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
    --vscode-editor-font-family: "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  }
  body[data-theme="wuthering"] #topbar { border-bottom:1px solid #c9a227; }
  body[data-theme="wuthering"] .msg.assistant .avatar {
    background: linear-gradient(135deg, #c9a227, #1c1f24);
    border:1px solid #c9a227;
  }
  body[data-theme="wuthering"] .welcome h2 { color: #c9a227; }

  /* 学术风格：纸白衬线、墨色沉静 */
  body[data-theme="academic"] {
    color-scheme: light;
    --radius: 2px;
    --radius-sm: 1px;
    --vscode-editor-background: #faf8f3;
    --vscode-foreground: #2b2b2b;
    --vscode-descriptionForeground: #5f5b53;
    --vscode-sideBar-background: #f2efe8;
    --vscode-titleBar-inactiveBackground: #ece8df;
    --vscode-panel-border: #d8d2c5;
    --vscode-editorWidget-border: #c6bfae;
    --vscode-focusBorder: #1f4e79;
    --vscode-button-background: #1f4e79;
    --vscode-button-foreground: #fdfdfb;
    --vscode-button-secondaryBackground: #e9e4da;
    --vscode-button-secondaryForeground: #3c3a36;
    --vscode-badge-background: #1f4e79;
    --vscode-badge-foreground: #fdfdfb;
    --vscode-input-background: #fffdf9;
    --vscode-input-foreground: #2b2b2b;
    --vscode-input-border: #d8d2c5;
    --vscode-textLink-foreground: #1f4e79;
    --vscode-charts-green: #3f7a4e;
    --vscode-charts-yellow: #b08a3e;
    --vscode-charts-red: #a0403a;
    --vscode-charts-blue: #1f4e79;
    --vscode-errorForeground: #a0403a;
    --vscode-inputValidation-errorBackground: #f5e7e3;
    --vscode-inputValidation-errorBorder: #c99a90;
    --vscode-inputValidation-errorForeground: #8a2f2a;
    --vscode-editor-inactiveSelectionBackground: #efece4;
    --vscode-toolbar-hoverBackground: #e7e2d6;
    --vscode-symbolIcon-keywordForeground: #1f4e79;
    --vscode-font-family: Georgia, "Songti SC", "STSong", "SimSun", serif;
    --vscode-editor-font-family: "Courier New", "SimSun", monospace;
  }
  body[data-theme="academic"] #topbar { border-bottom:1px solid #c6bfae; }
  body[data-theme="academic"] .msg.assistant .avatar {
    background: linear-gradient(135deg, #2f6d9e, #1f4e79);
  }
  body[data-theme="academic"] .welcome h2 { color: #1f4e79; letter-spacing:.02em; }

  /* 工业风格：钢灰、安全橙、方正硬朗 */
  body[data-theme="industrial"] {
    color-scheme: dark;
    --radius: 0px;
    --radius-sm: 0px;
    --vscode-editor-background: #1a1d21;
    --vscode-foreground: #c9ced3;
    --vscode-descriptionForeground: #8a9097;
    --vscode-sideBar-background: #14171a;
    --vscode-titleBar-inactiveBackground: #1e2227;
    --vscode-panel-border: #34393f;
    --vscode-editorWidget-border: #454b52;
    --vscode-focusBorder: #f08c2e;
    --vscode-button-background: #f08c2e;
    --vscode-button-foreground: #131517;
    --vscode-button-secondaryBackground: #202428;
    --vscode-button-secondaryForeground: #b6bcc2;
    --vscode-badge-background: #f08c2e;
    --vscode-badge-foreground: #131517;
    --vscode-input-background: #1f2328;
    --vscode-input-foreground: #c9ced3;
    --vscode-input-border: #34393f;
    --vscode-textLink-foreground: #7fb3e0;
    --vscode-charts-green: #6fae5f;
    --vscode-charts-yellow: #e3a22e;
    --vscode-charts-red: #d85a4a;
    --vscode-charts-blue: #7fb3e0;
    --vscode-errorForeground: #d85a4a;
    --vscode-inputValidation-errorBackground: #3a201d;
    --vscode-inputValidation-errorBorder: #8a5048;
    --vscode-inputValidation-errorForeground: #eaa79b;
    --vscode-editor-inactiveSelectionBackground: #22262c;
    --vscode-toolbar-hoverBackground: #262b31;
    --vscode-symbolIcon-keywordForeground: #e3a22e;
    --vscode-font-family: "Segoe UI", "Arial", "Microsoft YaHei", sans-serif;
    --vscode-editor-font-family: "Cascadia Mono", "Consolas", monospace;
  }
  body[data-theme="industrial"] #topbar { border-bottom:2px solid #f08c2e; }
  body[data-theme="industrial"] .msg.assistant .avatar {
    background: linear-gradient(135deg, #f08c2e, #464b52);
    border-radius: 0;
  }
  body[data-theme="industrial"] .welcome h2 { color: #f08c2e; letter-spacing:.05em; }
  body[data-theme="industrial"] #modelChip, body[data-theme="industrial"] .mode-btn {
    font-family: var(--vscode-editor-font-family);
  }

  /* 语义色工具类：全部映射 --fs-* token，新增组件一律优先引用 */
  .fs-ok { color: var(--fs-ok); }
  .fs-warn { color: var(--fs-warn); }
  .fs-err { color: var(--fs-err); }
  .fs-accent { color: var(--fs-accent); }
  .fs-muted { color: var(--fs-fg-muted); }
  * { box-sizing: border-box; }
  html, body { margin:0; padding:0; height:100%; overflow:hidden; }
  body { font-family: var(--vscode-font-family, system-ui, -apple-system, BlinkMacSystemFont); font-size: 13px;
    background: var(--vscode-editor-background); color: var(--vscode-foreground); display:flex; flex-direction:column; }

  /* ── Top bar ── */
  #topbar { display:flex; gap:6px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    /* 注意：这里不要用 overflow-x:auto！它会把向下弹出的模型/会话下拉菜单（.dropdown-menu）裁剪掉，导致菜单被挡住。
       topbar 本身必须允许下拉溢出显示。 */
    min-width:0; }
  #topbar::-webkit-scrollbar { display:none; }
  /* 紧凑模式（窄侧边栏，由 JS ResizeObserver 检测宽度后添加）：按钮只留图标，隐藏文字/次要元素，避免遮挡 */
  body.tb-compact #topbar { gap:2px; padding:8px 6px; }
  body.tb-compact #topbar .tb-btn { font-size:0; gap:0; padding:4px; }
  body.tb-compact #topbar .tb-btn .ic { margin:0; }
  body.tb-compact #sessionDropdown { max-width:100px; }
  body.tb-compact #modelChip { max-width:80px; }
  body.tb-compact #sandboxChip { display:none; }
  .session-dropdown { position:relative; flex:1; min-width:80px; max-width:300px; }
  .session-dropdown-btn { width:100%; justify-content:space-between; border:1px solid var(--vscode-panel-border); }
  .session-dropdown-btn .ic { width:12px; height:12px; transition: transform .12s ease; }
  .session-dropdown.open .session-dropdown-btn .ic { transform: rotate(180deg); }
  .session-dropdown-menu .dropdown-item { display:flex; gap:8px; align-items:center; }
  .session-dropdown-menu .dropdown-item .dot { width:6px; height:6px; border-radius:50%; background:var(--vscode-textLink-foreground); opacity:0; flex:none; }
  .session-dropdown-menu .dropdown-item.active .dot { opacity:1; }
  .tb-btn, #sbToggleOpen { background:transparent; color:var(--vscode-foreground); border:1px solid transparent;
    border-radius: var(--radius-sm); padding:4px 8px; font-size:12px; cursor:pointer; line-height:1.4; white-space:nowrap;
    display:inline-flex; align-items:center; gap:4px; }
  .tb-btn:hover, #sbToggleOpen:hover { background: var(--vscode-toolbar-hoverBackground, var(--fs-bg-hover)); }
  #modelChip { max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; cursor:pointer;
    background: var(--vscode-button-secondaryBackground, transparent); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding:4px 9px; font-size:12px; line-height:1.4;
    display:inline-flex; align-items:center; gap:5px; }
  #modelChip:hover { filter:brightness(1.08); }
  /* Plan / Ask / Craft 三段式模式切换（对齐 CodeBuddy） */
  #modeSeg { display:inline-flex; align-items:center; gap:2px; background: var(--vscode-editor-background);
    border:1px solid var(--vscode-panel-border); border-radius:8px; padding:2px; flex:none; }
  .mode-btn { background:transparent; border:none; color: var(--vscode-descriptionForeground); font-size:11px;
    line-height:1.4; padding:2px 8px; border-radius:6px; cursor:pointer; transition: background .12s ease, color .12s ease; }
  .mode-btn:hover { background: var(--vscode-toolbar-hoverBackground, rgba(127,127,127,.14)); }
  .mode-btn.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); font-weight:600; }
  .mode-btn.coder { border:1px dashed color-mix(in srgb, var(--vscode-button-background) 55%, transparent); color: var(--vscode-button-background); font-weight:600; }
  .mode-btn.coder:hover { background: color-mix(in srgb, var(--vscode-button-background) 12%, transparent); }
  .mode-btn.coder.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-style:solid; }
  #jumpBottom { position:sticky; bottom:10px; align-self:flex-end; width:32px; height:32px; flex:none; border-radius:50%;
    border:1px solid var(--vscode-panel-border); background: var(--vscode-editor-background, var(--vscode-sideBar-background));
    color: var(--vscode-descriptionForeground); font-size:15px; line-height:1; cursor:pointer; display:none; align-items:center; justify-content:center;
    box-shadow:0 2px 8px rgba(0,0,0,.22); transition: transform .12s ease, background .12s ease; z-index:5; }
  #jumpBottom.show { display:inline-flex; }
  #jumpBottom:hover { background: var(--vscode-toolbar-hoverBackground, var(--fs-bg-strong)); transform: translateY(-1px); }
  #quoteToChat { position:fixed; z-index:999; display:none; align-items:center; gap:4px; white-space:nowrap;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border:none; border-radius:14px; padding:5px 11px; font-size:11.5px; font-weight:600; cursor:pointer;
    box-shadow:0 2px 10px rgba(0,0,0,.32); }
  #quoteToChat.show { display:inline-flex; }
  #quoteToChat:hover { filter: brightness(1.12); }
  .quote-chip { border-style:dashed; border-color: var(--vscode-button-background); }
  #sandboxChip { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); cursor:default;
    border-radius:10px; padding:2px 8px; font-size:11px; white-space:nowrap; display:inline-flex; align-items:center; gap:4px; }
  #sessionTitle { font-weight:600; font-size:12px; color: var(--vscode-foreground); white-space:nowrap; overflow:hidden;
    text-overflow:ellipsis; flex:1; min-width:0; }

  /* 内联 SVG 图标 + 上下文 chips；图标笔触风格随主题（--ic-* 由各 data-theme 覆盖） */
  :root { --ic-w:1.8; --ic-cap:round; --ic-join:round; }
  body[data-theme="genshin"] { --ic-w:2.2; --ic-cap:round; --ic-join:round; }
  body[data-theme="wuthering"] { --ic-w:1.6; --ic-cap:square; --ic-join:miter; }
  body[data-theme="academic"] { --ic-w:1.2; --ic-cap:square; --ic-join:miter; }
  body[data-theme="industrial"] { --ic-w:2; --ic-cap:square; --ic-join:miter; }
  .ic { width:14px; height:14px; flex:none; stroke-width:var(--ic-w); stroke-linecap:var(--ic-cap); stroke-linejoin:var(--ic-join); }
  .tb-ic { display:inline-flex; align-items:center; justify-content:center; }
  #modelLabel { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #ctxChips { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
  .ctx-chip { display:inline-flex; align-items:center; gap:6px; max-width:100%;
    background: var(--vscode-badge-background, rgba(127,127,127,.16)); color: var(--vscode-foreground);
    border:1px solid var(--vscode-panel-border); border-radius:14px; padding:3px 5px 3px 10px; font-size:11.5px; }
  .ctx-chip .ctx-name { font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:240px; }
  .ctx-chip .ctx-tag { font-size:10px; opacity:.85; white-space:nowrap; }
  .ctx-chip .ctx-x { cursor:pointer; border:none; background:transparent; color:inherit; font-size:14px; line-height:1;
    padding:0 3px; border-radius:50%; }
  .ctx-chip .ctx-x:hover { background: rgba(127,127,127,.28); }

  /* ── Messages ── */
  #messages { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:10px; position:relative; }
  /* CodeBuddy 风格内嵌面板：任务列表 + 文件列表（常驻在 messages 上方） */
  #inlinePanels { display:flex; gap:8px; padding:8px 12px 0; min-width:0; }
  .ipanel { flex:1; min-width:0; border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm);
    background: var(--vscode-sideBar-background, var(--vscode-editor-background)); overflow:hidden; }
  .ipanel-h { display:flex; justify-content:space-between; align-items:center; padding:6px 10px;
    font-size:12px; font-weight:600; color: var(--vscode-descriptionForeground); cursor:pointer; user-select:none;
    background: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft)); list-style:none; }
  .ipanel-h::marker, .ipanel-h::-webkit-details-marker { display:none; }
  .ipanel[open] .ipanel-h { border-bottom:1px solid var(--vscode-panel-border); }
  .ipanel-title { display:inline-flex; align-items:center; gap:5px; }
  .ipanel-meta { font-size:11px; opacity:.85; font-weight:400; }
  .ipanel-body { padding:6px 10px 8px; max-height:200px; overflow-y:auto; }
  .ipanel-body .ipanel-empty { font-size:11.5px; color: var(--vscode-descriptionForeground); padding:6px 0; text-align:center; opacity:.7; }
  .ipanel-row { display:flex; align-items:center; gap:8px; padding:4px 0; font-size:12px; min-width:0; }
  .ipanel-row .ipanel-icon { width:14px; text-align:center; opacity:.75; flex:none; }
  .ipanel-row .ipanel-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ipanel-row .ipanel-stat { font-family: var(--vscode-editor-font-family, monospace); font-size:11px; flex:none; }
  .ipanel-row .ipanel-stat .add { color: var(--fs-ok); }
  .ipanel-row .ipanel-stat .del { color: var(--fs-err); }
  .ipanel-row .ipanel-meta { font-size:11px; opacity:.8; }
  .ipanel-row.completed .ipanel-text { opacity:.55; text-decoration:line-through; }
  .ipanel-row.in_progress .ipanel-text { font-weight:600; color: var(--fs-accent); }
  .ipanel-row.blocked .ipanel-text { color: var(--fs-err); }
  .ipanel-row.paused .ipanel-text, .ipanel-row.pending .ipanel-text { color: var(--fs-fg-muted); }
  .welcome { align-self:center; color: var(--vscode-descriptionForeground); text-align:center; margin:auto 0; padding:24px 16px; width:100%; }
  .welcome-card { max-width:440px; margin:0 auto; padding:28px 24px 32px; border-radius:18px;
    background: linear-gradient(180deg, var(--vscode-input-background, rgba(255,255,255,.04)) 0%, transparent 100%);
    border: 1px solid var(--vscode-panel-border); box-shadow: 0 8px 28px rgba(0,0,0,.12); }
  .welcome-logo { font-size:0; line-height:0; margin-bottom:16px; filter: drop-shadow(0 2px 10px rgba(0,0,0,.18)); }
  .welcome-logo svg { width:64px; height:64px; display:none; }
  body:not([data-theme]) .welcome-logo .lg-d,
  body[data-theme="genshin"] .welcome-logo .lg-g,
  body[data-theme="wuthering"] .welcome-logo .lg-w,
  body[data-theme="academic"] .welcome-logo .lg-a,
  body[data-theme="industrial"] .welcome-logo .lg-i { display:block; }
  .welcome h2 { margin:0 0 6px; font-size:24px; font-weight:800; color: var(--vscode-foreground); letter-spacing:-.5px; }
  .welcome-subtitle { margin:0 0 14px; font-size:13.5px; color: var(--vscode-descriptionForeground); }
  .welcome-tips { display:flex; flex-wrap:wrap; gap:8px; justify-content:center; align-items:center; margin-bottom:22px; font-size:12px; color: var(--vscode-descriptionForeground); }
  .welcome-tips span { display:inline-flex; align-items:center; gap:4px; }
  .welcome-tips kbd { background: var(--vscode-textCodeBlock-background); border:1px solid var(--vscode-panel-border);
    border-radius:4px; padding:1px 5px; font-family: var(--vscode-font-family); font-size:11px; }
  .welcome-suggestions { display:flex; flex-wrap:wrap; gap:10px; justify-content:center; }
  .suggestion { display:inline-flex; align-items:center; gap:7px; background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground); border:1px solid var(--vscode-panel-border);
    border-radius:14px; padding:9px 15px; font-size:12.5px; cursor:pointer; transition: all .18s; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
  .suggestion:hover { filter:brightness(1.12); transform: translateY(-1px); box-shadow: 0 4px 12px rgba(0,0,0,.15); border-color: var(--vscode-focusBorder); }
  .suggestion .sg-icon { font-size:14px; line-height:1; }
  .suggestion .sg-text { white-space:nowrap; }
  .msg { max-width:92%; display:flex; flex-direction:column; gap:3px; animation: fadeIn .18s ease; }
  @keyframes fadeIn { from { opacity:0; transform: translateY(6px);} to { opacity:1; transform:none;} }
  .msg.user { align-self:flex-end; max-width:85%; }
  .msg.user .bubble { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-radius:14px; border-bottom-right-radius:5px; padding:8px 13px; white-space:pre-wrap; word-break:break-word; line-height:1.6;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .msg.assistant { align-self:flex-start; max-width:96%; }
  .msg.assistant .header { display:flex; align-items:center; gap:8px; font-weight:600; font-size:12px; color: var(--vscode-descriptionForeground); margin-bottom:3px; }
  .msg.assistant .avatar { width:22px; height:22px; border-radius:50%; background: linear-gradient(135deg, var(--vscode-textLink-foreground), var(--vscode-button-background)); color:#fff;
    display:flex; align-items:center; justify-content:center; font-size:12px; box-shadow: 0 1px 3px rgba(0,0,0,.15); }
  .msg.assistant .avatar svg { width:13px; height:13px; display:none; }
  body:not([data-theme]) .msg.assistant .avatar .lg-d,
  body[data-theme="genshin"] .msg.assistant .avatar .lg-g,
  body[data-theme="wuthering"] .msg.assistant .avatar .lg-w,
  body[data-theme="academic"] .msg.assistant .avatar .lg-a,
  body[data-theme="industrial"] .msg.assistant .avatar .lg-i { display:block; }
  .msg.assistant .bubble { background: var(--vscode-editor-inactiveSelectionBackground);
    border:1px solid var(--fs-border); border-radius:14px; border-top-left-radius:5px;
    padding:9px 14px; white-space:normal; word-break:break-word; line-height:1.65;
    box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .msg.assistant.error .bubble { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground);
    border-color: var(--vscode-inputValidation-errorBorder); }
  .msg-actions { display:flex; gap:6px; margin-top:5px; opacity:0; transition:opacity .15s; }
  .msg:hover .msg-actions { opacity:1; }
  .msg-actions .act { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:1px solid var(--vscode-panel-border);
    border-radius: var(--radius-sm); padding:3px 10px; font-size:11px; cursor:pointer; transition: all .12s; }
  .msg-actions .act:hover { filter:brightness(1.1); transform: translateY(-1px); }

  /* 原位置编辑用户消息 */
  .msg.user .bubble.editing { display:flex; flex-direction:column; gap:6px; }
  .edit-ta { width:100%; min-height:70px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); padding:6px 8px;
    font-family: inherit; font-size:12.5px; resize:vertical; box-sizing:border-box; }
  .edit-btns { display:flex; gap:8px; justify-content:flex-end; }
  .edit-btns button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding:4px 12px; font-size:12px; cursor:pointer; transition:filter .12s; }
  .edit-btns button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .edit-btns button:hover { filter:brightness(1.1); }

  /* Reasoning（思考过程折叠块） */
  .reasoning { margin:2px 0 4px; border:1px solid var(--vscode-panel-border); border-left:3px solid var(--vscode-textLink-foreground);
    border-radius: var(--radius-sm); background: var(--vscode-editor-background); overflow:hidden; }
  .reasoning summary { cursor:pointer; padding:4px 8px; font-size:12px; color: var(--vscode-descriptionForeground); user-select:none; }
  .reasoning .reasoning-body { padding:5px 9px; font-size:12px; color: var(--vscode-descriptionForeground);
    white-space:pre-wrap; word-break:break-word; border-top:1px solid var(--vscode-panel-border); max-height:280px; overflow:auto; }

  /* Markdown 内容排版 —— 规范间距（段落分明、层级清晰，对齐 CodeBuddy / Claude Code） */
  .bubble > :first-child { margin-top:0; }
  .bubble > :last-child { margin-bottom:0; }
  .bubble .round-text { white-space:normal; } /* 渲染后 HTML 节点间的换行符不显示，避免列表/表格间产生多余空行 */
  .bubble p { margin:3px 0 9px; }
  .bubble p:empty { display:none; }
  .bubble h1, .bubble h2, .bubble h3, .bubble h4, .bubble h5, .bubble h6 { font-weight:700; line-height:1.3; margin:16px 0 7px; }
  .bubble h1 { font-size:18px; } .bubble h2 { font-size:16px; } .bubble h3 { font-size:14.5px; } .bubble h4 { font-size:13.5px; }
  .bubble h5 { font-size:13px; } .bubble h6 { font-size:12.5px; }
  .bubble ul, .bubble ol { margin:4px 0 10px; padding-left:22px; }
  .bubble li { margin:3px 0; }
  .bubble li > p { margin:2px 0; }
  .bubble li > ul, .bubble li > ol { margin:3px 0; }
  .bubble blockquote { margin:8px 0 10px; padding:6px 12px; border-left:3px solid var(--vscode-textLink-foreground);
    color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background, var(--fs-bg-soft));
    border-radius:0 var(--radius-sm) var(--radius-sm) 0; }
  .bubble blockquote p:last-child { margin-bottom:2px; }
  .bubble a { color: var(--vscode-textLink-foreground); }
  .bubble table { border-collapse:collapse; margin:8px 0 10px; width:100%; font-size:12.5px; }
  .bubble th, .bubble td { border:1px solid var(--fs-border); padding:5px 10px; text-align:left; }
  .bubble th { background: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft)); font-weight:600; }
  .bubble hr { border:none; border-top:1px solid var(--fs-border); margin:12px 0; }
  code { font-family: var(--vscode-editor-font-family, monospace); font-size:11.5px;
    background: var(--vscode-textCodeBlock-background, var(--fs-bg-hover)); padding:1px 4px; border-radius:4px; }
  pre { margin:8px 0 10px; }

  /* 代码块（语言标签 + 复制按钮） */
  .code-block { position:relative; border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); overflow:hidden;
    background: var(--vscode-textCodeBlock-background, var(--fs-bg-soft)); }
  .code-bar { display:flex; align-items:center; justify-content:space-between; padding:4px 8px;
    background: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft)); border-bottom:1px solid var(--vscode-panel-border); }
  .code-lang { font-size:11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
  .code-copy { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none;
    border-radius: var(--radius-sm); padding:2px 9px; font-size:11px; cursor:pointer; }
  .code-copy:hover { filter:brightness(1.1); }
  .code-block > pre { margin:0; }
  .code-block code { display:block; padding:10px 12px; overflow:auto; max-height:380px; white-space:pre; word-break:normal;
      background:transparent; color: var(--vscode-editor-foreground); }

  /* 语法高亮（highlight.js）：对齐 VS Code 默认 Light+/Dark+ 配色 */
  .code-block code.hljs, .code-block code.hljs * { background: transparent !important; color: var(--vscode-editor-foreground) !important; }
  .hljs { color: var(--vscode-editor-foreground); }
  .hljs-comment, .hljs-quote { color: #6A9955; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name, .hljs-tag { color: #569CD6; }
  .hljs-string, .hljs-title.class_, .hljs-attr, .hljs-template-tag, .hljs-addition, .hljs-meta .hljs-string { color: #CE9178; }
  .hljs-number, .hljs-literal, .hljs-type, .hljs-class .hljs-title, .hljs-bullet { color: #B5CEA8; }
  .hljs-title.function_, .hljs-section, .hljs-title { color: #DCDCAA; }
  .hljs-attribute, .hljs-property, .hljs-variable, .hljs-params { color: #9CDCFE; }
  .hljs-meta, .hljs-symbol, .hljs-regexp, .hljs-link, .hljs-selector-attr, .hljs-selector-pseudo { color: #D4D4D4; }
  .hljs-deletion { color: #f14c4c; }
  .hljs-emphasis { font-style: italic; }
  .hljs-strong { font-weight: 600; }
  @media (prefers-color-scheme: light) {
    .hljs { color: #1F1F1F; }
    .hljs-comment, .hljs-quote { color: #008000; }
    .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-name, .hljs-tag { color: #0000FF; }
    .hljs-string, .hljs-title.class_, .hljs-attr, .hljs-addition { color: #A31515; }
    .hljs-number, .hljs-literal, .hljs-type, .hljs-class .hljs-title, .hljs-bullet { color: #098658; }
    .hljs-title.function_, .hljs-section, .hljs-title { color: #795E26; }
    .hljs-attribute, .hljs-property, .hljs-variable, .hljs-params { color: #001080; }
    .hljs-meta, .hljs-symbol, .hljs-regexp, .hljs-link { color: #1F1F1F; }
    .hljs-deletion { color: #f14c4c; }
  }

  /* 工具卡片 */
  .tool { border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); overflow:hidden; margin-top:4px; background: var(--vscode-editor-background); }
  .tool .tool-header { display:flex; align-items:center; gap:8px; padding:7px 10px; font-size:12px; font-weight:600; cursor:pointer; user-select:none;
    background: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft)); }
  .tool .tool-header::before { content:"▶"; font-size:9px; transition: transform .12s; }
  .tool[open] .tool-header::before { content:"▼"; }
  .tool .tool-body { padding:10px 12px; border-top:1px solid var(--vscode-panel-border); }
  .tool .tool-body pre { margin:0; white-space:pre-wrap; word-break:break-word; max-height:260px; overflow:auto; font-size:12px; }
  .tool.call { border-left:3px solid var(--vscode-textLink-foreground); }
  .tool.result { border-left:3px solid var(--vscode-charts-green, #3bb950); }
  .tool.subagent { border-left:3px solid var(--vscode-charts-purple, #b180d7); }

  /* 任务清单 */
  .msg.todos .bubble { padding:10px 14px; }
  .msg.todos .todolist { margin:6px 0 0; padding-left:18px; }
  .msg.todos .todolist li { margin:4px 0; }
  .msg.todos .todolist li.completed { opacity:.6; text-decoration:line-through; }
  .msg.todos .todolist li.in_progress { font-weight:600; color: var(--vscode-textLink-foreground); }

  /* 单回合气泡内的子块（合并气泡：同一回复统一在一个气泡里） */
  .msg.assistant.round .bubble { display:flex; flex-direction:column; gap:4px; }
  .msg.assistant.round .bubble .stream,
  .msg.assistant.round .bubble .round-text { display:block; }
  .msg.assistant.round .bubble .round-text { margin-bottom:2px; }
  .msg.assistant.round .stream.thinking { display:inline-flex; align-items:center; gap:6px; color: var(--vscode-descriptionForeground); font-size:12px; padding:1px 0; }
  .msg.assistant.round .stream.thinking::before { content:""; width:11px; height:11px; border:2px solid var(--vscode-descriptionForeground); border-top-color:transparent; border-radius:50%;
    animation: spin 1s linear infinite; }
  .msg.assistant.round .tool { margin-top:8px; }
  .round-todos { border:1px solid var(--fs-border); border-left:3px solid var(--fs-ok);
    border-radius: var(--radius-sm); padding:6px 10px; background: var(--vscode-editor-background); margin-top:6px; }
  .round-todos .todos-header { font-size:12px; font-weight:600; color: var(--vscode-descriptionForeground); margin-bottom:2px; }
  .round-todos .todolist { margin:0; padding-left:18px; }
  .round-todos .todolist li { margin:3px 0; font-size:12px; }
  .round-todos .todolist li.completed { opacity:.6; text-decoration:line-through; }
  .round-todos .todolist li.in_progress { font-weight:600; color: var(--vscode-textLink-foreground); }
  .round-notification { border:1px solid var(--vscode-panel-border); border-left:3px solid var(--vscode-textLink-foreground);
    border-radius: var(--radius-sm); padding:8px 12px; background: var(--vscode-editor-background); margin-top:6px; }
  .round-notification .notif-head { font-size:12px; font-weight:600; color: var(--vscode-descriptionForeground); margin-bottom:3px; }
  .round-notification .notif-body { font-size:12px; white-space:pre-wrap; word-break:break-word; }

  /* ask_user 独立提问弹窗（对齐 CodeBuddy / Claude Code AskUserQuestion：居中弹窗 + 可点击选项 + 确认/取消） */
  .ask-modal { width:460px; max-width:92vw; max-height:80vh; overflow-y:auto; }
  .ask-modal .ask-question { font-size:14px; font-weight:600; margin:2px 0 10px; white-space:pre-wrap; word-break:break-word; }
  .ask-options { display:flex; flex-direction:column; gap:8px; }
  .ask-option { display:flex; align-items:flex-start; gap:10px; text-align:left; width:100%;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); padding:9px 12px; font-size:12.5px; cursor:pointer; transition: all .12s; }
  .ask-option:hover { filter:brightness(1.08); border-color: var(--vscode-textLink-foreground); }
  .ask-option .ask-radio { flex:none; width:16px; height:16px; border:1.5px solid var(--vscode-checkbox-border, var(--vscode-panel-border));
    border-radius:50%; margin-top:1px; display:inline-flex; align-items:center; justify-content:center; color: var(--vscode-button-foreground); }
  .ask-option.multi .ask-radio { border-radius:4px; }
  .ask-option.selected { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: var(--vscode-button-background); }
  .ask-option.selected .ask-radio::after { content:"✓"; font-size:11px; line-height:1; }
  .ask-option .ask-option-main { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .ask-option .ask-option-label { font-size:12.5px; font-weight:600; }
  .ask-option .ask-option-desc { font-size:11px; opacity:.72; white-space:pre-wrap; word-break:break-word; }
  .ask-input { width:100%; box-sizing:border-box; min-height:72px; resize:vertical; font: inherit; font-size:12.5px;
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: var(--radius-sm); padding:8px 10px; }
  .ask-input:focus { outline:1px solid var(--vscode-focusBorder); }

  /* 子智能体 */
  .tool.subagent .sublog { margin-top:6px; border-left:2px solid var(--vscode-textLink-foreground); padding-left:8px; }
  .tool.subagent .subline { font-size:12px; opacity:.9; margin:3px 0; white-space:pre-wrap; word-break:break-word; }

  /* diff 卡片（红绿对照 + 接受/回滚） */
  .msg.diffcard { max-width:97%; }
  .diff-card { border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm); overflow:hidden;
    background: var(--vscode-editor-background); margin-top:4px; }
  .diff-card .diff-head { display:flex; align-items:center; gap:8px; padding:7px 10px; font-size:12px;
    background: var(--vscode-titleBar-inactiveBackground, var(--fs-bg-soft)); border-bottom:1px solid var(--vscode-panel-border); }
  .diff-card .diff-file { font-weight:600; font-family: var(--vscode-editor-font-family, monospace); word-break:break-all; }
  .diff-card .diff-badge { font-size:10px; padding:1px 6px; border-radius:9px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .diff-card .diff-stat { margin-left:auto; font-size:11px; font-family: var(--vscode-editor-font-family, monospace); white-space:nowrap; }
  .diff-card .diff-stat .add { color: var(--vscode-charts-green, #3bb950); }
  .diff-card .diff-stat .del { color: var(--vscode-charts-red, #f14c4c); }
  .diff-card pre { margin:0; padding:8px 10px; max-height:340px; overflow:auto; font-size:12px; line-height:1.5;
    font-family: var(--vscode-editor-font-family, monospace); white-space:pre; tab-size:2; }
  .diff-line { display:block; white-space:pre; }
  .diff-line.add { background: rgba(59,185,80,.16); color: var(--vscode-charts-green, #3bb950); }
  .diff-line.del { background: rgba(241,76,76,.16); color: var(--vscode-charts-red, #f14c4c); }
  .diff-line.hunk { color: var(--vscode-descriptionForeground); background: var(--vscode-textCodeBlock-background, var(--fs-bg-hover)); }
  .diff-line.ctx { color: var(--vscode-foreground); }
  .diff-actions { display:flex; gap:8px; padding:7px 10px; border-top:1px solid var(--vscode-panel-border); }
  .diff-actions .act { border:none; border-radius: var(--radius-sm); padding:5px 14px; font-size:12px; cursor:pointer; }
  .diff-actions .act.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .diff-actions .act.primary:hover { filter:brightness(1.08); }
  .diff-actions .act.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
  .diff-actions .act.danger:hover { filter:brightness(1.08); }
  .diff-state { padding:6px 10px; font-size:11px; border-top:1px solid var(--vscode-panel-border); }
  .diff-state.accepted { color: var(--vscode-charts-green, #3bb950); }
  .diff-state.reverted { color: var(--vscode-descriptionForeground); }
  .diff-state.failed { color: var(--vscode-inputValidation-errorForeground); background: var(--vscode-inputValidation-errorBackground); }

  /* 新技能沉淀待审核卡片 */
  .skill-distill .bubble { border-left:3px solid var(--vscode-charts-yellow, #e2c08d); padding-left:10px; }
  .skill-distill .sd-title { font-weight:600; font-size:13px; color: var(--vscode-foreground); margin-bottom:2px; }
  .skill-distill .sd-desc { font-size:12px; color: var(--vscode-descriptionForeground); margin:4px 0; line-height:1.4; }
  .skill-distill .sd-path { font-size:11px; font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground);
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:100%; margin:4px 0 8px; }
  .skill-distill .sd-actions { display:flex; gap:8px; }
  .skill-distill .sd-btn { border:none; border-radius: var(--radius-sm); padding:5px 14px; font-size:12px; cursor:pointer;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .skill-distill .sd-btn:hover:not(:disabled) { filter:brightness(1.08); }
  .skill-distill .sd-btn:disabled { opacity:.6; cursor:default; }

  /* 技能管理列表：分组折叠 + 卡片 */
  .skills-mgr { display:flex; flex-direction:column; gap:8px; margin:8px 0; }
  .sk-section { border:1px solid var(--vscode-panel-border, rgba(128,128,128,.25)); border-radius:8px; overflow:hidden; }
  .sk-section-summary { cursor:pointer; padding:8px 12px; background: var(--vscode-editor-inactiveSelectionBackground, rgba(128,128,128,.12));
    list-style:none; display:flex; align-items:center; justify-content:space-between; user-select:none; }
  .sk-section-summary::-webkit-details-marker { display:none; }
  .sk-section-summary::before { content:"▶"; font-size:10px; margin-right:8px; color: var(--vscode-foreground); opacity:.7; transition:transform .15s; }
  .sk-section[open] > .sk-section-summary::before { transform:rotate(90deg); }
  .sk-section-title { font-weight:600; font-size:13px; color: var(--vscode-foreground); }
  .sk-section-count { margin-left:auto; margin-right:8px; font-size:11px; min-width:18px; height:18px; border-radius:9px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); display:inline-flex; align-items:center; justify-content:center; padding:0 5px; }
  .sk-section-body { padding:8px; display:flex; flex-direction:column; gap:8px; background: var(--vscode-editor-background); }
  .sk-row { border:1px solid var(--vscode-panel-border, rgba(128,128,128,.2)); border-radius:6px; padding:10px 12px;
    display:flex; flex-direction:column; gap:8px; transition:border-color .15s, box-shadow .15s; }
  .sk-row:hover { border-color: var(--vscode-focusBorder, rgba(128,128,128,.5)); box-shadow:0 1px 3px rgba(0,0,0,.08); }
  .sk-top { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .sk-name { font-weight:600; font-size:13px; color: var(--vscode-foreground); word-break:break-all; }
  .sk-badge { font-size:10px; padding:2px 7px; border-radius:10px; font-weight:600; white-space:nowrap; }
  .sk-badge.pending { background: var(--vscode-charts-yellow, #e2c08d); color: #1e1e1e; }
  .sk-badge.active { background: var(--vscode-charts-green, #4ec9b0); color: #1e1e1e; }
  .sk-badge.builtin { background: var(--vscode-charts-blue, #569cd6); color: #fff; }
  .sk-desc { font-size:12px; color: var(--vscode-descriptionForeground); line-height:1.4; }
  .sk-triggers { font-size:11px; color: var(--vscode-symbolIcon-keywordForeground, var(--vscode-descriptionForeground)); }
  .sk-ops { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .sk-btn { border:1px solid var(--vscode-button-border, transparent); border-radius: var(--radius-sm); padding:4px 12px; font-size:12px; cursor:pointer;
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background)); color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground)); }
  .sk-btn:hover:not(:disabled) { filter:brightness(1.08); }
  .sk-btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .sk-btn.danger { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  .sk-hint { font-size:11px; color: var(--vscode-descriptionForeground); font-style:italic; }

  /* Composer */
  #composer { border-top:1px solid var(--vscode-panel-border); padding:10px 12px 12px; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); }
  .input-wrap { position:relative; display:flex; align-items:flex-end; gap:8px;
    background: var(--vscode-input-background); border:1px solid var(--vscode-input-border); border-radius:12px; padding:6px 8px; }
  .input-wrap:focus-within { border-color: var(--vscode-focusBorder); box-shadow:0 0 0 1px var(--vscode-focusBorder); }
  #input { flex:1; min-height:44px; max-height:220px; resize:none; background:transparent; color: var(--vscode-input-foreground);
    border:none; padding:6px 4px; font-family:inherit; font-size:13px; line-height:1.5; outline:none; }
  #send-inn { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none; border-radius:50%;
    width:32px; height:32px; display:flex; align-items:center; justify-content:center; cursor:pointer; flex-shrink:0; font-size:14px; }
  #send-inn .ic { width:16px; height:16px; }
  #send-inn .stop-ic { width:13px; height:13px; }
  #send-inn.running { background: var(--vscode-inputValidation-errorBackground, #f14c4c); color: var(--vscode-inputValidation-errorForeground, #fff); }
  /* 等待队列角标：Agent 回复中用户输入的文本会进入等待队列，角标提示已排队数量 */
  .queue-badge { flex:0 0 auto; align-self:center; margin-right:2px; padding:2px 8px; border-radius:10px;
    font-size:11px; line-height:1.4; white-space:nowrap; cursor:default;
    background: var(--vscode-badge-background, #3b82f6); color: var(--vscode-badge-foreground, #fff);
    opacity:.9; }
  #send-inn:disabled { opacity:.5; cursor:not-allowed; }
  #send-inn:not(:disabled):hover { filter:brightness(1.08); }
  #toolbar { display:flex; gap:8px; align-items:center; margin-top:8px; }
  #toolbar button { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border:none; border-radius: var(--radius-sm); padding:4px 10px; font-size:12px; cursor:pointer;
    display:inline-flex; align-items:center; gap:4px; }
  #toolbar button:hover { filter:brightness(1.1); }
  #toolbar button#stop { display:none; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #status { flex:1; font-size:11px; color: var(--vscode-descriptionForeground); min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .hint { font-size:11px; color: var(--vscode-descriptionForeground); opacity:.75; white-space:nowrap; }

  /* CodeBuddy 风格对话栏：对话模式 / 模型 / 上下文进度 横向一行 */
  #cbBar { display:flex; align-items:center; gap:6px; margin-top:6px; min-width:0; }
  /* composer 上方小工具条（CodeBuddy 风格：@ / 图片 / 文件 / 任务 / 导入 等图标按钮） */
  #composerToolbar { display:flex; align-items:center; gap:2px; padding:4px 4px 6px; min-width:0; }
  .cb-ic { background:transparent; color: var(--vscode-foreground); border:none; border-radius: var(--radius-sm);
    padding:4px 6px; cursor:pointer; display:inline-flex; align-items:center; justify-content:center; opacity:.7; }
  .cb-ic:hover { background: var(--vscode-toolbar-hoverBackground, var(--fs-bg-hover)); opacity:1; }
  .cb-btn { background: transparent; color: var(--vscode-foreground); border:1px solid var(--vscode-panel-border);
    border-radius:14px; padding:3px 10px; font-size:11.5px; cursor:pointer; display:inline-flex; align-items:center; gap:5px;
    white-space:nowrap; }
  .cb-btn:hover { background: var(--vscode-toolbar-hoverBackground, var(--fs-bg-hover)); }
  .cb-btn.active { outline:2px solid var(--vscode-textLink-foreground); outline-offset:-2px; }
  #cbBar #modelChip { max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600;
    background: transparent; color: var(--vscode-foreground); border:1px solid var(--vscode-panel-border);
    border-radius:14px; padding:3px 10px; font-size:11.5px; line-height:1.4; display:inline-flex; align-items:center; gap:5px; }
  #cbBar #modelChip:hover { background: var(--vscode-toolbar-hoverBackground, var(--fs-bg-hover)); }
  #cbBar #ctxState { cursor:default; }
  .cb-spacer { flex:1; }
  .thinking { display:inline-flex; align-items:center; gap:6px; }
  .thinking::after { content:""; width:12px; height:12px; border:2px solid var(--vscode-descriptionForeground); border-top-color:transparent; border-radius:50%;
    animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg);} }

  /* 流式光标（对标 Claude Code 打字光标） */
  .bubble.streaming::after { content:"▌"; display:inline-block; margin-left:1px; color: var(--vscode-textLink-foreground);
    animation: caretBlink 1.1s steps(1,end) infinite; vertical-align: text-bottom; }
  @keyframes caretBlink { 0%,49% { opacity:1; } 50%,100% { opacity:0; } }
  /* 流式阶段：文本尚未转 markdown，保留换行；渲染完成后由 .bubble 的 normal 接管 */
  .stream { display:block; white-space:pre-wrap; }

  /* 设置面板（内嵌 modal） */
  .set-row { display:flex; align-items:flex-start; gap:10px; padding:8px 0; border-bottom:1px solid var(--vscode-panel-border); }
  .set-row:last-of-type { border-bottom:none; }
  .set-row input[type=checkbox] { width:16px; height:16px; margin-top:2px; accent-color: var(--vscode-textLink-foreground); cursor:pointer; flex:none; }
  .set-text { flex:1; min-width:0; }
  .set-label { font-size:13px; font-weight:600; }
  .set-desc { font-size:11px; color: var(--vscode-descriptionForeground); margin-top:2px; line-height:1.4; }
  .set-select { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border);
    border-radius: var(--radius-sm); padding:5px 8px; font-size:12px; cursor:pointer; flex:none; }
  /* 数字输入 + 预设快捷下拉并排；输入框优先占宽，下拉固定窄列 */
  .set-input-wrap { display:flex; align-items:center; gap:6px; flex:none; }
  .set-number { width:110px; background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border:1px solid var(--vscode-input-border); border-radius: var(--radius-sm); padding:5px 8px; font-size:12px; }
  .set-number:focus { outline:1px solid var(--vscode-focusBorder); }
  .set-section-title { font-size:13px; font-weight:700; margin:14px 0 4px; color: var(--vscode-foreground);
    display:flex; align-items:center; gap:6px; }
  .set-section-title .ic { width:13px; height:13px; }
  /* 主题色块切换器 */
  .theme-swatches { display:flex; gap:8px; flex-wrap:wrap; }
  .theme-swatch { display:inline-flex; align-items:center; gap:6px; padding:6px 10px;
    border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm);
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    font-size:12px; cursor:pointer; transition: border-color .12s, box-shadow .12s, transform .12s; }
  .theme-swatch:hover { border-color: var(--vscode-focusBorder); transform: translateY(-1px); }
  .theme-swatch.active { border-color: var(--vscode-textLink-foreground); box-shadow: 0 0 0 1px var(--vscode-textLink-foreground); font-weight:600; }
  .theme-dot { width:14px; height:14px; border-radius:50%; display:inline-block; flex:none;
    border:1px solid rgba(127,127,127,.35); }
  .theme-label { white-space:nowrap; }
  .diff-line[data-line] { cursor:pointer; }
  .diff-line[data-line]:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.16)) !important; }

  /* 模型下拉菜单：position:fixed 由 JS 动态定位（避免被 topbar 裁剪 + 智能避开左侧主侧边栏） */
  .dropdown { position:relative; }
  .dropdown-menu { position:fixed; min-width:230px; max-width:320px; max-height:70vh; overflow-y:auto;
    background: var(--vscode-editor-background); border:1px solid var(--vscode-panel-border); border-radius: var(--radius-sm);
    box-shadow:0 8px 28px rgba(0,0,0,.45); z-index:2000; padding:6px; display:none; }
  .dropdown-menu.open { display:flex; flex-direction:column; gap:2px; }
  /* 输入框补全弹层（@提及文件 / /命令） */
  .autocomplete {
    position: fixed; z-index: 1200; display: none;
    background: var(--vscode-editorWidget-background, #fff);
    border: 1px solid var(--vscode-editorWidget-border, var(--fs-border-strong));
    border-radius: 8px; box-shadow: 0 6px 24px rgba(0,0,0,.18);
    max-height: 264px; overflow-y: auto; padding: 4px; box-sizing: border-box;
  }
  .ac-item {
    display: flex; justify-content: space-between; align-items: center; gap: 12px;
    padding: 6px 10px; border-radius: 6px; cursor: pointer;
    font-size: 13px; line-height: 1.4; color: var(--vscode-foreground);
    white-space: nowrap;
  }
  .ac-item.active, .ac-item:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.14)); }
  .ac-label { overflow: hidden; text-overflow: ellipsis; }
  .ac-hint { color: var(--vscode-descriptionForeground, #888); font-size: 12px; flex: none; }
  .ac-empty { padding: 8px 10px; color: var(--vscode-descriptionForeground, #888); font-size: 12px; }
  .dropdown-group { border-top:1px solid var(--vscode-panel-border); padding-top:4px; margin-top:4px; }
  .dropdown-group:first-child { border-top:none; padding-top:0; margin-top:0; }
  .dropdown-group-title { font-size:11px; color: var(--vscode-descriptionForeground); padding:3px 8px; font-weight:600;
    display:flex; align-items:center; justify-content:space-between; gap:6px; }
  .dropdown-group-title .dgt-text { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .dropdown-item-row { display:flex; align-items:center; gap:2px; }
  .dropdown-item { flex:1; min-width:0; display:block; width:100%; text-align:left; background:transparent; color: var(--vscode-foreground); border:none;
    border-radius: var(--radius-sm); padding:6px 8px; font-size:12px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .dropdown-item:hover { background: var(--vscode-list-hoverBackground, var(--fs-bg-hover)); }
  .dropdown-item.active { color: var(--vscode-textLink-foreground); font-weight:600; }
  .dropdown-item-row.active { background: var(--vscode-list-activeBackground, rgba(127,127,127,.10)); border-radius: var(--radius-sm); }
  .dropdown-del { flex:0 0 auto; width:20px; height:24px; line-height:1; background:transparent; border:none; cursor:pointer;
    color: var(--vscode-descriptionForeground); font-size:15px; border-radius: var(--radius-sm); }
  .dropdown-del:hover { background: var(--vscode-errorBackground, rgba(200,40,40,.18)); color: var(--vscode-errorForeground, #f44); }
  .dropdown-del-prov { flex:0 0 auto; width:22px; height:20px; line-height:1; background:transparent; border:none; cursor:pointer;
    color: var(--vscode-descriptionForeground); font-size:12px; border-radius: var(--radius-sm); }
  .dropdown-del-prov:hover { background: var(--vscode-errorBackground, rgba(200,40,40,.18)); color: var(--vscode-errorForeground, #f44); }
  .dropdown-footer { border-top:1px solid var(--vscode-panel-border); margin-top:4px; padding-top:4px; display:flex; gap:6px; }
  .dropdown-action { flex:1; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
    border:none; border-radius: var(--radius-sm); padding:5px 8px; font-size:11px; cursor:pointer; }
  .dropdown-action:hover { filter:brightness(1.1); }
  .dropdown-empty { padding:10px; font-size:12px; color: var(--vscode-descriptionForeground); text-align:center; }

  /* Modal */
  .modal-overlay { position:fixed; inset:0; background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center; z-index:1000; }
  .modal { background: var(--vscode-editor-background); color: var(--vscode-foreground); border:1px solid var(--vscode-panel-border);
    border-radius: var(--radius); padding:18px; max-width:92%; width:420px; box-shadow:0 12px 40px rgba(0,0,0,.45); }
  .modal-title { font-weight:700; margin-bottom:10px; font-size:15px; display:flex; align-items:center; gap:6px; }
  .modal-body { font-size:13px; margin-bottom:14px; line-height:1.55; }
  .modal-pre { white-space:pre-wrap; word-break:break-word; max-height:180px; overflow:auto;
    background: var(--vscode-textCodeBlock-background, var(--fs-bg-hover)); border-radius: var(--radius-sm); padding:8px; margin:8px 0; font-size:12px; }
  .modal-btns { display:flex; gap:8px; flex-wrap:wrap; }
  .modal-btns button { flex:1; min-width:80px; border:none; border-radius: var(--radius-sm); padding:8px 12px; cursor:pointer; font-size:12px;
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .modal-btns button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .modal-btns button.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
  /* 添加模型弹窗（对齐 CodeBuddy：标题栏+关闭、顶部提示、图标行、眼睛按钮） */
  .modal { width:380px; max-width:90vw; padding:14px 16px 12px; }
  .modal-title-row { display:flex; justify-content:space-between; align-items:center; font-weight:700; margin-bottom:10px; font-size:14px; }
  .modal-close { background:transparent; border:none; color:var(--vscode-foreground); font-size:18px; line-height:1; cursor:pointer; opacity:.6; padding:0 4px; }
  .modal-close:hover { opacity:1; }
  .add-prov-hint { display:flex; justify-content:space-between; align-items:center; background:rgba(206,145,36,.18);
    color: var(--vscode-foreground); padding:5px 10px; border-radius:var(--radius-sm); font-size:12px; margin-bottom:12px; }
  .add-prov-hint .add-prov-tag { background:#ce9124; color:#fff; padding:1px 6px; border-radius:3px; font-size:11px; margin-right:6px; }
  .add-prov-hint .add-prov-doc { color: var(--vscode-textLink-foreground); text-decoration:none; font-size:12px; }
  .add-prov-hint .add-prov-doc:hover { text-decoration:underline; }
  .add-prov-row { display:flex; align-items:center; gap:6px; margin:6px 0 2px; }
  .add-prov-ico { font-size:12px; opacity:.65; }
  .add-prov-lab { font-size:12px; color: var(--vscode-foreground); opacity:.85; }
  .add-prov-sel { font-size:13px; }
  /* 保存按钮使用 vscode 主题 prominent 颜色（蓝色或紫色跟随主题） */
  .modal-btns button.primary { background: var(--vscode-button-prominentBackground); color: var(--vscode-button-prominentForeground); border-color: var(--vscode-button-prominentBorder, transparent); }
  .modal-btns button.primary:hover { background: var(--vscode-button-prominentHoverBackground, var(--vscode-button-prominentBackground)); }

  /* 会话抽屉 */
  #main { display:flex; flex-direction:column; height:100%; min-width:0; }
  #sidebar { position:absolute; top:0; left:0; bottom:0; width:280px; max-width:85%; transform:translateX(-100%);
    transition: transform .18s ease; z-index:60; background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-right:1px solid var(--vscode-panel-border); display:flex; flex-direction:column; box-shadow:3px 0 18px rgba(0,0,0,.35); }
  #sidebar.open { transform:none; }
  #sidebar-backdrop { position:absolute; inset:0; background:rgba(0,0,0,.28); z-index:55; display:none; }
  #sidebar-backdrop.open { display:block; }
  #archiveBtn { font-size:12px; padding:4px 8px; border-radius:var(--radius-sm); background:transparent;
    color:var(--vscode-foreground); border:1px solid transparent; cursor:pointer; opacity:.8; }
  #archiveBtn:hover { background:var(--vscode-toolbar-hoverBackground,var(--fs-bg-hover)); opacity:1; }
  #archivedWrap { display:flex; flex-direction:column; overflow-y:auto; flex:1; }
  .sidebar-head2 { display:flex; justify-content:space-between; align-items:center; padding:8px 10px;
    border-bottom:1px solid var(--vscode-panel-border); font-size:12px; color:var(--vscode-descriptionForeground); }
  .sidebar-head2 button { font-size:12px; padding:2px 8px; background:transparent; color:var(--vscode-foreground);
    border:1px solid var(--vscode-panel-border); border-radius:var(--radius-sm); cursor:pointer;
    display:inline-flex; align-items:center; gap:4px; }
  .sidebar-head2 button:hover { background:var(--vscode-toolbar-hoverBackground,var(--fs-bg-hover)); }
  .session-item.archived { opacity:.75; }
  .session-item.archived .st { text-decoration: line-through; color:var(--vscode-descriptionForeground); }
  #sidebar-head { padding:10px; display:flex; flex-direction:column; gap:8px; border-bottom:1px solid var(--vscode-panel-border); }
  .sb-row { display:flex; gap:6px; }
  .sb-row button { display:inline-flex; align-items:center; gap:4px; }
  .sb-row .ic { width:12px; height:12px; }
  .sidebar-head2 > span { display:inline-flex; align-items:center; gap:4px; }
  .sidebar-head2 .ic { width:12px; height:12px; }
  #newChatSb { flex:1; background: var(--vscode-button-background); color: var(--vscode-button-foreground); border:none;
    border-radius: var(--radius-sm); padding:7px 10px; font-size:12px; cursor:pointer; }
  #newChatSb:hover { filter: brightness(1.08); }
  #sbToggle { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none;
    border-radius: var(--radius-sm); padding:7px 10px; font-size:12px; cursor:pointer; }
  #sessionSearch { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border:1px solid var(--vscode-input-border);
    border-radius: var(--radius-sm); padding:7px 9px; font-size:12px; outline:none; }
  #sessionSearch:focus { border-color: var(--vscode-focusBorder); }
  .sb-tools { padding:8px 10px; display:flex; flex-direction:column; gap:6px; border-bottom:1px solid var(--vscode-panel-border); }
  .sb-tools-title { font-size:11px; font-weight:600; color:var(--vscode-descriptionForeground); }
  .sb-tool { display:flex; align-items:center; gap:6px; background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground);
    border:none; border-radius:var(--radius-sm); padding:6px 10px; font-size:12px; cursor:pointer; text-align:left; }
  .sb-tool:hover { filter:brightness(1.1); }
  .sb-tool .ic { width:13px; height:13px; flex-shrink:0; }
  #sessionList { flex:1; overflow-y:auto; padding:6px; display:flex; flex-direction:column; gap:4px; }
  .session-group { font-size:11px; font-weight:600; color: var(--vscode-descriptionForeground); padding:8px 10px 2px; }
  .session-item { padding:8px 10px; border-radius: var(--radius-sm); cursor:pointer; background: var(--vscode-editor-background); border:1px solid transparent; }
  .session-item:hover { background: var(--vscode-list-hoverBackground, rgba(127,127,127,.1)); border-color: var(--vscode-panel-border); }
  .session-item .st { font-weight:600; font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .session-item .sp { font-size:11px; color: var(--vscode-descriptionForeground); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; margin-top:3px; }
  .session-item .sm { font-size:10px; color: var(--vscode-descriptionForeground); margin-top:4px; opacity:.8; }
  .session-item .sactions { display:none; gap:6px; margin-top:7px; }
  .session-item:hover .sactions { display:flex; }
  .sact { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border:none;
    border-radius: var(--radius-sm); padding:4px 9px; font-size:11px; cursor:pointer; }
  .sact:hover { filter: brightness(1.1); }
  .sact.danger { background: var(--vscode-inputValidation-errorBackground); color: var(--vscode-inputValidation-errorForeground); }
  .chip { display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius: var(--radius-sm);
    background: var(--vscode-badge-background, var(--fs-bg-strong)); color: var(--vscode-badge-foreground, var(--vscode-foreground));
    font-size:11px; line-height:1; white-space:nowrap; }
  .chip .ic { width:13px; height:13px; }
  #ctxState.warn { background: rgba(226,192,141,.22); color: var(--vscode-charts-yellow, #e2c08d); }
  #ctxState.high { background: rgba(244,135,113,.22); color: var(--vscode-errorForeground, #f48771); }

  /* ── 对话跳转导航（右侧竖条：hover 展开消息列表，类似 ChatGPT）── */
  /* 放在 #messages 内部 absolute 定位，确保只在消息区域内，不会覆盖下方 composer */
  #navRail { position: absolute; right: 0; top: 0; bottom: 0; z-index: 10;
    width: 40px; display:flex; flex-direction:column; align-items:center; justify-content:center;
    background: transparent; transition: background .15s ease; cursor: default; }
  #navRail:hover { background: rgba(127,127,127,.06); }
  #navRailInner { display:flex; flex-direction:column; align-items:center; gap:3px; max-height:100%;
    overflow-y:auto; scrollbar-width:none; padding:6px 9px; }
  #navRailInner::-webkit-scrollbar { display:none; }
  /* 竖条内每一条消息的锚点指示器 */
  .nav-dot { width:20px; height:20px; border-radius:50%; border:1.5px solid var(--vscode-panel-border);
    background: var(--vscode-editor-inactiveSelectionBackground, var(--fs-bg-soft));
    flex-shrink:0; cursor:pointer; transition: all .15s ease; position:relative; }
  .nav-dot.user { background: var(--vscode-button-background, #0e639c); border-color: var(--vscode-focusBorder, #007acc); }
  .nav-dot.assistant { background: var(--vscode-editor-inactiveSelectionBackground); }
  .nav-dot:hover { transform: scale(1.2); box-shadow: 0 0 0 2px var(--vscode-focusBorder, rgba(0,122,204,.35)); }
  /* 全局 tooltip（JS 控制，fixed 定位，避免被导航条 overflow 裁剪） */
  #navTip { position:fixed; z-index:100; min-width:180px; max-width:280px;
    background: var(--vscode-editor-background); border:1px solid var(--vscode-panel-border);
    border-radius:8px; box-shadow: 0 6px 18px rgba(0,0,0,.28); padding:7px 10px;
    font-size:11.5px; line-height:1.45; white-space:normal; word-break:break-word;
    pointer-events:none; display:none; color: var(--vscode-foreground); }
  #navTip .tt-role { font-weight:600; margin-bottom:2px; color: var(--vscode-textLink-foreground); }
  #navTip .tt-text { color: var(--vscode-descriptionForeground); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
  /* 底部计数角标 */
  #navBadge { position:absolute; bottom:10px; left:50%; transform:translateX(-50%);
    min-width:16px; height:16px; padding:0 4px; border-radius:9px;
    background: var(--vscode-badge-background, #c00); color: var(--vscode-badge-foreground, #fff);
    font-size:10px; line-height:16px; text-align:center; }
  /* 设置按钮 pending 技能角标 */
  #settingsBadge { position:absolute; top:-2px; right:-2px;
    min-width:14px; height:14px; padding:0 3px; border-radius:8px;
    background: var(--vscode-badge-background, #c00); color: var(--vscode-badge-foreground, #fff);
    font-size:9px; line-height:14px; font-weight:600; align-items:center; justify-content:center; }
  /* 跳转高亮闪烁 */
  [data-nav-id].nav-flash { animation: navFlash .9s ease; }
  @keyframes navFlash {
    0% { box-shadow: 0 0 0 2px var(--vscode-focusBorder, #007acc); background: rgba(0,122,204,.14); }
    100% { box-shadow: 0 0 0 2px transparent; background: transparent; }
  }

  /* ── Python 生成的图表（run_python 输出）── */
  .py-charts { margin:10px 0 2px; padding:8px 10px; border:1px solid var(--vscode-panel-border);
    border-radius:8px; background: var(--vscode-editorWidget-background, rgba(127,127,127,.06)); }
  .py-charts-head { font-size:12px; opacity:.85; margin-bottom:6px; }
  .py-charts figure { margin:6px 0; text-align:center; }
  .py-chart-img { max-width:100%; border-radius:6px; border:1px solid var(--vscode-widget-border, rgba(127,127,127,.2));
    background:#fff; }
  .py-chart-cap { font-size:11px; opacity:.7; margin-top:4px; }
</style>
</head>
<body>
  <div id="main">
    <div id="topbar">
      <button id="sbToggleOpen" class="tb-ic" title="展开会话列表"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg></button>
      <div id="sessionDropdown" class="dropdown session-dropdown" title="点击切换会话">
        <button id="sessionDropdownBtn" class="tb-btn session-dropdown-btn">
          <span id="sessionTitle" class="stitle">新对话</span>
          <svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
        </button>
        <div id="sessionDropdownMenu" class="dropdown-menu session-dropdown-menu"></div>
      </div>
      <button id="forkBtn" class="tb-btn" title="分叉当前对话为新分支"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>分叉</button>
      <button id="cmdBtn" class="tb-btn" title="Slash 自定义命令"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>命令</button>
      <button id="renameBtn" class="tb-btn" title="重命名当前会话"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>重命名</button>
      <button id="settingsBtn" class="tb-btn" title="设置（允许执行命令 / 规划模式 / 沙箱等）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>设置</button>
      <div id="exportDropdown" class="dropdown">
        <button id="exportBtn" class="tb-btn" title="导出当前对话为 Markdown / JSON"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>导出</button>
        <div id="exportMenu" class="dropdown-menu">
          <button class="dropdown-item" data-fmt="md">导出为 Markdown</button>
          <button class="dropdown-item" data-fmt="json">导出为 JSON</button>
          <button class="dropdown-item" id="importChatBtn" style="border-top:1px solid var(--vscode-widget-border,rgba(127,127,127,.2))">导入对话 JSON…</button>
        </div>
      </div>
      <div id="toolsDropdown" class="dropdown">
        <button id="toolsBtn" class="tb-btn" title="工具：定时任务 / Hookify 规则 / 安装套件 / 启动服务 / 编辑提供商 / 会话日志"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>工具</button>
        <div id="toolsMenu" class="dropdown-menu">
          <button class="dropdown-item" data-act="schedules">⏰ 添加定时任务</button>
          <button class="dropdown-item" data-act="manage_schedules">📋 管理定时任务…</button>
          <button class="dropdown-item" data-act="hookify">🛡️ Hookify 规则…</button>
          <button class="dropdown-item" data-act="install_kit">📦 安装专家套件…</button>
          <button class="dropdown-item" data-act="manage_kits">🗑️ 管理已装套件…</button>
          <button class="dropdown-item" data-act="start_free_server">🚀 启动免费服务</button>
          <button class="dropdown-item" data-act="edit_providers">⚙️ 编辑提供商（设置）</button>
          <button class="dropdown-item" data-act="open_session_log">📜 会话日志</button>
        </div>
      </div>
      <span id="sandboxChip" class="chip" title="OS 受限执行档：off=原样 / readonly=禁止命令 / sandbox=过滤env+硬超时"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg><span id="sandboxLabel">off</span></span>
    </div>
    <div id="inlinePanels">
      <details id="goalPanel" class="ipanel">
        <summary class="ipanel-h">
          <span class="ipanel-title"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.5"/></svg>当前目标</span>
          <span id="goalCount" class="ipanel-meta">—</span>
        </summary>
        <div id="goalBody" class="ipanel-body">
          <div class="ipanel-empty">未登记目标</div>
        </div>
      </details>
      <details id="tasksPanel" class="ipanel" open>
        <summary class="ipanel-h">
          <span class="ipanel-title"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M9 13l2 2 4-4"/></svg>任务列表</span>
          <span id="tasksCount" class="ipanel-meta">—</span>
        </summary>
        <div id="tasksBody" class="ipanel-body">
          <div class="ipanel-empty">尚无任务</div>
        </div>
      </details>
      <details id="filesPanel" class="ipanel" open>
        <summary class="ipanel-h">
          <span class="ipanel-title"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>文件列表</span>
          <span id="filesCount" class="ipanel-meta">—</span>
        </summary>
        <div id="filesBody" class="ipanel-body">
          <div class="ipanel-empty">尚无文件活动</div>
        </div>
      </details>
    </div>
    <div id="messages">
      <div class="welcome" id="welcome">
        <div class="welcome-logo">
          <svg class="ic lg lg-d" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 16.5c2.4-2.2 5-2.2 7.5 0s5 2.2 7.5 0 5-2.2 7.5 0"/><path d="M2.5 20.5c2.4-2.2 5-2.2 7.5 0s5 2.2 7.5 0 5-2.2 7.5 0"/><circle cx="19" cy="6.5" r="2.6"/></svg>
          <svg class="ic lg lg-g" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5c3 3 4 6 4 9.5 0 3.5-1 6.5-4 9.5"/><path d="M12 2.5c-3 3-4 6-4 9.5 0 3.5 1 6.5 4 9.5"/><path d="M21.5 12c-3 3-6 4-9.5 4-3.5 0-6.5-1-9.5-4"/><path d="M21.5 12c-3-3-6-4-9.5-4-3.5 0-6.5 1-9.5 4"/></svg>
          <svg class="ic lg lg-w" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4l7 16H5z"/><path d="M12 20l7-16H5z"/></svg>
          <svg class="ic lg lg-a" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          <svg class="ic lg lg-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/></svg>
        </div>
        <h2>FreeSeek</h2>
        <p>VS Code 侧边栏驱动的 AI 编程助手，支持 DeepSeek 官方 API 与本地免费服务。<br>
        输入任务后按 <b>Enter</b> 发送，<b>Shift+Enter</b> 换行；点击左上角 ☰ 打开会话列表。</p>
        <div class="welcome-suggestions">
          <button class="suggestion" data-text="解释当前项目的结构与技术栈">解释当前项目</button>
          <button class="suggestion" data-text="检查代码并找出潜在的 bug">找出潜在 bug</button>
          <button class="suggestion" data-text="为项目补充单元测试">补充单元测试</button>
          <button class="suggestion" data-text="审查当前工作区并给出改进建议">代码审查</button>
        </div>
      </div>
      <button id="jumpBottom" class="jump-bottom" title="回到底部（新内容在下方）">↓</button>
      <!-- 对话跳转导航：右侧竖条（hover 显示消息 tooltip，点击跳转） -->
      <div id="navRail"><div id="navRailInner"></div><span id="navBadge" style="display:none">0</span></div>
    </div>
    <div id="composer">
      <div id="composerToolbar" title="快捷工具">
        <button id="tbAddCtx" class="cb-ic" title="附加当前文件 / 选区作为上下文（@ 上下文）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg></button>
        <button id="tbAttachImg" class="cb-ic" title="添加图片（支持视觉的模型）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></button>
        <button id="tbFocusTasks" class="cb-ic" title="聚焦任务列表面板"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></button>
        <button id="tbFocusFiles" class="cb-ic" title="聚焦文件列表面板"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg></button>
        <button id="tbImportChat" class="cb-ic" title="导入 Codex / Claude Code 对话"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg></button>
      </div>
      <div id="ctxChips"></div>
      <div class="input-wrap">
        <textarea id="input" placeholder="描述你的编程任务…（Enter 发送，Shift+Enter 换行）"></textarea>
        <button id="send-inn" title="发送"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
      </div>
      <div id="cbBar" title="对话模式 / 模型 / 上下文占用">
        <div id="modeSeg" title="对话模式：Plan（规划只读）/ Ask（问答只读）/ Craft（制作，可执行）/ Coder（专职编码，可执行）">
          <button id="modePlanBtn" class="mode-btn" data-mode="plan" title="规划模式：只读调研 + 出方案，禁止写文件 / 执行命令">Plan</button>
          <button id="modeAskBtn" class="mode-btn" data-mode="ask" title="问答模式：纯问答，只用只读工具查信息，不写不改不执行">Ask</button>
          <button id="modeCraftBtn" class="mode-btn" data-mode="craft" title="制作模式：完整能力，可写文件 / 执行命令">Craft</button>
          <button id="modeCoderBtn" class="mode-btn coder" data-mode="coder" title="编码模式：专注需求理解与代码生成，权限等同 Craft（可写文件 / 执行命令）">Coder</button>
        </div>
        <div id="modelDropdown" class="dropdown">
          <button id="modelChip" title="切换模型 / 提供商"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 14h.01M15 14h.01"/><path d="M2 14v2M22 14v2"/></svg><span id="modelLabel">…</span></button>
          <div id="modelMenu" class="dropdown-menu"></div>
        </div>
        <span id="ctxState" class="chip" title="上下文占用与持久记忆条数"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l3-3 3 3 4-5"/></svg><span id="ctxLabel">—</span></span>
        <span class="cb-spacer"></span>
      </div>
      <div id="toolbar">
        <button id="newChat" title="开始新对话">新建</button>
        <button id="addCtx" title="把当前打开的文件 / 选区作为上下文发送"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>上下文</button>
        <button id="attachImg" title="添加图片（发送给支持视觉的模型）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>图片</button>
        <input type="file" id="imgInput" accept="image/*" multiple style="display:none" />
        <div id="status">就绪。Enter 发送。</div>
        <span class="hint">Enter 发送 · Shift+Enter 换行</span>
      </div>
    </div>
  </div>
  <div id="sidebar-backdrop"></div>
  <aside id="sidebar">
    <div id="sidebar-head">
      <div class="sb-row">
        <button id="newChatSb" title="新建对话"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>新建对话</button>
        <button id="archiveBtn" title="查看已归档会话"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>归档</button>
        <button id="importSb" title="导入 Codex / Claude Code 对话文件"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>导入</button>
        <button id="sbToggle" title="收起侧边栏"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <input id="sessionSearch" type="text" placeholder="搜索历史对话…" />
    </div>
    <div class="sb-tools">
      <div class="sb-tools-title">工具</div>
      <button id="schedulesSb" class="sb-tool" title="管理定时任务（添加/启用/停用/删除/立即运行）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M5 3 2 6"/><path d="M22 6l-3-3"/></svg>定时任务</button>
      <button id="hookifySb" class="sb-tool" title="Hookify 规则管理（查看/新建/编辑/启停/删除，markdown 规则）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><path d="M9 8v8M15 8v8M9 12h6"/></svg>Hookify 规则</button>
      <button id="installKitSb" class="sb-tool" title="安装专家套件（含 skills/commands/agents）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/></svg>安装套件</button>
      <button id="manageKitsSb" class="sb-tool" title="管理已安装的专家套件（查看/卸载，卸载即删除套件安装的文件）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/></svg>管理套件</button>
      <button id="freeServerSb" class="sb-tool" title="启动免费服务（本地/ Docker 运行 DeepSeek 免费 API）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>启动服务</button>
      <button id="editProvidersSb" class="sb-tool" title="在设置中编辑提供商"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>编辑提供商</button>
      <button id="sessionLogSb" class="sb-tool" title="打开当前会话的事件日志回放"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h8M8 9h2"/></svg>会话日志</button>
    </div>
    <div id="sessionList"></div>
    <div id="archivedWrap" style="display:none">
      <div class="sidebar-head2">
        <span><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>已归档</span>
        <button id="backToSessions" title="返回会话列表"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>返回</button>
      </div>
      <div id="archivedList"></div>
    </div>
  </aside>
  <!-- 导航条 hover 全局 tooltip（fixed 定位，避免被 navRailInner 的 overflow 裁剪） -->
  <div id="navTip"></div>
  <button id="quoteToChat" class="quote-btn" title="把选中的历史回复加入当前对话作为引用（对齐 Codex 引用历史回复）"><svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>添加到对话</button>
  <script nonce="${nonce}">window.__freesekMermaidUri=${JSON.stringify(mermaidUri.toString())};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
  `;
}
