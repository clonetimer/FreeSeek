/**
 * 模型可见上下文纪律（对标 Codex core/context 的 bounded fragments + current_time.rs）：
 * 所有注入系统提示词的片段（规则 / 记忆 / 技能索引 / 工具清单 …）都必须有界：
 *  - 单片段预估 token 上限：超过则截断（保留头部 + 尾部，中间省略）并在头部标注 ⚠️；
 *  - 全部片段合计硬上限：超出上限的低优先级片段整体丢弃，并列出清单供模型按需读取；
 *  - 关键协议（ReAct / 原生工具指引）不参与组装，由调用方在组装结果之后追加，绝不被截断。
 * 同时提供「当前时间」片段的注入与轻量刷新（长会话中模型仍能感知"现在"）。
 *
 * ContextualFragment 契约：所有动态片段收敛为统一结构化形状（key/kind/source/indexOnly），
 * 组装器同时产出「片段清单 manifest」（谁注入 / 谁截断 / 谁丢弃），供 scripts/check-fragments.mjs
 * 回放检查（见 scripts/check-fragments.mjs --help）。
 *
 * 缓存友好纪律（对标 Codex core/context 的「增量构建避免 history 重写与 cache miss」）：
 *  - 核心片段（core / time / rules / tools）顺序必须稳定且在最前，作为「前缀」；
 *    动态/低频片段（memory / skills / mcp / goal）放在其后。这样模型首轮之后的请求能命中
 *    prompt 前缀缓存（如 provider 的 prompt-cache），避免每次重建整段系统提示词。
 *  - 禁止「为每次调用动态重排核心片段」；时间片段只做轻量替换（refreshPromptTime），
 *    不触发整段重建（对齐 AGENTS.md「当前时间用 refreshPromptTime 轻量替换」）。
 *  - 被截断/丢弃的片段仅影响尾部可变区，不改变前缀稳定性。
 */

// token 估算统一收敛到 context.ts 的 estimateTokens（单一实现，避免两处口径不同）。
import { estimateTokens } from "./context";

export interface PromptFragment {
  /** 片段标题（组装时渲染为 `## 标题`；传空串则原样嵌入 content，不追加标题）。 */
  title: string;
  content: string;
}

/** 片段类别（回放检查按类聚合统计；protocol 保留给"关键协议"，禁止作为片段组装）。 */
export type FragmentKind =
  | "core"
  | "time"
  | "rules"
  | "goal"
  | "skills"
  | "memory"
  | "tools"
  | "connectors"
  | "mcp"
  | "slash"
  | "subagents"
  | "guidance"
  | "protocol"
  | "other";

/**
 * 收敛后的片段契约：在 PromptFragment 之上补充可审计元数据。
 * 所有经 assembleBoundedFragmentsWithManifest 注入的动态片段都应携带 key/kind；
 * priority 仅在需要显式覆盖"数组顺序即优先级"时使用（数字越小越优先保留）。
 */
export interface ContextualFragment extends PromptFragment {
  /** 片段稳定标识（审计/回放用，如 "rules:AGENTS.md"、"memory"、"skills"）。 */
  key?: string;
  /** 片段类别（回放检查按类聚合统计）。 */
  kind?: FragmentKind;
  /** 丢弃优先级：数字越小越优先保留；缺省按数组顺序（越靠前越优先）。 */
  priority?: number;
  /** 来源（如文件路径 / 配置项），便于排查。 */
  source?: string;
  /** 是否为索引型片段（渐进式披露：只放标题+描述，完整内容需工具按需加载）。 */
  indexOnly?: boolean;
}

export interface FragmentOptions {
  /** 单片段预估 token 上限（默认 8000，超出截断）。 */
  maxFragmentTokens?: number;
  /** 预估 token 超过该值（默认 2500）在片段头部加 ⚠️ 提示，提醒模型只提取关键信息。 */
  warnAtTokens?: number;
  /** 全部片段合计预估 token 硬上限（默认 24000，超出丢弃靠后片段）。 */
  maxTotalTokens?: number;
}

/** 组装结果中单个片段的处置记录（回放检查输入）。 */
export interface FragmentManifestEntry {
  /** 片段 key（无 key 时回退为 `#index`）。 */
  key: string;
  /** 片段标题。 */
  title: string;
  /** 片段类别。 */
  kind: FragmentKind;
  /** 来源（文件路径 / 配置项，可能缺省）。 */
  source?: string;
  /** 是否为索引型片段。 */
  indexOnly: boolean;
  /** 处置结果：injected 注入 / truncated 超限截断后注入 / dropped 超总量丢弃 / empty 空内容跳过。 */
  status: "injected" | "truncated" | "dropped" | "empty";
  /** 实际注入（或截断后）片段的预估 token 数。 */
  tokens: number;
  /** 实际注入（或截断后）片段的字符数。 */
  chars: number;
}

interface Kept extends FragmentManifestEntry {
  block: string;
  index: number;
  pri: number;
}

/**
 * 有界片段组装器（带清单）：逐片段检查大小与总量，产出可注入系统提示词的正文与
 * 处置清单。清单供 scripts/check-fragments.mjs 回放校验（bounds / 协议尾 / 必保留片段）。
 * 返回的 prompt 不含结尾协议；调用方负责在末尾追加不可截断的协议（ReAct / 原生工具指引）。
 *
 * 缓存友好不变量：入参 fragments 的顺序即「优先级 + 前缀稳定性」——调用方必须保证
 * core/time/rules/tools 等核心片段在最前且顺序稳定（见文件头缓存友好纪律），本函数
 * 严格按入参顺序拼接，不在内部重排，从而维持 prompt 前缀可缓存。
 */
export function assembleBoundedFragmentsWithManifest(
  fragments: ContextualFragment[],
  opts: FragmentOptions = {}
): { prompt: string; manifest: FragmentManifestEntry[] } {
  const maxFragmentTokens = opts.maxFragmentTokens ?? 8000;
  const warnAtTokens = opts.warnAtTokens ?? 2500;
  const maxTotalTokens = opts.maxTotalTokens ?? 24000;

  // 丢弃优先级：显式 priority 越小越优先保留；缺省按数组顺序（1000+index，越靠前越优先）。
  const dp = (f: ContextualFragment, i: number): number => f.priority ?? 1000 + i;

  const used: Kept[] = [];
  const dropped: { key: string; title: string; reason: "budget" | "empty" }[] = [];
  let total = 0;

  fragments.forEach((f, i) => {
    const key = f.key ?? `#${i}`;
    const content = String(f.content ?? "").trim();
    if (!content) {
      dropped.push({ key, title: f.title, reason: "empty" });
      return;
    }

    let body = content;
    let est = estimateTokens(body);
    let head = "";
    if (est > warnAtTokens) {
      head = `⚠️ 以下片段较大（约 ${est} tokens），请只提取关键信息，不要全文复述。\n`;
    }
    let status: "injected" | "truncated" = "injected";
    if (est > maxFragmentTokens) {
      status = "truncated";
      const keepHead = Math.floor(body.length * 0.6);
      const keepTail = Math.floor(body.length * 0.15);
      body =
        body.slice(0, keepHead) +
        `\n…（该片段约 ${est} tokens，超出单片段上限 ${maxFragmentTokens}，已截断，如需完整内容请用工具读取）…\n` +
        body.slice(body.length - keepTail);
      est = estimateTokens(body);
    }
    const block = (f.title ? `## ${f.title}\n` : "") + head + body;
    const estBlock = estimateTokens(block);
    const entry: Kept = {
      key,
      title: f.title,
      kind: f.kind ?? "other",
      source: f.source,
      indexOnly: f.indexOnly ?? false,
      status,
      tokens: estBlock,
      chars: block.length,
      block,
      index: i,
      pri: dp(f, i),
    };

    if (total + estBlock <= maxTotalTokens) {
      used.push(entry);
      total += estBlock;
      return;
    }
    // 超总量：若新片段显式更优先（priority 更小）且存在更低优先的已保留片段 → 置换；
    // 否则丢弃新片段。缺省 priority 时永不置换（保持原"丢弃靠后片段"语义）。
    const swap = used.findIndex((k) => k.pri > entry.pri);
    if (swap >= 0) {
      total -= used[swap].tokens;
      dropped.push({ key: used[swap].key, title: used[swap].title, reason: "budget" });
      used[swap] = entry;
      total += estBlock;
    } else {
      dropped.push({ key, title: f.title, reason: "budget" });
    }
  });

  // 保持原始数组顺序输出（显式 priority 只影响"保留谁"，不影响"输出顺序"）。
  used.sort((a, b) => a.index - b.index);
  let out = used.map((k) => k.block).join("\n\n---\n\n");
  const budgetDropped = dropped.filter((d) => d.reason === "budget");
  if (budgetDropped.length) {
    out +=
      `\n\n---\n\n## 未注入片段（超出系统提示词总量上限 ${maxTotalTokens} tokens，已按优先级丢弃）\n` +
      `以下内容未注入，如有需要请用对应工具读取：${budgetDropped.map((d) => d.title || d.key).join("、")}`;
  }

  const manifest: FragmentManifestEntry[] = [
    ...used.map((k) => ({
      key: k.key,
      title: k.title,
      kind: k.kind,
      source: k.source,
      indexOnly: k.indexOnly,
      status: k.status,
      tokens: k.tokens,
      chars: k.chars,
    })),
    ...dropped.map((d) => ({
      key: d.key,
      title: d.title,
      kind: "other" as const,
      source: undefined,
      indexOnly: false,
      status: (d.reason === "budget" ? "dropped" : "empty") as "dropped" | "empty",
      tokens: 0,
      chars: 0,
    })),
  ];
  return { prompt: out, manifest };
}

/**
 * 有界片段组装器（兼容入口）：只返回组装后的字符串，行为与旧版一致。
 * 新代码建议使用 assembleBoundedFragmentsWithManifest 以获得处置清单（回放审计）。
 */
export function assembleBoundedFragments(
  fragments: PromptFragment[],
  opts: FragmentOptions = {}
): string {
  return assembleBoundedFragmentsWithManifest(fragments as ContextualFragment[], opts).prompt;
}

/** 将处置清单渲染为可读文本（调试 / eventlog 审计）。 */
export function renderFragmentManifest(manifest: FragmentManifestEntry[]): string {
  if (!manifest.length) return "(空 manifest)";
  const pad = (s: string, n: number): string => s.padEnd(n);
  const lines = manifest.map((m) => {
    const badge = m.status === "injected" ? "inject" : m.status === "truncated" ? "trunc " : m.status === "dropped" ? "drop  " : "empty ";
    return `- [${badge}] ${pad(m.kind, 11)} ${pad(m.key, 26)} ${m.tokens}t/${m.chars}c${m.indexOnly ? " [index]" : ""}`;
  });
  return `## prompt-manifest\n${lines.join("\n")}`;
}

/** 当前时间片段头（供轻量刷新识别）。 */
export const TIME_HEADER = "## 当前时间";
/** 时间片段结束标记：refreshPromptTime 据此定位并整块替换。 */
const TIME_END = "<!--FREESEEK_TIME_END-->";

function nowText(): string {
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const offsetMin = -now.getTimezoneOffset();
  const offsetSign = offsetMin >= 0 ? "+" : "-";
  const offsetAbs = Math.abs(offsetMin);
  const offset =
    offsetSign +
    String(Math.floor(offsetAbs / 60)).padStart(2, "0") +
    ":" +
    String(offsetAbs % 60).padStart(2, "0");
  const weekday = ["日", "一", "二", "三", "四", "五", "六"][now.getDay()];
  const local = now.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${local} 星期${weekday}（${tz}，UTC${offset}）\nISO: ${now.toISOString()}`;
}

/** 生成「当前时间」片段（含结束标记，供刷新）。 */
export function currentTimeBlock(): string {
  return `${TIME_HEADER}\n${nowText()}\n${TIME_END}`;
}

/**
 * 轻量刷新系统提示词中的时间片段：仅替换 `## 当前时间 … <!--FREESEEK_TIME_END-->` 整块，
 * 不重建整个 prompt（避免长会话中反复读盘）。未找到时间片段则原样返回。
 */
export function refreshPromptTime(prompt: string): string {
  const idx = prompt.indexOf(TIME_END);
  if (idx < 0) return prompt;
  const start = prompt.lastIndexOf("##", idx);
  if (start < 0) return prompt;
  const end = idx + TIME_END.length;
  // 保留块前分隔符与块后的内容
  return prompt.slice(0, start) + currentTimeBlock() + prompt.slice(end);
}
