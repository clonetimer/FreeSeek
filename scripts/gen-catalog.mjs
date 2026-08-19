#!/usr/bin/env node
/**
 * 从 TOOL_DEFINITIONS（src/tools/defs.ts）生成 docs/tool-catalog.md（零依赖思路：
 * 复用 devDependency esbuild 内联 bundle defs.ts，type-only import 被剥离，无需 vscode 运行时）。
 *
 * 用法：node scripts/gen-catalog.mjs [--write]
 *   --write  覆盖写入 docs/tool-catalog.md（默认只打印到 stdout）
 *
 * 注意：生成文件头部标注"自动生成勿手改"，新增/修改工具定义后重新生成。
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "tool-catalog.md");

/** 按名称前缀把工具归组（保持顺序）。 */
const GROUPS = [
  { label: "文件与代码", prefix: /^(read_file|write_file|edit_file|list_directory|search_files|glob|grep|delete_file)$/ },
  { label: "命令与执行", prefix: /^(run_command|run_python|run_code|verify)$/ },
  { label: "计划与目标", prefix: /^(todo_write|todo_read|goal|goal_view)$/ },
  { label: "记忆与技能", prefix: /^(remember|load_skill|promote_skill)$/ },
  { label: "子代理与团队", prefix: /^(spawn_agent|spawn_agents|send_message|create_worktree|remove_worktree|list_worktrees|job_list|job_output|job_kill)$/ },
  { label: "检查点", prefix: /^(checkpoint|rewind|list_checkpoints)$/ },
  { label: "联网与浏览器", prefix: /^(web_search|web_fetch|browser)$/ },
  { label: "代码智能", prefix: /^lsp$/ },
  { label: "交互与指令", prefix: /^(ask_user|slash_command)$/ },
];

/** 参数 schema → 可读描述（必填标 *）。 */
function fmtParams(fn) {
  const props = fn.parameters?.properties ?? {};
  const required = new Set(fn.parameters?.required ?? []);
  const keys = Object.keys(props);
  if (!keys.length) return "—";
  return keys
    .map((k) => {
      const p = props[k];
      const star = required.has(k) ? "*" : "";
      const enums = Array.isArray(p.enum) ? `（${p.enum.join("/")}）` : "";
      return `${k}${star}${enums}`;
    })
    .join(", ");
}

async function main() {
  let code;
  try {
    const result = await build({
      stdin: {
        contents: `import { TOOL_DEFINITIONS } from "./src/tools/defs";\nexport const __CATALOG__ = TOOL_DEFINITIONS.map(t => t.function);`,
        resolveDir: ROOT,
        loader: "ts",
        sourcefile: "catalog-entry.ts",
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      logLevel: "silent",
    });
    const mod = { exports: {} };
    const req = createRequire(import.meta.url);
    new Function("module", "exports", "require", result.outputFiles[0].text)(mod, mod.exports, req);
    code = mod.exports.__CATALOG__;
  } catch (e) {
    console.error("✗ 构建工具定义失败：", e.message);
    process.exit(1);
  }

  const fns = Array.isArray(code) ? code : null;
  if (!fns || !fns.length) {
    console.error("✗ 未能从 TOOL_DEFINITIONS 提取工具函数（可能 defs.ts 结构变化）");
    process.exit(1);
  }

  const grouped = GROUPS.map((g) => ({
    label: g.label,
    items: fns.filter((f) => g.prefix.test(f.name)),
  })).filter((g) => g.items.length);
  const ungrouped = fns.filter((f) => !GROUPS.some((g) => g.prefix.test(f.name)));

  const lines = [];
  lines.push(`# 工具目录（Tool Catalog）`);
  lines.push("");
  lines.push(`> 本文件由 \`scripts/gen-catalog.mjs\` 从 \`src/tools/defs.ts\` 的 TOOL_DEFINITIONS 自动生成，**勿手改**。`);
  lines.push(`> 重新生成：\`node scripts/gen-catalog.mjs --write\``);
  lines.push("");
  lines.push(`共 **${fns.length}** 个内置工具（不含 MCP / 连接器动态注入的工具；实际可用集合由 \`getAllToolDefinitions()\` 合并）。`);
  lines.push(`参数列中带 \`*\` 为必填。`);
  lines.push("");
  for (const g of grouped) {
    lines.push(`## ${g.label}`);
    lines.push("");
    lines.push(`| 工具 | 说明 | 参数 |`);
    lines.push(`| --- | --- | --- |`);
    for (const f of g.items) {
      const desc = String(f.description ?? "").replace(/\s+/g, " ").trim();
      lines.push(`| \`${f.name}\` | ${desc} | ${fmtParams(f)} |`);
    }
    lines.push("");
  }
  if (ungrouped.length) {
    lines.push(`## 其他`);
    lines.push("");
    lines.push(`| 工具 | 说明 | 参数 |`);
    lines.push(`| --- | --- | --- |`);
    for (const f of ungrouped) {
      const desc = String(f.description ?? "").replace(/\s+/g, " ").trim();
      lines.push(`| \`${f.name}\` | ${desc} | ${fmtParams(f)} |`);
    }
    lines.push("");
  }
  lines.push(`## 权限与可用性说明`);
  lines.push("");
  lines.push(`- \`run_command\` / \`verify\` / \`run_python\` / \`run_code\` 需 \`freesek.allowShell\` 开启（默认关闭）。`);
  lines.push(`- \`web_search\` / \`web_fetch\` / \`browser\` 受 \`freesek.allowNetwork\` 控制（默认开启）；\`browser\` 仅在 Craft 模式可用（plan/ask 拦截）。`);
  lines.push(`- \`delete_file\` 为 Safe-Delete（转系统回收站），且不可删除工作区外路径。`);
  lines.push(`- \`verify\` / \`run_code\` / \`run_python\` 等带超时与输出截断，防长输出撑爆上下文。`);
  lines.push(`- 动态工具：MCP server 工具以 \`mcp__<name>__<tool>\` 注入；连接器工具以 \`conn__<id>__<tool>\` 注入，均不由本目录收录。`);
  lines.push("");

  const md = lines.join("\n");
  if (process.argv.includes("--write")) {
    writeFileSync(OUT, md, "utf8");
    console.log(`✓ 已生成 ${OUT}（${fns.length} 个工具，${grouped.length} 个分组）`);
  } else {
    console.log(md);
  }
}

main();
