import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseMemoryEntries,
  dedupeMemories,
  pruneMemories,
  serializeMemoryEntries,
  governMemoryFile,
  backupMemoryFile,
} from "../src/memory";

test("parseMemoryEntries: 按 ## 分节并保留时间戳", () => {
  const entries = parseMemoryEntries("## 2026/8/16 12:00:00\n记住 A\n\n## 2026/8/16 13:00:00\n记住 B");
  assert.equal(entries.length, 2);
  assert.equal(entries[0].text, "记住 A");
  assert.equal(entries[1].text, "记住 B");
  assert.equal(entries[1].time, "2026/8/16 13:00:00");
});

test("dedupeMemories: 相似条目去重保留最新", () => {
  const entries = [
    { time: "t1", text: "用户偏好使用 TypeScript" },
    { time: "t2", text: "用户偏好使用 TypeScript 项目" },
    { time: "t3", text: "项目需要支持 Windows" },
  ];
  const kept = dedupeMemories(entries, 0.7);
  assert.equal(kept.length, 2);
  assert.ok(kept.some((e) => e.time === "t2"));
  assert.ok(kept.some((e) => e.time === "t3"));
});

test("pruneMemories: 淘汰最旧保留最新 N 条", () => {
  const entries = [1, 2, 3, 4, 5].map((i) => ({ time: String(i), text: `m${i}` }));
  assert.deepEqual(
    pruneMemories(entries, 3).map((e) => e.text),
    ["m3", "m4", "m5"]
  );
});

test("serializeMemoryEntries: round-trip", () => {
  const entries = [
    { time: "t1", text: "a" },
    { time: null, text: "b" },
  ];
  const s = serializeMemoryEntries(entries);
  assert.ok(s.includes("## t1\na"));
  const back = parseMemoryEntries(s);
  assert.equal(back.length, 2);
});

test("governMemoryFile: 去重 + 淘汰写回", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsmem-"));
  const fp = path.join(root, "mem.md");
  fs.writeFileSync(fp, "## t1\n喜欢 a\n\n## t2\n喜欢 a 很喜欢\n\n## t3\n喜欢 b", "utf8");
  const r = governMemoryFile(fp, { dedupeThreshold: 0.6, maxCount: 2 });
  assert.equal(r.before, 3);
  assert.ok(r.after <= 2);
  assert.ok(r.removed >= 1);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
});

test("backupMemoryFile: 复制到备份目录", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "fsmem-"));
  const fp = path.join(root, "x.md");
  fs.writeFileSync(fp, "data", "utf8");
  const bak = backupMemoryFile(fp, path.join(root, "bak"));
  assert.ok(fs.existsSync(bak));
  fs.rmSync(root, { recursive: true, force: true });
});