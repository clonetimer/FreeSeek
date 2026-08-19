import { registerConnector } from "../connectors";

/** 判断 URL 是否指向内网/本机（防 SSRF：云元数据 169.254.169.254、回环、局域网私有地址）。 */
function isInternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const p = host.split(".").map(Number);
      if (p[0] === 127 || p[0] === 10 || (p[0] === 169 && p[1] === 254) || p[0] === 0) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * 内置 HTTP 请求连接器——最通用的"连接外部服务"能力。
 * 允许 Agent 发送 GET/POST/PUT/DELETE 请求到外部 API（需用户允许网络，默认受 allowShell 限制）。
 *
 * 这是连接器插件机制的示例与基础：其它第三方连接器（GitHub/Slack/数据库等）
 * 可按同一规范实现并 registerConnector。
 */
export function registerHttpConnector(): void {
  registerConnector({
    id: "http",
    name: "HTTP 请求",
    description: "向外部 HTTP API 发送 GET/POST/PUT/DELETE 请求并返回响应（连接外部服务）。",
    tools: [
      {
        name: "request",
        description:
          "发送一个 HTTP 请求到指定 URL，返回状态码、响应头与响应体（文本/JSON）。GET 用于读取，POST/PUT 用于提交，DELETE 用于删除。默认超时 30s，响应体截断到 6000 字符。",
        parameters: {
          type: "object",
          properties: {
            method: { type: "string", enum: ["GET", "POST", "PUT", "DELETE"], description: "HTTP 方法，默认 GET" },
            url: { type: "string", description: "完整请求 URL（http/https）" },
            headers: { type: "object", description: "可选：请求头（如 { 'Authorization': 'Bearer ...' }）" },
            body: { type: "string", description: "可选：请求体（字符串；JSON 请自行 JSON.stringify）" },
          },
          required: ["url"],
        },
      },
    ],
    async execute(name, args, ctx) {
      if (name !== "request") return `HTTP 连接器没有工具: ${name}`;
      if (!ctx.allowShell) {
        return "⚠️ HTTP 连接器需要联网，但 freesek.allowShell 未开启。请在设置中开启以使用网络请求。";
      }
      const method = String(args.method || "GET").toUpperCase();
      const url = String(args.url || "");
      if (!/^https?:\/\//i.test(url)) return "⚠️ URL 必须是 http(s):// 开头。";
      // 防 SSRF：禁止请求内网/本机/云元数据地址
      if (isInternalUrl(url)) return "⛔ 已阻止请求内网/本机地址（防 SSRF），仅允许公网 URL。";
      try {
        const headers: Record<string, string> = { accept: "application/json" };
        if (args.headers && typeof args.headers === "object") {
          for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
        }
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(url, {
          method,
          headers,
          body: args.body != null ? String(args.body) : undefined,
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const text = await res.text();
        const body = text.slice(0, 6000) + (text.length > 6000 ? `\n…（已截断，共 ${text.length} 字符）` : "");
        return `HTTP ${method} ${url}\n状态码: ${res.status} ${res.statusText}\n响应:\n${body}`;
      } catch (e: any) {
        const msg = e?.name === "AbortError" ? "请求超时（30s）" : e?.message ?? String(e);
        return `HTTP 请求失败：${msg}`;
      }
    },
  });
}
