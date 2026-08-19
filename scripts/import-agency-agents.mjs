#!/usr/bin/env node
/**
 * 从 agency-agents（msitarzewski/agency-agents，MIT）导入精选专家角色到 FreeSeek 项目。
 *
 * 角色文件为「frontmatter + 正文」的 .md，直接放入项目 .agent/agents/，
 * 即可被 spawn_agent(agent: "engineering-xxx") 识别派发（FreeSeek 原生目录约定）。
 *
 * 用法：
 *   node scripts/import-agency-agents.mjs --target <项目根>
 *       --source <agency-agents 路径>  默认 E:\timer\agency-agents
 *       --agents a,b,c                 指定角色（kebab 名，缺省用精选列表）
 *       --all                          导入 engineering 全部分支
 *       --readonly                     对只读类角色补只读 tools 白名单（默认精选只读角色已补）
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DIV = "engineering";
const DEFAULT_SOURCE = "E:\\timer\\agency-agents";

/** 只读角色的默认 tools 白名单（FreeSeek 真实工具名，注入无 tools 声明的角色）。 */
const READONLY_TOOLS = ["read_file", "list_directory", "search_files", "glob", "grep", "lsp", "ask_user", "send_message"];
/** 默认按只读处理、缺 tools 时补白名单的角色（审查/上手/架构类）。 */
const READONLY_AGENTS = new Set([
  "engineering-code-reviewer",
  "engineering-codebase-onboarding-engineer",
  "engineering-incident-response-commander",
  "engineering-backend-architect",
]);

const DEFAULT_AGENTS = [
  "engineering-code-reviewer",
  "engineering-minimal-change-engineer",
  "engineering-codebase-onboarding-engineer",
  "engineering-git-workflow-master",
  "engineering-prompt-engineer",
  "engineering-incident-response-commander",
  "engineering-backend-architect",
  "engineering-frontend-developer",
  "engineering-data-engineer",
  "engineering-devops-automator",
];

function parseArgs(argv) {
  const args = { source: DEFAULT_SOURCE, target: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source" && argv[i + 1]) args.source = argv[++i];
    else if (a === "--target" && argv[i + 1]) args.target = argv[++i];
    else if (a === "--agents" && argv[i + 1]) args.agents = argv[++i];
    else if (a === "--all") args.all = true;
    else if (a === "--readonly") args.readonlyAll = true;
    else if (a === "--help") args.help = true;
  }
  return args;
}

/** 若 frontmatter 已声明 tools 则原样返回；否则在 frontmatter 末尾注入 tools 白名单。 */
function injectToolsIfMissing(content, tools) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!m) return content;
  if (/^\s*tools\s*:/m.test(m[1])) return content;
  const toolsLine = `tools: [${tools.map((t) => `"${t}"`).join(", ")}]`;
  return `---\n${m[1]}\n${toolsLine}\n---\n${m[2]}`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log("用法：node scripts/import-agency-agents.mjs [--source 路径] [--target 项目根] [--agents a,b,c | --all] [--readonly]");
    return;
  }
  const srcDiv = join(args.source, DIV);
  if (!existsSync(srcDiv)) {
    console.error(`✗ 找不到 ${srcDiv}，请用 --source 指定 agency-agents 仓库路径。`);
    process.exit(1);
  }
  const names = args.all
    ? readdirSync(srcDiv).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
    : (args.agents ? args.agents.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_AGENTS);

  const dstDir = join(args.target, ".agent", "agents");
  mkdirSync(dstDir, { recursive: true });
  let imported = 0;
  const skipped = [];
  for (const name of names) {
    const src = join(srcDiv, `${name}.md`);
    if (!existsSync(src)) {
      skipped.push(name);
      continue;
    }
    let content = readFileSync(src, "utf8");
    if (args.readonlyAll || READONLY_AGENTS.has(name)) {
      content = injectToolsIfMissing(content, READONLY_TOOLS);
    }
    writeFileSync(join(dstDir, `${name}.md`), content, "utf8");
    imported++;
  }
  console.log(`✓ 已导入 ${imported}/${names.length} 个角色 → ${dstDir}`);
  if (skipped.length) console.log(`  跳过（源不存在）：${skipped.join(", ")}`);
  if (imported === 0) process.exit(1);
}

main();