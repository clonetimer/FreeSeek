import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "node:child_process";
import { createCheckpoint, listCheckpoints, materializeCheckpoint, restoreCheckpoint } from "../src/checkpoints";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("shadow checkpoint 不改变用户工作树/index/stash，rewind 也不删除用户 stash", (t) => {
  const root = tmp("freeseek-cp-work-");
  const store = tmp("freeseek-cp-store-");
  try {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git 不可用"); return; }
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "test@example.invalid"]);
    git(root, ["config", "user.name", "FreeSeek Test"]);
    fs.writeFileSync(path.join(root, "a.txt"), "base\n");
    git(root, ["add", "a.txt"]); git(root, ["commit", "-qm", "base"]);

    // 先创建一个真正属于用户的 stash，再恢复工作树继续编辑。
    fs.writeFileSync(path.join(root, "a.txt"), "user-stash\n");
    git(root, ["stash", "push", "-m", "user-owned-stash"]);
    const stashBefore = git(root, ["stash", "list"]);

    fs.writeFileSync(path.join(root, "a.txt"), "working-change\n");
    fs.writeFileSync(path.join(root, "b.txt"), "agent-change\n");
    const statusBefore = git(root, ["status", "--porcelain"]);
    const hash = createCheckpoint(root, "freesek-cp:test", store);
    assert.ok(hash.length >= 7);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "working-change\n");
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "agent-change\n");
    assert.equal(git(root, ["status", "--porcelain"]), statusBefore);
    assert.equal(git(root, ["stash", "list"]), stashBefore);

    fs.writeFileSync(path.join(root, "a.txt"), "later\n");
    fs.writeFileSync(path.join(root, "c.txt"), "later-file\n");
    const cp = listCheckpoints(root, store)[0];
    assert.equal(cp.hash, hash);
    restoreCheckpoint(root, hash.slice(0, 10), store);
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "working-change\n");
    assert.equal(fs.readFileSync(path.join(root, "b.txt"), "utf8"), "agent-change\n");
    assert.equal(fs.existsSync(path.join(root, "c.txt")), false);
    assert.equal(git(root, ["stash", "list"]), stashBefore);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});

test("checkpoint 可绑定 durable event seq，并查询某事件之前最近快照", (t) => {
  const root = tmp("freeseek-cp-link-work-");
  const store = tmp("freeseek-cp-link-store-");
  try {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git 不可用"); return; }
    const { linkCheckpointToEvent, checkpointAtOrBefore } = require("../src/checkpoints") as typeof import("../src/checkpoints");
    fs.writeFileSync(path.join(root, "a.txt"), "one\n");
    const first = createCheckpoint(root, "freesek-cp:first", store);
    linkCheckpointToEvent(root, { hash: first, sessionId: "s1", eventSeq: 10, actor: "main", kind: "manual" }, store);
    fs.writeFileSync(path.join(root, "a.txt"), "two\n");
    const second = createCheckpoint(root, "freesek-cp:second", store);
    linkCheckpointToEvent(root, { hash: second, sessionId: "s1", eventSeq: 20, actor: "main", kind: "auto" }, store);
    const entries = listCheckpoints(root, store, 10);
    assert.equal(entries[0].eventSeq, 20);
    assert.equal(entries[1].eventSeq, 10);
    assert.equal(checkpointAtOrBefore(root, "s1", 15, store)?.hash, first);
    assert.equal(checkpointAtOrBefore(root, "s1", 25, store)?.hash, second);
    assert.equal(checkpointAtOrBefore(root, "other", 25, store), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
  }
});


test("materializeCheckpoint 将历史状态写入隔离目录且不改当前工作区", (t) => {
  const root = tmp("freeseek-cp-materialize-work-");
  const store = tmp("freeseek-cp-materialize-store-");
  const target = tmp("freeseek-cp-materialize-target-");
  try {
    try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { t.skip("git 不可用"); return; }
    fs.writeFileSync(path.join(root, "a.txt"), "historical\n");
    const hash = createCheckpoint(root, "freesek-cp:historical", store);
    fs.writeFileSync(path.join(root, "a.txt"), "current\n");
    materializeCheckpoint(root, hash, target, store);
    assert.equal(fs.readFileSync(path.join(target, "a.txt"), "utf8"), "historical\n");
    assert.equal(fs.readFileSync(path.join(root, "a.txt"), "utf8"), "current\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(store, { recursive: true, force: true });
    fs.rmSync(target, { recursive: true, force: true });
  }
});
