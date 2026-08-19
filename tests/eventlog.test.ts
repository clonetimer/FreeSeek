/**
 * eventlog：append/replay、重启续 seq、多 session 隔离、actor 投影。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";
import {
  SessionEventLog,
  readSessionEvents,
  ensureEventLog,
  endSessionEventLog,
  deleteSessionEventLog,
  projectSessionTitle,
  deriveConversationFromEvents,
  messageForEventLog,
  conversationForEventLog,
} from "../src/eventlog";

describe("eventlog", () => {
  it("append 追加事件并可回放", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const log = new SessionEventLog("s1", dir);
      log.append("user", { text: "你好" });
      log.append("assistant", { text: "嗨" });
      const events = readSessionEvents(dir, "s1");
      assert.equal(events.length, 2);
      assert.equal(events[0].seq, 1);
      assert.equal(events[0].type, "user");
      assert.equal(events[0].sessionId, "s1");
      assert.equal(events[0].actor, "main");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重开同一日志时从磁盘最大 seq 继续，不产生重复序号", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const a = new SessionEventLog("resume", dir);
      a.append("user", { n: 1 });
      const b = new SessionEventLog("resume", dir);
      b.append("assistant", { n: 2 });
      const events = readSessionEvents(dir, "resume");
      assert.deepEqual(events.map((e) => e.seq), [1, 2]);
      assert.equal(b.lastSeq, 2);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("readSessionEvents 对不存在会话返回空数组", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      assert.deepEqual(readSessionEvents(dir, "ghost"), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("切换 active session 不会隐式结束旧日志；后台旧实例仍写回原 session", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const idA = `sA-${Date.now()}-${Math.random()}`;
      const idB = `sB-${Date.now()}-${Math.random()}`;
      const a = ensureEventLog(dir, idA);
      a.append("user", { t: 1 }, "main");
      ensureEventLog(dir, idB);
      a.append("assistant", { t: 2 }, "main");
      const eventsA = readSessionEvents(dir, idA);
      assert.equal(eventsA.some((e) => e.type === "session_end"), false);
      assert.equal(eventsA[eventsA.length - 1].type, "assistant");
      assert.equal(readSessionEvents(dir, idB).some((e) => e.type === "assistant"), false);
      endSessionEventLog(idA, "test");
      assert.equal(readSessionEvents(dir, idA).at(-1)?.type, "session_end");
      endSessionEventLog(idB, "test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("删除 session event log 会关闭已捕获 sink，并清理 JSONL/sidecar", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const id = `delete-${Date.now()}-${Math.random()}`;
      const log = ensureEventLog(dir, id);
      const huge = "x".repeat(260_000);
      log.append(
        "conversation/snapshot",
        { messages: [{ role: "user", content: huge }], complete: true, reason: "delete-test" },
        "main"
      );
      const blobDir = path.join(dir, "event-blobs", id);
      assert.equal(fs.existsSync(log.path), true);
      assert.equal(fs.existsSync(blobDir), true);

      deleteSessionEventLog(dir, id);
      assert.equal(fs.existsSync(log.path), false);
      assert.equal(fs.existsSync(blobDir), false);
      assert.equal(log.append("assistant", { afterDelete: true }), null);
      assert.equal(fs.existsSync(log.path), false, "关闭后的旧 sink 不得把已删除日志重新创建");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("projectSessionTitle 每个会话只投影一次", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const id = `title-${Date.now()}-${Math.random()}`;
      ensureEventLog(dir, id);
      projectSessionTitle("  修复登录页空白问题  ", id);
      projectSessionTitle("第二条消息不应覆盖标题", id);
      const events = readSessionEvents(dir, id);
      const titles = events.filter((e) => e.type === "session_title");
      assert.equal(titles.length, 1);
      assert.equal((titles[0].data as { title: string }).title, "修复登录页空白问题");
      endSessionEventLog(id, "test");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("canonical message 投影默认只恢复 main actor，不混入子 Agent 内部消息", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const log = new SessionEventLog("projection", dir);
      const user = messageForEventLog({ role: "user", content: "主任务" });
      log.append("user/message", { ...user }, "main");
      log.append(
        "assistant/message",
        { message: { role: "assistant", content: "子代理内部" }, step: 1 },
        "main/sub:explore"
      );
      log.append(
        "assistant/message",
        { message: { role: "assistant", content: "主代理结论" }, step: 1 },
        "main"
      );
      const projected = deriveConversationFromEvents(readSessionEvents(dir, "projection"));
      assert.deepEqual(projected.messages.map((m) => m.content), ["主任务", "主代理结论"]);
      assert.equal(projected.complete, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("带图片的 user message 明确标记为当前 event-only projection 不完整", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const log = new SessionEventLog("images", dir);
      const logged = messageForEventLog({ role: "user", content: "看图", images: ["data:image/png;base64,abc"] });
      assert.equal(logged.imageCount, 1);
      assert.equal(logged.replayable, false);
      assert.equal(logged.message.images, undefined);
      log.append("user/message", logged, "main");
      const projected = deriveConversationFromEvents(readSessionEvents(dir, "images"));
      assert.equal(projected.complete, false);
      assert.equal(projected.messages[0].content, "看图");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });


  it("conversation/snapshot 作为投影重置点，后续 canonical message 继续追加", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const log = new SessionEventLog("snapshot", dir);
      const snap = conversationForEventLog([
        { role: "system", content: "sys" },
        { role: "user", content: "u1" },
      ]);
      log.append("conversation/snapshot", { ...snap, reason: "run_start" }, "main");
      log.append("assistant/message", { message: { role: "assistant", content: "a1" }, step: 1 }, "main");
      const projected = deriveConversationFromEvents(readSessionEvents(dir, "snapshot"));
      assert.deepEqual(projected.messages.map((m) => m.content), ["sys", "u1", "a1"]);
      assert.equal(projected.complete, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("超大事件写入 sidecar，JSONL 保持小而 readSessionEvents 自动还原 data", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-"));
    try {
      const log = new SessionEventLog("large", dir);
      const huge = "x".repeat(260_000);
      log.append(
        "conversation/snapshot",
        { messages: [{ role: "user", content: huge }], complete: true, reason: "large-test" },
        "main"
      );
      const raw = fs.readFileSync(log.path, "utf8");
      assert.ok(raw.length < 20_000, "JSONL 行应只保留 sidecar 引用");
      assert.match(raw, /dataRef/);
      const events = readSessionEvents(dir, "large");
      const data = events[0].data as any;
      assert.equal(data.messages[0].content.length, huge.length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

it("content-addressed 图片可完整回放，JSONL 不含 base64 正文且相同内容只存一份", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-blob-"));
  try {
    const log = new SessionEventLog("blob", dir);
    const image = "data:image/png;base64," + Buffer.from("same-image-bytes").toString("base64");
    const first = log.persistMessage({ role: "user", content: "看图1", images: [image] });
    const second = log.persistMessage({ role: "user", content: "看图2", images: [image] });
    assert.equal(first.replayable, true);
    assert.equal(second.replayable, true);
    assert.equal(first.imageRefs?.[0].digest, second.imageRefs?.[0].digest);
    log.append("user/message", first, "main");
    log.append("user/message", second, "main");

    const raw = fs.readFileSync(log.path, "utf8");
    assert.equal(raw.includes(Buffer.from("same-image-bytes").toString("base64")), false);
    const blobRoot = path.join(dir, "content-blobs", "sha256");
    const blobs = fs.readdirSync(blobRoot).flatMap((prefix) =>
      fs.readdirSync(path.join(blobRoot, prefix)).filter((name) => name.endsWith(".blob"))
    );
    assert.equal(blobs.length, 1);

    const projected = deriveConversationFromEvents(readSessionEvents(dir, "blob"));
    assert.equal(projected.complete, true);
    assert.deepEqual(projected.messages.map((m) => m.images?.[0]), [image, image]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("content blob 丢失时 projection fail-closed 为 incomplete", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-blob-missing-"));
  try {
    const log = new SessionEventLog("missing", dir);
    const image = "data:image/png;base64," + Buffer.from("to-delete").toString("base64");
    const logged = log.persistMessage({ role: "user", content: "看图", images: [image] });
    log.append("user/message", logged, "main");
    const digest = logged.imageRefs?.[0].digest;
    assert.ok(digest);
    fs.rmSync(path.join(dir, "content-blobs", "sha256", digest!.slice(0, 2), `${digest}.blob`));
    const projected = deriveConversationFromEvents(readSessionEvents(dir, "missing"));
    assert.equal(projected.complete, false);
    assert.equal(projected.messages[0].images, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("forkSessionEventLog 在指定 seq 生成独立可继续会话，不带入边界后的消息", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-fork-"));
  try {
    const source = new SessionEventLog("source", dir);
    source.append("conversation/snapshot", { ...source.persistConversation([{ role: "system", content: "sys" }]), reason: "start" }, "main");
    source.append("user/message", source.persistMessage({ role: "user", content: "u1" }), "main");
    const cp = source.append("checkpoint", {
      hash: "a".repeat(40), label: "freesek-post:write_file:test", workspaceRoot: "/tmp/source", kind: "auto",
    }, "main")!;
    const boundary = source.append("assistant/message", { message: { role: "assistant", content: "a1" }, step: 1 }, "main")!.seq;
    source.append("user/message", source.persistMessage({ role: "user", content: "u2-after" }), "main");

    const { forkSessionEventLog, deriveConversationAtSeq } = require("../src/eventlog") as typeof import("../src/eventlog");
    const atBoundary = deriveConversationAtSeq(dir, "source", boundary);
    assert.deepEqual(atBoundary.messages.map((m) => m.content), ["sys", "u1", "a1"]);
    const forked = forkSessionEventLog(dir, "source", "forked", boundary);
    assert.deepEqual(forked.messages.map((m) => m.content), ["sys", "u1", "a1"]);
    assert.equal(forked.checkpoint?.hash, "a".repeat(40));
    assert.equal(forked.checkpoint?.eventSeq, cp.seq);
    const projected = deriveConversationFromEvents(readSessionEvents(dir, "forked"));
    assert.deepEqual(projected.messages.map((m) => m.content), ["sys", "u1", "a1"]);
    assert.equal(readSessionEvents(dir, "forked").some((e) => e.type === "session/fork"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("删除 session 会 GC 仅该会话引用的 content blob，同时保留其它会话共享内容", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-gc-"));
  try {
    const shared = "data:image/png;base64," + Buffer.from("shared").toString("base64");
    const unique = "data:image/png;base64," + Buffer.from("unique-a").toString("base64");
    const a = new SessionEventLog("gc-a", dir);
    const b = new SessionEventLog("gc-b", dir);
    const a1 = a.persistMessage({ role: "user", content: "a", images: [shared, unique] });
    const b1 = b.persistMessage({ role: "user", content: "b", images: [shared] });
    a.append("user/message", a1, "main");
    b.append("user/message", b1, "main");
    const sharedDigest = a1.imageRefs![0].digest;
    const uniqueDigest = a1.imageRefs![1].digest;
    const blob = (digest: string) => path.join(dir, "content-blobs", "sha256", digest.slice(0, 2), `${digest}.blob`);
    assert.equal(fs.existsSync(blob(sharedDigest)), true);
    assert.equal(fs.existsSync(blob(uniqueDigest)), true);
    deleteSessionEventLog(dir, "gc-a");
    assert.equal(fs.existsSync(blob(sharedDigest)), true, "其它 session 仍引用的共享 blob 必须保留");
    assert.equal(fs.existsSync(blob(uniqueDigest)), false, "仅被删除 session 引用的 blob 应回收");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("session id 路径穿越被 durable storage fail-closed 拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-ev-session-id-"));
  try {
    const { assertSafeSessionId } = require("../src/eventlog") as typeof import("../src/eventlog");
    assert.throws(() => assertSafeSessionId("../../escape"), /非法 session id/);
    assert.throws(() => new SessionEventLog("../escape", dir), /非法 session id/);
    assert.throws(() => readSessionEvents(dir, "a/b"), /非法 session id/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
