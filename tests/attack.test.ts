/**
 * 攻击性测试：性能 / 可靠性 / 安全性。
 * 覆盖 src/tools/fs_utils.ts（路径逃逸、grep 上限）、src/agent.ts（重复死循环绕过）、
 * src/tools.ts（read_file 巨文件 OOM）。
 * 这些用例验证"模型可触发"的真实弱点已修复，作为回归护栏。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { resolveSafe, resolveSafeInRoots, grepWalk, MAX_GREP_FILE_BYTES } from "../src/tools/fs_utils";
import { normalizeArgsKey } from "../src/agent";
import { ToolRuntime } from "../src/tool-runtime";
import { ToolRegistry } from "../src/tool-registry";
import { TOOL_DEFINITIONS } from "../src/tools/defs";

/** 临时工作区。 */
function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-attack-"));
}

// ───────────────────────── 安全：symlink 路径逃逸 ─────────────────────────
test("resolveSafe: 拒绝 .. 字符串越界", () => {
  const root = tmpRoot();
  try {
    assert.throws(() => resolveSafe(root, "../etc/passwd"), /路径越界/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Windows 非管理员创建符号链接会 EPERM，跳过软链接用例（CI/本机若无特权则不测该项）。
function canSymlink(dir: string): boolean {
  try {
    const probe = path.join(dir, "probe_link");
    fs.symlinkSync(".", probe);
    fs.rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

test("resolveSafe: 拒绝软链接指向工作区外（symlink 逃逸）", (t) => {
  const root = tmpRoot();
  try {
    if (!canSymlink(root)) { t.skip("当前环境无符号链接创建权限，跳过"); return; }
    // 工作区内建一个指向 /etc（工作区外）的软链接
    const link = path.join(root, "escape_link");
    fs.symlinkSync("/etc", link);
    assert.throws(() => resolveSafe(root, "escape_link/passwd"), /符号链接解析|路径越界/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveSafe: 软链接指向工作区内仍允许", (t) => {
  const root = tmpRoot();
  try {
    if (!canSymlink(root)) { t.skip("当前环境无符号链接创建权限，跳过"); return; }
    const inner = path.join(root, "inner");
    fs.mkdirSync(inner);
    const link = path.join(root, "to_inner");
    fs.symlinkSync(inner, link);
    const resolved = resolveSafe(root, "to_inner/file.txt");
    assert.ok(resolved.startsWith(root), "应仍位于工作区内");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveSafeInRoots: additional root 仅允许显式授权绝对路径", () => {
  const primary = tmpRoot();
  const extra = tmpRoot();
  const outside = tmpRoot();
  try {
    const allowed = path.join(extra, "allowed.txt");
    fs.writeFileSync(allowed, "ok", "utf8");
    const resolved = resolveSafeInRoots(primary, [extra], allowed);
    assert.equal(resolved.path, fs.realpathSync(allowed));
    assert.equal(resolved.root, fs.realpathSync(extra));
    assert.throws(
      () => resolveSafeInRoots(primary, [extra], path.join(outside, "blocked.txt")),
      /未授权工作区|路径越界/
    );
    assert.equal(
      resolveSafeInRoots(primary, [extra], "relative.txt").root,
      fs.realpathSync(primary),
      "相对路径必须继续锚定主工作区"
    );
  } finally {
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(extra, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

// ───────────────────────── 性能：grep 单文件上限 ─────────────────────────
test("grepWalk: 超过单文件上限时跳过而非整读", () => {
  const root = tmpRoot();
  try {
    const big = path.join(root, "huge.log");
    // 写一个略大于上限的二进制式文件
    const buf = Buffer.alloc(MAX_GREP_FILE_BYTES + 1024, 0x41);
    fs.writeFileSync(big, buf);
    const out: string[] = [];
    grepWalk(root, /never-matches-xyz/, null, out, 0, 1000);
    assert.ok(out.length >= 1, "应记录一条跳过提示");
    assert.match(out[0], /跳过/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("grepWalk: 正常小文件命中匹配", () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, "a.txt"), "hello world\nfoo bar\n");
    const out: string[] = [];
    grepWalk(root, /hello/, null, out, 0, 1000);
    assert.equal(out.length, 1);
    assert.match(out[0], /a\.txt:1: hello world/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ───────────────────────── 可靠性：重复死循环绕过 ─────────────────────────
test("normalizeArgsKey: 微调参数（空白/注释/key 顺序）归并为同一键", () => {
  const a = { path: "./src/app.ts", // 注释
    content: "  const x = 1;  " };
  const b = { content: "const x = 1;", path: "./src/app.ts" }; // key 顺序不同、无注释
  assert.equal(normalizeArgsKey(a), normalizeArgsKey(b), "语义等价应归并");
});

test("normalizeArgsKey: 真正不同的参数产生不同键", () => {
  const a = { path: "a.ts", content: "x=1" };
  const b = { path: "a.ts", content: "x=2" };
  assert.notEqual(normalizeArgsKey(a), normalizeArgsKey(b));
});

// ───────────────────────── 性能：read_file 巨文件 OOM 防护 ─────────────────────────
test("read_file: 拒绝整读超大文件（防 OOM）", async () => {
  const root = tmpRoot();
  try {
    const big = path.join(root, "huge.bin");
    fs.writeFileSync(big, Buffer.alloc(16 * 1024 * 1024 + 1, 0x42));
    const ctx: any = { workspaceRoot: root, onFileRead: () => {} };
    const res = (await new ToolRuntime(ctx, ToolRegistry.fromDefinitions(TOOL_DEFINITIONS.filter((d) => d.function.name === "read_file"))).execute("read_file", { path: "huge.bin" })).result;
    assert.match(res, /过大|上限/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("read_file: 普通文件正常返回前 N 行", async () => {
  const root = tmpRoot();
  try {
    fs.writeFileSync(path.join(root, "small.txt"), "line1\nline2\nline3\n");
    const ctx: any = { workspaceRoot: root, onFileRead: () => {} };
    const res = (await new ToolRuntime(ctx, ToolRegistry.fromDefinitions(TOOL_DEFINITIONS.filter((d) => d.function.name === "read_file"))).execute("read_file", { path: "small.txt" })).result;
    assert.match(res, /line1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("resolveSafe: 新文件也拒绝父目录 symlink 逃逸", (t) => {
  const root = tmpRoot();
  const outside = tmpRoot();
  try {
    if (!canSymlink(root)) { t.skip("当前环境无符号链接创建权限，跳过"); return; }
    const link = path.join(root, "escape_dir");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    assert.equal(fs.existsSync(path.join(outside, "new.txt")), false);
    assert.throws(() => resolveSafe(root, "escape_dir/new.txt"), /路径越界|符号链接/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
