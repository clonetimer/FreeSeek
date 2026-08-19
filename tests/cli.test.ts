import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { runFreeSeekCli } from "../src/cli";
import { SessionEventLog } from "../src/eventlog";

function capture() {
  let stdout = "";
  let stderr = "";
  return {
    io: {
      stdout: (text: string) => { stdout += text; },
      stderr: (text: string) => { stderr += text; },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

test("统一 CLI help/version 不依赖 VS Code host", async () => {
  const help = capture();
  assert.equal(await runFreeSeekCli(["help"], help.io), 0);
  assert.match(help.stdout(), /freeseek run/);
  assert.match(help.stdout(), /freeseek sessions/);

  const version = capture();
  assert.equal(await runFreeSeekCli(["version"], version.io), 0);
  assert.match(version.stdout(), /^\d+\.\d+\.\d+|unknown/);
});

test("sessions/replay 从 durable EventLog 工作，不需要 VS Code", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-cli-"));
  try {
    const log = new SessionEventLog("cli-test", dir);
    log.append("user/message", { message: { role: "user", content: "inspect this workspace" }, imageCount: 0, replayable: true }, "main");
    log.append("assistant/message", { message: { role: "assistant", content: "done" } }, "main");
    log.close("test-complete");

    const sessions = capture();
    assert.equal(await runFreeSeekCli(["sessions", "--session-dir", dir, "--json"], sessions.io), 0);
    const sessionJson = JSON.parse(sessions.stdout());
    assert.equal(sessionJson.count, 1);
    assert.equal(sessionJson.sessions[0].id, "cli-test");
    assert.equal(sessionJson.sessions[0].ended, true);

    const replay = capture();
    assert.equal(await runFreeSeekCli(["replay", "cli-test", "--session-dir", dir, "--json"], replay.io), 0);
    const replayJson = JSON.parse(replay.stdout());
    assert.equal(replayJson.sessionId, "cli-test");
    assert.ok(replayJson.events.some((event: any) => event.type === "user/message"));
    assert.ok(replayJson.events.some((event: any) => event.type === "session_end"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("统一 CLI 保留 0.17.x 直接 flags 的入口判定", async () => {
  const out = capture();
  const code = await runFreeSeekCli(["unknown-command"], out.io);
  assert.equal(code, 2);
  assert.match(out.stderr(), /未知命令/);
});
