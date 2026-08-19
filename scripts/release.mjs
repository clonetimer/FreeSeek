#!/usr/bin/env node
/**
 * FreeSeek 一键发布（零依赖，Node 18+）。
 * 用法：
 *   node scripts/release.mjs                 # patch：0.16.4 → 0.16.5
 *   node scripts/release.mjs --minor         # minor：0.16.4 → 0.17.0
 *   node scripts/release.mjs --major
 *   node scripts/release.mjs --version 0.17.0
 * 流程：
 *   1) npm run check —— 工程门禁（typecheck + hygiene + JSDoc），失败即中止
 *   2) bump package.json version
 *   3) npm run compile —— 生产构建（extension + headless + eval + bench + webview + mermaid）
 *   4) vsce package —— 打包 vsix
 *   5) 归拢 vsix 到 releases/ 并追加 CHANGELOG.md 条目
 * 借鉴：codex 发布脚本化（build/release 任务编排）、deepseek-harness 版本纪律。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PKG = join(ROOT, "package.json");
const RELEASES = join(ROOT, "releases");

function run(cmd, args, cwd = ROOT) {
  // Windows 下 npx/npm 是 .cmd，必须走 shell；但 shell:true + args 会触发 Node DEP0190 弃用告警，
  // 因此拼成带引号的单命令字符串再交给 shell（参数引号化避免拼接注入）。
  const r =
    process.platform === "win32"
      ? spawnSync(`${cmd} ${args.map((a) => `"${String(a).replaceAll('"', '\\"')}"`).join(" ")}`, {
          cwd,
          stdio: "inherit",
          shell: true,
        })
      : spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`✗ ${cmd} ${args.join(" ")} 失败，中止发布`);
    process.exit(1);
  }
}

function bump(ver, kind) {
  const [maj, min, pat] = ver.split(".").map(Number);
  if (kind === "major") return `${maj + 1}.0.0`;
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

function main() {
  const argv = process.argv.slice(2);
  let kind = "patch";
  let explicit = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--minor") kind = "minor";
    else if (argv[i] === "--major") kind = "major";
    else if (argv[i] === "--patch") kind = "patch";
    else if (argv[i] === "--version") explicit = argv[++i];
  }
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const next = explicit ?? bump(pkg.version, kind);
  console.log(`── FreeSeek release ${pkg.version} → ${next} ──`);

  console.log("1/6 门禁（npm run check）…");
  run("npm", ["run", "check"]);

  console.log("2/6 版本 bump…");
  pkg.version = next;
  writeFileSync(PKG, JSON.stringify(pkg, null, 2) + "\n", "utf8");

  // CHANGELOG 必须先于 vsce package 更新：vsce 会把 CHANGELOG.md 作为 changelog.md 打进 vsix，
  // 若在打包后才写，安装包内嵌的 changelog 会落后一个版本（v0.17.14-16 曾因此缺条目）。
  console.log("3/6 更新 CHANGELOG.md…");
  const changelog = join(ROOT, "CHANGELOG.md");
  // 优先从 README「更新记录」提取 v{next} 真实条目；未写则占位并提示。
  const entry = (() => {
    const readme = join(ROOT, "README.md");
    if (existsSync(readme)) {
      const md = readFileSync(readme, "utf8");
      const re = new RegExp(`^### v${next}[\\s\\S]*?(?=^### v|^## |\\z)`, "m");
      const m = md.match(re);
      if (m) return m[0].replace(/^### v/, "## v").trim() + "\n\n";
    }
    return `## v${next}\n\n- （发布时请把本次改动写入 README「更新记录」或直接编辑本条。）\n\n`;
  })();
  if (existsSync(changelog)) {
    // 在 "# 标题" 之后插入新条目，避免把 `## v0.x` 顶到文档标题上方
    const cur = readFileSync(changelog, "utf8");
    const m = cur.match(/^# .+\n+/);
    writeFileSync(changelog, m ? `${m[0]}${entry}${cur.slice(m[0].length)}` : `${entry}${cur}`, "utf8");
  } else {
    writeFileSync(changelog, `# FreeSeek 变更日志\n\n${entry}`, "utf8");
  }

  console.log("4/6 生产构建…");
  run("node", ["esbuild.js", "--production"]);

  console.log("5/6 vsce package…");
  // --baseContentUrl 修复新 vsce 对 README 内相对链接的仓库 URL 校验报错
  run("npx", ["vsce", "package", "--baseContentUrl", "https://raw.githubusercontent.com/freeseek/freeseek-copilot/main"]);

  console.log("6/6 归拢产物到 releases/…");
  if (!existsSync(RELEASES)) mkdirSync(RELEASES, { recursive: true });
  const vsix = `freeseek-copilot-${next}.vsix`;
  const from = join(ROOT, vsix);
  if (existsSync(from)) renameSync(from, join(RELEASES, vsix));
  console.log(`✓ release ${next} 完成：releases/${vsix}`);
}

main();
