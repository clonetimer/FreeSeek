/**
 * 浏览器操作工具（CDP 控制真实 Chrome / Edge，或自动启动 headless 实例）。
 * 连接策略（对齐 browser-harness 思路）：
 *   1) 探测 127.0.0.1:<port>（默认 9222，可配 freesek.browserPort）上是否已有带
 *      --remote-debugging-port 的浏览器在跑（含登录态/Cookie）→ 直接复用之；
 *   2) 否则自动拉起 headless Chrome/Edge。
 *
 * 仅应在 Craft（制作）模式使用；plan/ask 会在工具层拦截。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { CdpSession } from "./cdp";

export interface BrowserToolContext {
  workspaceRoot: string;
  /** CDP 调试端口，默认 9222 */
  port?: number;
  /** 截图回调（把 PNG dataURL 推给前端渲染） */
  onBrowserShot?: (shots: Array<{ path: string; dataUrl: string; caption: string }>) => void;
}

let session: CdpSession | null = null;
let sessionTab: string | null = null; // 已用标签页的 id
let chromeProc: ChildProcess | null = null;
let userDataDir: string | null = null;

const TEXT_LIMIT = 3000;
const RESULT_LIMIT = 4000;

/* ------------------------------------------------------------------ */
/* 连接管理                                                             */
/* ------------------------------------------------------------------ */

function fetchJson(url: string, timeoutMs = 3000): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`解析 ${url} 失败: ${e}`));
        }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`连接 ${url} 超时`)));
  });
}

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
  ].filter(Boolean) as string[];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  return null;
}

async function probeVersion(port: number): Promise<boolean> {
  try {
    await fetchJson(`http://127.0.0.1:${port}/json/version`, 1500);
    return true;
  } catch {
    return false;
  }
}

function launchChrome(port: number): void {
  const exe = findChrome();
  if (!exe) {
    throw new Error(
      "未找到 Chrome/Edge。请设置环境变量 CHROME_PATH，或手动启动：chrome --remote-debugging-port=" +
        port +
        " --user-data-dir=<自定义目录>"
    );
  }
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-cdp-"));
  chromeProc = spawn(
    exe,
    [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true }
  );
  chromeProc.on("exit", () => {
    chromeProc = null;
  });
}

async function getPageTarget(port: number): Promise<{ id: string; wsUrl: string }> {
  const tabs = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pages = (Array.isArray(tabs) ? tabs : []).filter((t: any) => t && t.type === "page" && t.webSocketDebuggerUrl);
  // 优先复用当前会话已用的标签页；否则用第一个 page；没有就新建
  let target: any = pages.find((t: any) => t.id === sessionTab) ?? pages[0];
  if (!target) {
    const created = await fetchJson(`http://127.0.0.1:${port}/json/new?about:blank`, 5000);
    target = created;
  }
  return { id: target.id, wsUrl: target.webSocketDebuggerUrl };
}

async function ensureSession(ctx: BrowserToolContext): Promise<CdpSession> {
  if (session && !session["closed"]) {
    // 会话仍存活：确认目标标签页还开着
    try {
      await session.send("Runtime.evaluate", { expression: "1+1" });
      return session;
    } catch {
      session = null;
    }
  }
  const port = ctx.port ?? 9222;
  const alive = await probeVersion(port);
  if (!alive) {
    launchChrome(port);
    // 等待调试端口就绪（最多 10s）
    let ok = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      if (await probeVersion(port)) {
        ok = true;
        break;
      }
    }
    if (!ok) throw new Error("Chrome 调试端口启动超时，请检查是否有其他实例占用端口 " + port);
  }
  const tab = await getPageTarget(port);
  sessionTab = tab.id;
  session = await CdpSession.connect(tab.wsUrl);
  await session.send("Page.enable");
  return session;
}

/* ------------------------------------------------------------------ */
/* 动作实现                                                             */
/* ------------------------------------------------------------------ */

async function evalJson(s: CdpSession, expression: string): Promise<any> {
  const r = await s.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    return { __error: r.exceptionDetails.text ?? "JS 执行异常" };
  }
  return r.result?.value;
}

async function readPageInfo(s: CdpSession): Promise<{ title: string; url: string; text: string }> {
  const info = await evalJson(
    s,
    `(()=>{const b=document.body;return JSON.stringify({title:document.title,url:location.href,text:(b?b.innerText||"":"").replace(/\\n{3,}/g,"\\n\\n").slice(0,${TEXT_LIMIT})});})()`
  );
  try {
    return JSON.parse(info);
  } catch {
    return { title: "", url: "", text: "" };
  }
}

async function doNavigate(s: CdpSession, url: string): Promise<string> {
  let finalUrl = url;
  if (!/^[a-z]+:\/\//i.test(url)) finalUrl = "https://" + url;
  const loaded = s.waitEvent("Page.loadEventFired", 8000);
  await s.send("Page.navigate", { url: finalUrl });
  await loaded;
  const info = await readPageInfo(s);
  return `已导航到 ${info.url || finalUrl}\n标题：${info.title || "（无标题）"}\n\n${info.text || "（页面无可读文本）"}`;
}

async function doClick(s: CdpSession, selector: string): Promise<string> {
  const r = await evalJson(
    s,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return JSON.stringify({ok:false,error:"未找到选择器"});el.scrollIntoView({block:"center",inline:"center"});const rect=el.getBoundingClientRect();const opts={bubbles:true,cancelable:true,clientX:rect.left+rect.width/2,clientY:rect.top+rect.height/2};el.dispatchEvent(new MouseEvent("mousedown",opts));el.dispatchEvent(new MouseEvent("mouseup",opts));el.dispatchEvent(new MouseEvent("click",opts));return JSON.stringify({ok:true,tag:el.tagName,text:(el.innerText||el.value||"").slice(0,120)});})()`
  );
  const v = typeof r === "string" ? JSON.parse(r) : r;
  if (!v.ok) return `⛔ 点击失败：${v.error || "未知错误"}`;
  return `✅ 已点击 <${v.tag}>：${v.text || "（无文本）"}`;
}

async function doType(s: CdpSession, selector: string, text: string): Promise<string> {
  const r = await evalJson(
    s,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return JSON.stringify({ok:false,error:"未找到选择器"});const proto=el.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;const setter=Object.getOwnPropertyDescriptor(proto,"value")?.set;if(setter)setter.call(el,${JSON.stringify(text)});else el.value=${JSON.stringify(text)};el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));return JSON.stringify({ok:true,value:el.value.slice(0,120)});})()`
  );
  const v = typeof r === "string" ? JSON.parse(r) : r;
  if (!v.ok) return `⛔ 输入失败：${v.error || "未知错误"}`;
  return `✅ 已输入到 ${selector}：${v.value || "（空）"}`;
}

const KEY_CODES: Record<string, { code: string; keyCode: number }> = {
  Enter: { code: "Enter", keyCode: 13 },
  Tab: { code: "Tab", keyCode: 9 },
  Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 },
  ArrowUp: { code: "ArrowUp", keyCode: 38 },
  ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 },
  ArrowRight: { code: "ArrowRight", keyCode: 39 },
};

async function doPress(s: CdpSession, key: string): Promise<string> {
  const spec = KEY_CODES[key] ?? { code: key.length === 1 ? "Key" + key.toUpperCase() : key, keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0 };
  await s.send("Input.dispatchKeyEvent", { type: "keyDown", key, code: spec.code, windowsVirtualKeyCode: spec.keyCode });
  await s.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: spec.code, windowsVirtualKeyCode: spec.keyCode });
  return `✅ 已按键：${key}`;
}

async function doEvaluate(s: CdpSession, expression: string): Promise<string> {
  const r = await s.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  let out: string;
  if (r.exceptionDetails) {
    out = "⛔ JS 执行异常：\n" + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "未知");
  } else if (r.result?.value !== undefined) {
    const v = r.result.value;
    out = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  } else {
    out = r.result?.description ?? "（无返回值）";
  }
  if (out.length > RESULT_LIMIT) out = out.slice(0, RESULT_LIMIT) + `\n…（截断，共 ${out.length} 字符）`;
  return out;
}

async function doScreenshot(ctx: BrowserToolContext, s: CdpSession, name?: string): Promise<string> {
  const shot = await s.send("Page.captureScreenshot", { format: "png" });
  const b64 = shot.data as string;
  if (!b64) return "⛔ 截图失败：CDP 未返回数据";
  const dir = path.join(ctx.workspaceRoot, ".freeseek", "screens");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name || "shot"}-${Date.now()}.png`);
  fs.writeFileSync(file, Buffer.from(b64, "base64"));
  const caption = name ? `浏览器截图：${name}` : `浏览器截图 ${path.basename(file)}`;
  if (ctx.onBrowserShot) {
    ctx.onBrowserShot([{ path: file, dataUrl: `data:image/png;base64,${b64}`, caption }]);
  }
  return `✅ 已截图：${file}`;
}

async function doList(ctx: BrowserToolContext): Promise<string> {
  const port = ctx.port ?? 9222;
  const tabs = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  const pages = (Array.isArray(tabs) ? tabs : []).filter((t: any) => t.type === "page");
  if (!pages.length) return "（无打开的标签页）";
  return pages
    .map((t: any, i: number) => `${i + 1}. ${t.title || "（无标题）"} — ${t.url}`)
    .join("\n");
}

function doClose(): string {
  try {
    session?.close();
  } catch {
    /* ignore */
  }
  session = null;
  sessionTab = null;
  if (chromeProc) {
    chromeProc.kill();
    chromeProc = null;
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* Windows 下文件可能仍被占用，忽略 */
    }
    userDataDir = null;
  }
  return "✅ 浏览器连接已关闭。";
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

/** 执行浏览器动作。 */
export async function browserAction(action: string, args: Record<string, unknown> | undefined, ctx: BrowserToolContext): Promise<string> {
  const a = String(action || "").trim().toLowerCase();
  if (a === "close") return doClose();
  const s = await ensureSession(ctx);
  switch (a) {
    case "navigate": {
      const url = String(args?.url ?? "").trim();
      if (!url) return "⚠️ browser navigate 需要 url 参数。";
      return await doNavigate(s, url);
    }
    case "click": {
      const sel = String(args?.selector ?? "").trim();
      if (!sel) return "⚠️ browser click 需要 selector（CSS 选择器）。";
      return await doClick(s, sel);
    }
    case "type": {
      const sel = String(args?.selector ?? "").trim();
      const text = String(args?.text ?? "");
      if (!sel) return "⚠️ browser type 需要 selector（CSS 选择器）。";
      return await doType(s, sel, text);
    }
    case "press": {
      const key = String(args?.key ?? "").trim();
      if (!key) return "⚠️ browser press 需要 key（如 Enter / Tab / Escape）。";
      return await doPress(s, key);
    }
    case "evaluate": {
      const expr = String(args?.expression ?? "").trim();
      if (!expr) return "⚠️ browser evaluate 需要 expression（JS 表达式）。";
      return await doEvaluate(s, expr);
    }
    case "screenshot": {
      return await doScreenshot(ctx, s, args?.name ? String(args.name) : undefined);
    }
    case "list":
      return await doList(ctx);
    case "status": {
      const info = await readPageInfo(s);
      return `浏览器已连接\n标题：${info.title || "（无标题）"}\n地址：${info.url || "（未知）"}`;
    }
    default:
      return (
        `未知动作：${a}。可选动作：\n` +
        "- navigate {url} —— 打开页面并返回标题与正文\n" +
        "- click {selector} —— 点击元素（CSS 选择器）\n" +
        "- type {selector, text} —— 输入文本到输入框\n" +
        "- press {key} —— 按键（Enter/Tab/Escape/ArrowDown 等）\n" +
        "- evaluate {expression} —— 执行 JS 并返回结果\n" +
        "- screenshot {name?} —— 截图（保存到 .freeseek/screens 并回显）\n" +
        "- list —— 列出打开的标签页\n" +
        "- status —— 查看当前页面\n" +
        "- close —— 关闭浏览器连接"
      );
  }
}
