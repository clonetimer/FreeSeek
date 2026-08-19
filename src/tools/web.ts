// check:max-lines 160 (web_search / web_fetch 工具实现；tools.ts 拆分)
import type { ToolContext } from "../tools";
import { TOOL_OUTPUT_PREVIEW_CAP } from "../agent-utils";

/** 抓取 URL 并转纯文本（剥离 HTML 标签与脚本样式），截断到合理长度。 */
async function fetchUrlAsText(url: string, timeoutMs = 20000): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (FreeSeek Agent)" },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return `请求失败：HTTP ${res.status}`;
    const raw = await res.text();
    const html = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s{2,}/g, " ")
      .trim();
    return html.slice(0, TOOL_OUTPUT_PREVIEW_CAP) + (html.length > TOOL_OUTPUT_PREVIEW_CAP ? `\n…（已截断，共 ${html.length} 字符）` : "");
  } catch (e: any) {
    clearTimeout(timer);
    return e?.name === "AbortError" ? "请求超时" : `抓取失败：${e?.message ?? String(e)}`;
  }
}

/**
 * web_search 实现：多源兜底，保证尽量返回可用结果。
 *  1. Bing（cn.bing.com）HTML 结果页——多数地区稳定、无需 key，解析 <li class="b_algo"> 结果块；
 *  2. DuckDuckGo Instant Answer API（结构化 JSON，命中即返回摘要）；
 *  3. 都失败则返回提示。
 * 修复：旧实现只依赖 html.duckduckgo.com（早已反爬/下线，选择器失效导致几乎永远返回空），现改为 Bing 主源。
 */
export async function runWebSearch(_ctx: ToolContext, args: any): Promise<string> {
  const query = String(args.query ?? "").trim();
  if (!query) return "⚠️ web_search 需要 query。";
  const max = Math.min(Number(args.max ?? 6) || 6, 10);
  const out: string[] = [];

  // 主源：Bing HTML 结果页（解析 .b_algo 结构，稳定可靠）
  try {
    const html = await fetchUrlAsText(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${max}`);
    const liRe = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi;
    const items: Array<{ title: string; url: string; snippet: string }> = [];
    let m: RegExpExecArray | null;
    while ((m = liRe.exec(html)) !== null && items.length < max) {
      const block = m[1];
      const titleM = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
      const snipM = /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block) || /class="b_lineclamp[^"]*"[^>]*>([\s\S]*?)</i.exec(block);
      if (!titleM) continue;
      items.push({
        title: stripHtml(titleM[2]).replace(/\s+/g, " ").trim(),
        url: titleM[1].replace(/&amp;/g, "&"),
        snippet: snipM ? stripHtml(snipM[1]).replace(/\s+/g, " ").trim() : "",
      });
    }
    for (const it of items) {
      out.push(`- **${it.title || "(无标题)"}**\n  ${it.url}\n  ${it.snippet}`.trim());
    }
  } catch {
    /* Bing 失败则走 DDG 兜底 */
  }

  // 兜底：DuckDuckGo Instant Answer（结构化，适合有摘要的查询）
  if (!out.length) {
    try {
      const ia = await fetchUrlAsText(
        `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
      );
      const j = JSON.parse(ia);
      if (j?.AbstractText) {
        out.push(`- **${j.AbstractText}**\n  来源: ${j?.AbstractURL ?? ""}`);
      }
      if (Array.isArray(j?.RelatedTopics)) {
        for (const t of j.RelatedTopics.slice(0, max)) {
          if (t?.Text) out.push(`- ${t.Text}（${t.FirstURL ?? ""}）`);
        }
      }
    } catch {
      /* 忽略 */
    }
  }

  if (out.length) {
    return `搜索「${query}」结果：\n\n${out.slice(0, max).join("\n\n")}\n\n提示：可用 web_fetch 抓取某个链接的详细内容。`;
  }
  return `未搜索到「${query}」的相关结果（网络可能受限）。`;
}

/** 剥离 HTML 标签，返回纯文本。 */
function stripHtml(s: string): string {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * 判断 URL 是否指向内网/本机（防 SSRF：阻止抓取云元数据 169.254.169.254、本机回环、局域网私有地址）。
 */
function isInternalUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (host === "localhost" || host === "::1" || host === "0.0.0.0") return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      const p = host.split(".").map(Number);
      if (p[0] === 127 || p[0] === 10 || p[0] === 169 && p[1] === 254 || p[0] === 0) return true;
      if (p[0] === 192 && p[1] === 168) return true;
      if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** web_fetch 实现：抓取 URL 并转纯文本（拦截内网/元数据地址防 SSRF）。 */
export async function runWebFetch(_ctx: ToolContext, args: any): Promise<string> {
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//i.test(url)) return "⚠️ web_fetch 需要 http(s):// 开头的 URL。";
  if (isInternalUrl(url)) return "⛔ 已阻止抓取内网/本机地址（防 SSRF），仅允许公网 URL。";
  const text = await fetchUrlAsText(url);
  return `抓取 ${url}：\n\n${text}`;
}
