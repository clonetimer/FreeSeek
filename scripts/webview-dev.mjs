// check:max-lines 220
/**
 * FreeSeek Webview Dev Harness（UI Harness）。
 *
 * 让 webview 前端在普通浏览器里独立运行，无需启动 VS Code，便于用
 * Chrome DevTools MCP 直接“看”与“交互”界面，快速调试 UI。
 *
 * 原理：
 *   1. 用 esbuild 把 src/webview/main.ts 打成浏览器 bundle（dev 模式，不压缩）。
 *   2. 从 src/webview/html.ts 源文件里抽取 <style> 与 <body> 模板（与真实生产一致），
 *      零侵入、永远与生产同步。
 *   3. 注入 dev-only 的兜底 --vscode-* 变量，使浏览器里界面可读。
 *   4. 通过 ?scenario=<file> 从 globalStorage 的 events-*.jsonl replay 入站消息，
 *      让界面有真实内容可调试（需在 URL 指定 sessionId 以对齐 currentViewSessionId）。
 *
 * 用法（在浏览器打开）：
 *   http://localhost:5173/                                  空状态
 *   http://localhost:5173/?scenario=events-XXXX.jsonl&sessionId=msuXXXX  回放某会话
 */
import esbuild from "esbuild";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "webview-dev");
const outJs = path.join(outDir, "webview.generated.js");
fs.mkdirSync(outDir, { recursive: true });

/** 从 html.ts 抽取 <style>...</style> 与 <body>...</body> 之间的原始内容。 */
function extractTemplates() {
  const html = fs.readFileSync(path.join(root, "src/webview/html.ts"), "utf8");
  const style = html.match(/<style>([\s\S]*?)<\/style>/);
  const body = html.match(/<body>([\s\S]*?)<\/body>/);
  if (!style || !body) throw new Error("无法从 html.ts 抽取 style/body 模板");
  let bodyHtml = body[1];
  // 去掉生产末尾的 mermaid nonce script 与 webview.js script（dev 由本 server 注入）
  bodyHtml = bodyHtml.replace(/<script[\s\S]*?<\/script>/g, "");
  // 清空静态欢迎页内容，让 showWelcome() 在空状态时重建为 dev 优化后的新结构
  bodyHtml = emptyWelcomeDiv(bodyHtml);
  bodyHtml = bodyHtml.trim();
  return { css: style[1], body: bodyHtml };
}

/** 浏览器里没有 VS Code 主题变量，注入一套 dark 近似兜底，保证界面可读。 */
const devVars = `
  :root {
    --vscode-font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
    --vscode-foreground: #cccccc;
    --vscode-background: #1e1e1e;
    --vscode-editor-background: #1e1e1e;
    --vscode-sideBar-background: #252526;
    --vscode-panel-background: #1e1e1e;
    --vscode-input-background: #3c3c3c;
    --vscode-input-foreground: #cccccc;
    --vscode-input-border: #3c3c3c;
    --vscode-panel-border: rgba(127,127,127,.35);
    --vscode-focusBorder: #007fd4;
    --vscode-textLink-foreground: #4daafc;
    --vscode-descriptionForeground: #9da5b4;
    --vscode-charts-green: #3fb950;
    --vscode-charts-yellow: #d29922;
    --vscode-charts-red: #f85149;
    --vscode-button-background: #0e639c;
    --vscode-button-foreground: #ffffff;
    --vscode-button-hoverBackground: #1177bb;
    --vscode-editorWidget-background: #252526;
    --vscode-editorWidget-border: rgba(127,127,127,.35);
    --vscode-scrollbarSlider-background: rgba(121,121,121,.4);
    --vscode-textCodeBlock-background: rgba(127,127,127,.25);
    --vscode-textPreformat-foreground: #d7ba7d;
    --vscode-badge-background: #4d4d4d;
    --vscode-badge-foreground: #ffffff;
    --vscode-list-activeSelectionBackground: #094771;
    --vscode-list-hoverBackground: #2a2d2e;
  }
  body.dev-harness { position: relative; }
  body.dev-harness::before {
    content: "DEV HARNESS · 浏览器独立运行（非 VS Code）";
    position: fixed; top: 0; left: 0; right: 0; z-index: 9999;
    font: 11px/20px ui-monospace, monospace; text-align: center;
    background: #b8860b; color: #000; opacity: .85; pointer-events: none;
  }
`;

/**
 * 把生产 html.ts 中静态填充的 #welcome 内容清空。
 * 由于 welcome 内部有嵌套 div，不能用简单正则，这里按 div 嵌套深度匹配。
 */
function emptyWelcomeDiv(html) {
  const start = html.indexOf('<div class="welcome" id="welcome">');
  if (start === -1) return html;
  let depth = 1;
  let i = start + '<div class="welcome" id="welcome">'.length;
  while (i < html.length && depth > 0) {
    const open = html.indexOf("<div", i);
    const close = html.indexOf("</div>", i);
    if (close === -1) break;
    if (open !== -1 && open < close) {
      depth++;
      i = open + 4;
    } else {
      depth--;
      if (depth === 0) {
        return (
          html.slice(0, start) +
          '<div class="welcome" id="welcome"></div>' +
          html.slice(i + 6)
        );
      }
      i = close + 6;
    }
  }
  return html;
}

/** 解析 ?scenario= 指定的 events 文件，转成 webview 入站消息。 */
function buildInbound(url) {
  const sp = new URLSearchParams(url.search);
  const scenario = sp.get("scenario");
  const sessionId = sp.get("sessionId") || "";
  if (!scenario) return [];
  const base = path.join(
    os.homedir(),
    "AppData",
    "Roaming",
    "Code",
    "User",
    "globalStorage",
    "freeseek.freeseek-copilot",
    "freesek"
  );
  const file = path.join(base, scenario);
  if (!fs.existsSync(file)) {
    console.warn(`[dev] scenario 文件不存在: ${file}`);
    return [];
  }
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  const inbound = [];
  const messages = [];
  for (const line of lines) {
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const sid = o.sessionId || sessionId;
    if (o.type === "user") {
      messages.push({ role: "user", content: o.content || "" });
    } else if (o.type === "assistant") {
      const text = o.content || o.message || o.text || "";
      const reasoning = o.reasoning || o.reasoning_content || "";
      let body = text;
      if (reasoning && !text) body = `> _（推理）_ ${reasoning.slice(0, 400)}\n\n`;
      else if (reasoning) body = `> _（推理）_ ${reasoning.slice(0, 200)}\n\n${text}`;
      messages.push({ role: "assistant", content: body });
    } else if (o.type === "tool_start") {
      // 在 dev harness 中把真实工具事件直接 dispatch 成入站消息，
      // 从而复用生产环境里的工具卡 UI，而不是把工具内容粗暴地塞进文本。
      inbound.push({
        type: "tool_start",
        sessionId: sid,
        name: o.name || o.tool || "tool",
        args: o.args || "",
      });
    } else if (o.type === "tool_result") {
      inbound.push({
        type: "tool_result",
        sessionId: sid,
        name: o.name || o.tool || "工具",
        result: o.result || "",
      });
    }
  }
  if (messages.length > 0) {
    inbound.unshift({ type: "restore", sessionId, messages });
  } else {
    // 空 scenario：触发 new_chat，让 showWelcome() 渲染新版欢迎页
    inbound.push({ type: "new_chat" });
  }
  inbound.push({ type: "session_title", title: scenario || "新对话", sessionId });
  return inbound;
}

async function buildWebview() {
  await esbuild.build({
    entryPoints: [path.join(root, "src/webview/main.ts")],
    bundle: true,
    outfile: outJs,
    format: "iife",
    platform: "browser",
    target: "es2020",
    sourcemap: true,
    minify: false,
    treeShaking: true,
    logLevel: "info",
  });
}

function startServer() {
  const { css, body } = extractTemplates();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || "/", "http://localhost");
    if (u.pathname === "/" || u.pathname === "/index.html") {
      const inbound = buildInbound(u);
      const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>FreeSeek Dev Harness</title>
<style>${devVars}</style>
<style>${css}</style>
</head>
<body class="dev-harness">
${body}
<script>
  // dev harness 向 webview 注入 replay 入站消息（bridge mock 会派发）
  window.__FRESEEK_HARNESS_INBOUND__ = ${JSON.stringify(inbound)};
  window.__freesekMermaidUri = null; // dev 下禁用 mermaid 懒加载
</script>
<script src="/webview.generated.js"></script>
</body>
</html>`;
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
      return;
    }
    if (u.pathname === "/webview.generated.js" || u.pathname === "/webview.generated.js.map") {
      const f = path.join(outDir, path.basename(u.pathname));
      if (fs.existsSync(f)) {
        res.writeHead(200, {
          "Content-Type": u.pathname.endsWith(".map")
            ? "application/json"
            : "text/javascript",
        });
        fs.createReadStream(f).pipe(res);
      } else {
        res.writeHead(404);
        res.end("not built");
      }
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const port = 5173;
  server.listen(port, () => {
    console.log(`\nFreeSeek Dev Harness: http://localhost:${port}/`);
    console.log("用法示例:");
    console.log("  空状态:   http://localhost:5173/");
    console.log(
      "  回放会话: http://localhost:5173/?scenario=events-XXXX.jsonl&sessionId=msuXXXX\n"
    );
  });
}

await buildWebview();
startServer();
