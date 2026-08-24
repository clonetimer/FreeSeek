import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runCode } from "../src/tools/exec_code";
import { executeToolBody, type ToolContext } from "../src/tools";
import { preToolUse, scanFileContent } from "../src/hooks";

function context(root: string): ToolContext {
  return {
    workspaceRoot: root,
    allowShell: true,
    allowNetwork: false,
    askUser: async () => "",
    todoState: { items: [] },
    sandboxMode: "off",
    commandTimeout: 30_000,
  } as ToolContext;
}

test("run_code javascript: CommonJS require 相对 cwd/workspace 解析", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-run-code-cjs-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "value.js"), "module.exports = { value: 42 };\n", "utf8");
    const out = await runCode(context(root), {
      language: "javascript",
      code: "console.log(require('./src/value').value)",
    });
    assert.match(out, /exit 0/);
    assert.match(out, /42/);
    assert.match(out, /commonjs/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run_code javascript: ESM import 自动使用 module 且相对 cwd 解析", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-run-code-esm-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "value.mjs"), "export const value = 43;\n", "utf8");
    const out = await runCode(context(root), {
      language: "javascript",
      code: "import { value } from './src/value.mjs'; console.log(value);",
    });
    assert.match(out, /exit 0/);
    assert.match(out, /43/);
    assert.match(out, /module/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("run_command argv: 精确 argv 不经过 shell quoting", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-run-argv-"));
  try {
    const out = await executeToolBody("run_command", {
      argv: ["node", "-e", "console.log(JSON.stringify({semi:';', quote:'\"'}))"],
    }, context(root));
    assert.match(out, /exit 0/);
    assert.match(out, /"semi":";"/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("write_file: creating an empty file still emits create evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-empty-create-"));
  try {
    const seen: any[] = [];
    const ctx = context(root);
    ctx.onFileDiff = (info) => seen.push(info);
    const out = await executeToolBody("write_file", { path: "empty.txt", content: "" }, ctx);
    assert.match(out, /已写入/);
    assert.equal(fs.existsSync(path.join(root, "empty.txt")), true);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].kind, "create");
    assert.equal(seen[0].original, "");
    assert.equal(seen[0].applied, "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("preToolUse: run_command argv 仍进入危险命令检查", async () => {
  const out = await preToolUse("run_command", { argv: ["rm", "-rf", "/"] }, false, "");
  assert.equal(out.ok, false);
});

test("文件安全扫描: 普通 join/展开不再误报 SQL 注入", () => {
  assert.deepEqual(scanFileContent("write_file", {
    content: "const parts = locale.split('-'); return parts.join('-'); const next = [...parts];",
  }), []);
  const warning = scanFileContent("write_file", {
    content: "const sql = `SELECT * FROM users WHERE id=${userId}`;",
  });
  assert.ok(warning.some((item) => item.includes("SQL 注入")));
});

test("CLI bundle entry 使用显式构建身份，避免统一 CLI 导入子命令时自执行", () => {
  const projectRoot = process.cwd();
  const esbuild = fs.readFileSync(path.join(projectRoot, "esbuild.js"), "utf8");
  assert.match(esbuild, /__FREESEEK_CLI_ENTRY__:\s*'"cli"'/);
  assert.match(esbuild, /__FREESEEK_CLI_ENTRY__:\s*'"eval"'/);
  assert.match(esbuild, /__FREESEEK_CLI_ENTRY__:\s*'"bench"'/);
  assert.match(esbuild, /__FREESEEK_CLI_ENTRY__:\s*'"acp"'/);
  for (const [file, name] of [["src/cli.ts", "cli"], ["src/headless.ts", "headless"], ["src/eval-cli.ts", "eval"], ["src/bench-cli.ts", "bench"], ["src/acp-server.ts", "acp"]] as const) {
    const source = fs.readFileSync(path.join(projectRoot, file), "utf8");
    assert.match(source, new RegExp(`__FREESEEK_CLI_ENTRY__ === "${name}"`));
    assert.doesNotMatch(source, /require\.main\s*===\s*module/);
  }
});
