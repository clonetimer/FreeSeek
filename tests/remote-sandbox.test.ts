import { test } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { commandExecPlan, resolveExecPolicy } from "../src/sandbox";
import { createHttpRemoteSandboxTransport, createRemoteCommandRunner, createStaticRemoteWorkspaceMapper } from "../src/remote-sandbox";

test("Remote Sandbox provider 显式映射 workspace/cwd，不泄漏本地路径语义", async () => {
  let received: any;
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += String(chunk);
    received = JSON.parse(body);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ exitCode: 0, stdout: "remote-ok", sandbox: "fixture" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const localRoot = path.join(os.tmpdir(), "remote-local-root");
  const mapper = createStaticRemoteWorkspaceMapper(localRoot, "ws-123", "/workspace");
  const runner = createRemoteCommandRunner({
    transport: createHttpRemoteSandboxTransport({ endpoint: `http://127.0.0.1:${address.port}/execute`, token: "secret" }),
    mapCwd: mapper,
  });
  try {
    const out = await runner.run({
      cwd: path.join(localRoot, "sub"), command: "node test.js", argv: ["node", "test.js"], timeoutMs: 5000,
      exec: commandExecPlan(resolveExecPolicy({ sandboxMode: "off", allowShell: true })), network: { mode: "off" },
    });
    assert.match(out, /Remote Sandbox: fixture/);
    assert.match(out, /remote-ok/);
    assert.equal(received.workspaceId, "ws-123");
    assert.equal(received.cwd, "/workspace/sub");
    assert.equal(String(received.cwd).includes(localRoot), false);
    assert.deepEqual(received.argv, ["node", "test.js"]);
    assert.throws(() => mapper(path.resolve(localRoot, "..", "escape")), /cwd 越界/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Remote Sandbox token 对非本机明文 HTTP fail-closed", () => {
  assert.throws(
    () => createHttpRemoteSandboxTransport({ endpoint: "http://sandbox.example/v1/execute", token: "secret" }),
    /必须使用 HTTPS/
  );
});

test("Remote workspace mapper 对存在的 symlink cwd 做 realpath containment", (t) => {
  const fs = require("node:fs") as typeof import("node:fs");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remote-map-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "remote-map-outside-"));
  try {
    const link = path.join(root, "escape");
    try {
      fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (err: any) {
      if (["EPERM", "EACCES", "ENOTSUP"].includes(String(err?.code ?? ""))) {
        t.skip("当前环境不允许创建目录 symlink；有 symlink 权限的平台仍执行 realpath containment 验证");
        return;
      }
      throw err;
    }
    const mapper = createStaticRemoteWorkspaceMapper(root, "ws");
    assert.throws(() => mapper(link), /cwd 越界/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});
