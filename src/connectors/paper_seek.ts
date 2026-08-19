import { execFile } from "child_process";
import { registerConnector } from "../connectors";
import { ToolContext } from "../tools";

/**
 * PaperSeek 连接器——学术文献检索（基于开源项目 MingfengHong/PaperSeek，
 * Apache-2.0，https://github.com/MingfengHong/PaperSeek）。
 *
 * 通过封装其 CLI（`paperseek search "..." --output json`）提供论文检索，
 * 数据源覆盖 OpenAlex / arXiv / Semantic Scholar / PubMed / Google Scholar / 计算机顶会等。
 *
 * 前置：需 `pip install "paperseek[mcp]"` 或 `pip install paperseek` 安装 CLI。
 * 未安装时工具会返回安装指引，而非报错。
 */
export function registerPaperSeekConnector(): void {
  registerConnector({
    id: "paper_seek",
    name: "PaperSeek 学术检索",
    description:
      "学术文献检索（PaperSeek）：用自然语言检索论文，数据源覆盖 OpenAlex/arXiv/Semantic Scholar/PubMed/Google Scholar/顶会。返回候选论文列表（标题/年份/引用数/摘要）。需本机安装 paperseek 包。",
    tools: [
      {
        name: "search",
        description:
          "按研究问题检索学术论文，返回排序后的候选列表（标题/作者/年份/引用数/链接/摘要）。自动迭代查询并扩展引用。可指定学科领域。",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "研究问题/关键词（中英文均可，如 'retrieval augmented generation for code'）" },
            source: { type: "string", enum: ["arxiv", "crossref", "semanticscholar", "pubmed", "openalex"], description: "数据源，默认 arxiv（免费）；openalex 现在需要付费额度" },
            discipline: { type: "string", description: "可选：学科领域限制（如 'Computer Science'）" },
            max: { type: "number", description: "可选：最多返回论文数，默认 8，最大 20" },
            min: { type: "number", description: "可选：最少返回论文数（用于迭代），默认 3" },
            iterations: { type: "number", description: "可选：查询迭代轮数，默认 2（越多越准但越慢）" },
          },
          required: ["query"],
        },
      },
      {
        name: "sources",
        description: "列出 PaperSeek 支持的全部学术数据源及其能力（无需查询，直接调用）。",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "install_hint",
        description: "返回安装 PaperSeek 的指引（当 search 提示未安装时使用）。",
        parameters: { type: "object", properties: {} },
      },
    ],
    async execute(name, args, _ctx: ToolContext) {
      if (name === "sources") {
        return (
          "PaperSeek 数据源：\n" +
          "- arxiv：预印本，CS/物理/数学/统计（免费，无需 Key，默认）\n" +
          "- crossref：出版商 DOI/书目元数据（免费，建议配 CROSSREF_EMAIL）\n" +
          "- semanticscholar：跨学科学术图谱/引用数\n" +
          "- pubmed：医学/生物医学/生命科学\n" +
          "- openalex：精确检索/引用扩展（需付费额度，否则 429）\n" +
          "- 说明：所有检索都需先配置 LLM_API_KEY（用于自动生成/迭代检索式）"
        );
      }
      if (name === "install_hint") {
        return (
          "安装 PaperSeek（需 Python 3.10+）：\n" +
          "  pip install \"paperseek[mcp]\"\n" +
          "配置 LLM（用于生成/迭代检索式，可选但推荐）：\n" +
          "  paperseek config set LLM_API_KEY <your-key>\n" +
          "  paperseek config set LLM_BASE_URL <endpoint>\n" +
          "  paperseek config set LLM_MODEL <model>\n" +
          "验证：paperseek sources（查看数据源） / paperseek doctor（诊断配置）\n" +
          "也可配置为 MCP server 接入（见 README「PaperSeek MCP」）。"
        );
      }
      if (name !== "search") return `paper_seek 连接器没有工具: ${name}`;

      const query = String(args.query ?? "").trim();
      if (!query) return "⚠️ paper_seek search 需要 query。";
      // OpenAlex 现在需要付费额度（429），默认用免费数据源 arxiv；可选 crossref/semanticscholar/pubmed
      const source = String(args.source || "arxiv");
      const max = Math.min(Number(args.max ?? 8) || 8, 20);
      const min = Number(args.min ?? 3) || 3;
      const iters = Math.min(Number(args.iterations ?? 2) || 2, 5);

      // 构造 CLI 参数
      const cliArgs = ["search", query, "--source", source, "--output", "json", "--max", String(max), "--min", String(min), "--iterations", String(iters)];
      if (args.discipline) cliArgs.push("--field", String(args.discipline));

      try {
        const out = await runCli("paperseek", cliArgs, 120000);
        const papers = parsePapers(out);
        if (!papers.length) {
          // 无输出：查询 PaperSeek 历史定位根因（最常见是缺 LLM_API_KEY）
          const err = await getLastError();
          if (err && /LLM_API_KEY/i.test(err)) {
            return (
              "⚠️ PaperSeek 检索需要配置 LLM API Key（用于自动生成/迭代检索式）。\n" +
              `检测到错误：${err}\n` +
              "配置方法：paperseek config set LLM_API_KEY <your-key>（或用 freesek.providers 的某个 OpenAI 兼容 key）。\n" +
              "也可改用 web_search 检索论文。"
            );
          }
          return (
            `检索「${query}」未返回结构化论文。\n` +
            (err ? `诊断：${err}\n` : "") +
            "可调用 paper_seek__install_hint 查看安装/配置指引，或改用 web_search。"
          );
        }
        const lines = papers.slice(0, max).map((p, i) =>
          `${i + 1}. ${p.title || "(无标题)"}\n` +
          `   作者: ${p.authors || "—"} · ${p.year ? p.year + "年" : "—"} · 引用 ${p.citations ?? 0}\n` +
          `   ${p.link || ""}\n` +
          `   摘要: ${(p.abstract || "—").slice(0, 240)}${(p.abstract || "").length > 240 ? "…" : ""}`
        );
        return `学术检索「${query}」（来源: ${source}）：\n\n${lines.join("\n\n")}\n\n提示：可用 web_fetch 抓取论文链接获取全文，或用 web_search 补充背景。`;
      } catch (e: any) {
        const msg = e?.message ?? String(e);
        if (/not found|No such file|not recognized|未找到/i.test(msg)) {
          return (
            "⚠️ 未检测到 PaperSeek CLI。请先安装：pip install \"paperseek[mcp]\"（需 Python 3.10+）。\n" +
            "详细指引可调用 paper_seek__install_hint。或改用 web_search 检索论文。"
          );
        }
        return `paper_seek 检索失败：${msg}`;
      }
    },
  });
}

/** 读取 PaperSeek 最近一次检索的错误信息（通过 history list --json），用于无输出时的根因定位。 */
async function getLastError(): Promise<string> {
  try {
    const out = await runCli("paperseek", ["history", "list", "--json"], 15000);
    const j = JSON.parse(out);
    const hist = Array.isArray(j?.history) ? j.history : [];
    for (const h of hist) {
      if (h?.error_message) return String(h.error_message);
    }
    return "";
  } catch {
    return "";
  }
}

/** 运行 CLI 命令并返回 stdout（带超时）。 */
function runCli(bin: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve(stdout);
    });
  });
}

/** 解析 PaperSeek CLI 的 JSON 输出为论文列表（容忍多种字段名/结构）。 */
function parsePapers(output: string): Array<{
  title?: string;
  authors?: string;
  year?: string;
  citations?: number;
  link?: string;
  abstract?: string;
}> {
  try {
    const j = JSON.parse(output);
    // 尝试多种可能结构
    const arr = Array.isArray(j)
      ? j
      : j?.papers ?? j?.results ?? j?.candidates ?? j?.data ?? [];
    return arr
      .map((p: any) => ({
        title: p?.title || p?.name || undefined,
        authors: Array.isArray(p?.authors)
          ? p.authors.slice(0, 3).map((a: any) => a?.name || a).join(", ")
          : p?.authors
            ? String(p.authors)
            : undefined,
        year: p?.year != null ? String(p.year) : p?.publication_date?.slice(0, 4),
        citations: p?.citations ?? p?.cited_by_count ?? p?.citation_count,
        link: p?.link || p?.url || p?.openalex_url || p?.arxiv_id || undefined,
        abstract: p?.abstract || p?.summary || undefined,
      }))
      .filter((p: any) => p.title);
  } catch {
    return [];
  }
}
