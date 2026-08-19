#!/usr/bin/env node
/**
 * promptFragments 回放检查脚本（零依赖，Node 18+）。
 *
 * 回放会话事件日志（events-*.jsonl）中由 buildSystemPrompt 记录的 `prompt_manifest`
 * 事件，校验有界片段组装的不变量：
 *   A. 合计 token ≤ maxTotalTokens（injected + truncated 之和）；
 *   B. 每个 injected 片段 token ≤ maxFragmentTokens（truncated 本身即"超限已截断"标记，豁免）；
 *   C. system-core 片段必须存在且 injected（基础人格永不被丢弃）；
 *   D. 不允许出现 kind="protocol" 的片段（关键协议绝不参与组装）；
 *   E. 协议尾不变量：promptTail 以 endMarker 结尾，且不含截断/丢弃标记
 *      （若协议被误当作片段组装或组装顺序被改动，尾部将暴露截断/丢弃内容）。
 *
 * 用法：
 *   node scripts/check-fragments.mjs --self                   内置示例回放自检
 *   node scripts/check-fragments.mjs --file <events-*.jsonl>  回放单个会话事件日志
 *   node scripts/check-fragments.mjs --dir <dir>              扫描目录下所有 events-*.jsonl
 *
 * 退出码：0 全部通过（self 模式含"检测器能抓住违规"的证明）；1 存在违规或读取失败。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const DEFAULT_MAX_FRAGMENT = 8000;
const DEFAULT_MAX_TOTAL = 24000;

/** 单条 prompt_manifest 事件校验。返回违规列表（空 = 通过）。 */
export function checkManifestEvent(ev) {
  const problems = [];
  const data = ev?.data;
  if (!data || typeof data !== "object") {
    return [`seq ${ev?.seq ?? "?"}: prompt_manifest 事件缺 data`];
  }
  const opts = data.opts ?? {};
  const maxFragment = opts.maxFragmentTokens ?? DEFAULT_MAX_FRAGMENT;
  const maxTotal = opts.maxTotalTokens ?? DEFAULT_MAX_TOTAL;
  const manifest = Array.isArray(data.manifest) ? data.manifest : [];

  // A. 合计 token ≤ maxTotalTokens
  const total = manifest
    .filter((m) => m.status === "injected" || m.status === "truncated")
    .reduce((s, m) => s + (Number(m.tokens) || 0), 0);
  if (total > maxTotal) {
    problems.push(`seq ${ev.seq}: 合计 ${total}t > 上限 ${maxTotal}t`);
  }

  // B. injected 片段不超过单片段上限（truncated 豁免）
  for (const m of manifest) {
    if (m.status === "injected" && (Number(m.tokens) || 0) > maxFragment) {
      problems.push(`seq ${ev.seq}: 片段 ${m.key} 注入 ${m.tokens}t > 单片段上限 ${maxFragment}t`);
    }
  }

  // C. system-core 必须 injected
  const core = manifest.find((m) => m.key === "system-core");
  if (!core) {
    problems.push(`seq ${ev.seq}: 缺失 system-core 片段`);
  } else if (core.status !== "injected") {
    problems.push(`seq ${ev.seq}: system-core 状态为 ${core.status}（必须 injected）`);
  }

  // D. 不允许 kind=protocol 的片段
  if (manifest.some((m) => m.kind === "protocol")) {
    problems.push(`seq ${ev.seq}: 存在 kind=protocol 片段（关键协议不可参与组装）`);
  }

  // E. 协议尾不变量
  const proto = data.protocol;
  if (proto && typeof proto === "object") {
    const tail = String(proto.promptTail ?? "");
    const endMarker = String(proto.endMarker ?? "").trim();
    if (!endMarker) {
      problems.push(`seq ${ev.seq}: protocol.endMarker 为空`);
    } else if (!tail.trimEnd().endsWith(endMarker)) {
      problems.push(`seq ${ev.seq}: 协议尾不匹配（endMarker=${JSON.stringify(endMarker)} 不在 promptTail 末尾）`);
    }
    if (tail.includes("已截断") || tail.includes("未注入片段")) {
      problems.push(`seq ${ev.seq}: 协议尾包含片段截断/丢弃标记（组装顺序疑似被改动）`);
    }
  }

  // F. 前缀稳定性（缓存友好不变量）：core/time/rules/tools 必须作为稳定前缀，
  // 任何非核心 kind 之后不得再出现核心 kind（保证 prompt 前缀可命中缓存、不被动态重排）。
  const CORE_KINDS = new Set(["core", "time", "rules", "tools"]);
  let seenNonCore = false;
  for (const m of manifest) {
    if (m.status !== "injected" && m.status !== "truncated") continue;
    const isCore = CORE_KINDS.has(m.kind);
    if (seenNonCore && isCore) {
      problems.push(
        `seq ${ev.seq}: 前缀稳定性被破坏（${m.kind}/${m.key} 出现在非核心片段之后）`
      );
      break;
    }
    if (!isCore) seenNonCore = true;
  }

  return problems;
}

/** 解析 JSONL 事件日志，返回所有 prompt_manifest 事件。 */
export function readManifestEvents(file) {
  const out = [];
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // 跳过损坏行
    }
    if (ev?.type === "prompt_manifest") out.push(ev);
  }
  return out;
}

/** 校验一组事件，打印结果，返回违规总数。 */
function runChecks(events, label) {
  if (!events.length) {
    console.log(`  （${label}：无 prompt_manifest 事件，跳过）`);
    return 0;
  }
  let bad = 0;
  for (const ev of events) {
    const problems = checkManifestEvent(ev);
    if (problems.length) {
      bad++;
      for (const p of problems) console.log(`  ✗ ${p}`);
    }
  }
  if (bad === 0) console.log(`  ✓ ${label}：${events.length} 条 prompt_manifest 全部通过`);
  else console.log(`  ✗ ${label}：${events.length} 条中 ${bad} 条违规`);
  return bad;
}

/** self 模式：内置示例证明检测器逻辑（一个应通过 + 一个应被抓出）。 */
function selfCheck() {
  let ok = true;
  const valid = {
    seq: 1,
    type: "prompt_manifest",
    data: {
      opts: { maxFragmentTokens: 8000, maxTotalTokens: 24000 },
      manifest: [
        { key: "system-core", title: "", kind: "core", status: "injected", tokens: 800, chars: 2000 },
        { key: "time", title: "", kind: "time", status: "injected", tokens: 50, chars: 200 },
        { key: "tools", title: "工具清单", kind: "tools", indexOnly: true, status: "injected", tokens: 1200, chars: 4800 },
        { key: "skills", title: "", kind: "skills", indexOnly: true, status: "dropped", tokens: 0, chars: 0 },
      ],
      protocol: {
        key: "REACT_PROTOCOL",
        promptTail: "…省略…\n请用 <tool_call> 包裹工具调用。",
        endMarker: "请用 <tool_call> 包裹工具调用。",
      },
    },
  };
  const invalid = {
    seq: 2,
    type: "prompt_manifest",
    data: {
      opts: { maxFragmentTokens: 8000, maxTotalTokens: 24000 },
      manifest: [
        { key: "system-core", title: "", kind: "core", status: "dropped", tokens: 0, chars: 0 },
        { key: "tools", title: "", kind: "tools", status: "injected", tokens: 99999, chars: 4 },
        { key: "fake-proto", title: "", kind: "protocol", status: "injected", tokens: 5, chars: 10 },
      ],
      protocol: {
        key: "NATIVE_TOOL_GUIDANCE",
        promptTail: "## 未注入片段（超出上限）\n一些丢弃说明",
        endMarker: "请用工具。",
      },
    },
  };
  const vProblems = checkManifestEvent(valid);
  const iProblems = checkManifestEvent(invalid);
  if (vProblems.length) {
    ok = false;
    console.log("  ✗ self: 合法示例被误报：" + vProblems.join("; "));
  } else {
    console.log("  ✓ self: 合法示例通过");
  }
  const expectedViolations = ["system-core", "99999", "protocol", "截断/丢弃标记"];
  const iText = iProblems.join(" | ");
  const caughtAll = expectedViolations.every((v) => iText.includes(v));
  if (iProblems.length && caughtAll) {
    console.log(`  ✓ self: 违规示例被抓出（${iProblems.length} 条违规）`);
  } else {
    ok = false;
    console.log(`  ✗ self: 违规示例检测不完整（实际：${iText}）`);
  }

  // 前缀稳定性违规示例：skills（非核心）之后又出现 tools（核心），应被抓出。
  const badOrder = {
    seq: 3,
    type: "prompt_manifest",
    data: {
      opts: { maxFragmentTokens: 8000, maxTotalTokens: 24000 },
      manifest: [
        { key: "system-core", title: "", kind: "core", status: "injected", tokens: 100, chars: 400 },
        { key: "skills", title: "", kind: "skills", status: "injected", tokens: 100, chars: 400 },
        { key: "tools", title: "", kind: "tools", status: "injected", tokens: 100, chars: 400 },
      ],
      protocol: { key: "REACT_PROTOCOL", promptTail: "…tail", endMarker: "tail" },
    },
  };
  const oProblems = checkManifestEvent(badOrder);
  if (oProblems.some((p) => p.includes("前缀稳定性"))) {
    console.log("  ✓ self: 前缀稳定性违规示例被抓出");
  } else {
    ok = false;
    console.log(`  ✗ self: 前缀稳定性违规示例未检测到（实际：${oProblems.join(" | ") || "无"}）`);
  }

  return ok;
}

function usage() {
  console.log(
    [
      "用法：",
      "  node scripts/check-fragments.mjs --self                  内置示例自检",
      "  node scripts/check-fragments.mjs --file <events-*.jsonl> 回放单个事件日志",
      "  node scripts/check-fragments.mjs --dir <dir>             扫描目录下所有 events-*.jsonl",
    ].join("\n")
  );
  process.exit(2);
}

function main() {
  const args = process.argv.slice(2);
  let bad = 0;
  let checked = false;

  if (args.includes("--self")) {
    checked = true;
    bad += selfCheck() ? 0 : 1;
  }
  const fileIdx = args.indexOf("--file");
  if (fileIdx >= 0) {
    checked = true;
    const file = args[fileIdx + 1];
    if (!file) usage();
    const events = readManifestEvents(resolve(file));
    bad += runChecks(events, basename(file));
  }
  const dirIdx = args.indexOf("--dir");
  if (dirIdx >= 0) {
    checked = true;
    const dir = args[dirIdx + 1];
    if (!dir) usage();
    const files = readdirSync(dir)
      .filter((f) => f.startsWith("events-") && f.endsWith(".jsonl"))
      .sort();
    if (!files.length) {
      console.log(`  （${dir} 无 events-*.jsonl，跳过）`);
    } else {
      for (const f of files) {
        const events = readManifestEvents(join(dir, f));
        bad += runChecks(events, f);
      }
    }
  }

  if (!checked) usage();
  console.log(bad === 0 ? "✓ fragments check 全部通过" : `✗ fragments check 未通过（${bad} 处违规）`);
  process.exit(bad === 0 ? 0 : 1);
}

main();
