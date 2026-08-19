import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionStorage } from "../src/storage";
import type { ChatMessage } from "../src/provider";

test("SessionStorage 并发排队保存不会用旧 index 覆盖其他会话", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-storage-"));
  try {
    const context = { globalStorageUri: { fsPath: root } } as any;
    const storage = new SessionStorage(context);
    const count = 100;
    for (let i = 0; i < count; i++) {
      const id = `session-${i}`;
      const messages: ChatMessage[] = [
        { role: "user", content: `task ${i}` },
        { role: "assistant", content: `done ${i}` },
      ];
      storage.saveSessionTo(id, messages, id);
    }
    await storage.flush();

    const index = storage.loadIndex();
    assert.equal(index.sessions.length, count);
    assert.equal(new Set(index.sessions.map((x) => x.id)).size, count);
    for (let i = 0; i < count; i++) {
      assert.ok(index.sessions.some((x) => x.id === `session-${i}`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("SessionStorage 在 session JSON 丢失时仅从 complete EventLog 恢复", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-storage-recover-"));
  try {
    const context = { globalStorageUri: { fsPath: root } } as any;
    const storage = new SessionStorage(context);
    const history = storage.historyDir();
    const { SessionEventLog } = require("../src/eventlog") as typeof import("../src/eventlog");
    const log = new SessionEventLog("recover", history);
    const image = "data:image/png;base64," + Buffer.from("recover-image").toString("base64");
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u", images: [image] },
      { role: "assistant", content: "a" },
    ];
    log.append("conversation/snapshot", { ...log.persistConversation(messages), reason: "test" }, "main");
    assert.equal(fs.existsSync(storage.sessionPath("recover")), false);
    const recovered = storage.loadSessionInto("recover", new Map());
    assert.ok(recovered);
    assert.deepEqual(recovered?.map((m) => m.content), ["sys", "u", "a"]);
    assert.equal(recovered?.[1].images?.[0], image);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
