#!/usr/bin/env node
/**
 * FreeSeek 单元测试 runner（零新依赖）：
 * 1) 优先用 esbuild bundle tests/*.test.ts；
 * 2) 若 node_modules 来自其它平台导致 esbuild 原生二进制不可用，自动回退到 tsc emit；
 * 3) 用 Node 内置 node:test 执行。
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(ROOT, "tests");
const BUILD = join(TESTS, ".build");

function run(cmd, args, useShell = true, stdio = "inherit") {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio,
    shell: useShell && process.platform === "win32",
  });
  return r.status ?? 1;
}

if (!existsSync(TESTS)) {
  console.log("tests/ 目录不存在，跳过");
  process.exit(0);
}
const testFiles = readdirSync(TESTS).filter((f) => f.endsWith(".test.ts"));
if (!testFiles.length) {
  console.log("未找到 tests/*.test.ts");
  process.exit(0);
}

rmSync(BUILD, { recursive: true, force: true });
mkdirSync(BUILD, { recursive: true });

function buildWithEsbuild() {
  const esbuildBin = join(ROOT, "node_modules", "esbuild", "bin", "esbuild");
  const vscodeAlias = ["--alias:vscode=" + join(TESTS, "stubs", "vscode.ts")];
  const built = [];
  for (const f of testFiles) {
    const out = join(BUILD, f.replace(/\.ts$/, ".cjs"));
    const status = run(process.execPath, [
      esbuildBin,
      join(TESTS, f),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${out}`,
      "--log-level=error",
      ...vscodeAlias,
    ], false, "pipe");
    if (status !== 0) return null;
    built.push(out);
  }
  // esbuild 布局下，部分测试（acp-cli-stdio / desktop-runtime-e2e）会以 __dirname/../src
  // 定位已编译的 CLI/ACP 入口（即 <root>/tests/src/<name>.js）。这里把两个入口预置到该位置，
  // 且不带 __FREESEEK_CLI_ENTRY__ define（避免模块加载即自动启动，与 tsc emit 行为一致）。
  const entryBundles = [
    ["src/acp-server.ts", "acp-server.js"],
    ["src/cli.ts", "cli.js"],
  ];
  const srcStaging = join(TESTS, "src");
  mkdirSync(srcStaging, { recursive: true });
  for (const [entry, outName] of entryBundles) {
    const status = run(process.execPath, [
      esbuildBin,
      join(ROOT, entry),
      "--bundle",
      "--platform=node",
      "--format=cjs",
      `--outfile=${join(srcStaging, outName)}`,
      "--external:vscode",
      "--external:esbuild",
      "--external:node:*",
      "--log-level=error",
    ], false, "pipe");
    if (status !== 0) return null;
  }
  return built;
}

function buildWithTsc() {
  console.warn("[FreeSeek test] esbuild 不可用/平台不匹配，回退到 tsc + node:test。 ");
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  const status = run(process.execPath, [
    tsc,
    "-p", "tsconfig.tests.json",
    "--noEmit", "false",
    "--outDir", BUILD,
    "--rootDir", ROOT,
  ], false);
  if (status !== 0) process.exit(status);

  // tsc 不会改写 bare `require("vscode")`；把测试 stub 放到输出树 node_modules 供 Node 解析。
  const stub = join(BUILD, "tests", "stubs", "vscode.js");
  const stubDir = join(BUILD, "node_modules", "vscode");
  mkdirSync(stubDir, { recursive: true });
  copyFileSync(stub, join(stubDir, "index.js"));
  return testFiles.map((f) => join(BUILD, "tests", f.replace(/\.ts$/, ".js")));
}

const built = buildWithEsbuild() ?? buildWithTsc();
process.exit(run(process.execPath, ["--test", ...built], false));
