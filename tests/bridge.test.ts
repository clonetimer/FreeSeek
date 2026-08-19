/**
 * bridge（HostBridge）单测：mock 桥在无 acquireVsCodeApi 环境下的回环与状态行为。
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createBridge } from "../src/webview/bridge";

describe("bridge (mock)", () => {
  let logs: unknown[];
  let origConsole: typeof console.info;

  beforeEach(() => {
    logs = [];
    origConsole = console.info;
    console.info = (...a: unknown[]) => logs.push(a);
  });
  afterEach(() => {
    console.info = origConsole;
    delete (globalThis as any).window;
    delete (globalThis as any).location;
  });

  it("无 acquireVsCodeApi 时回退到 mock 桥", () => {
    const b = createBridge();
    assert.equal(typeof b.postMessage, "function");
    assert.equal(typeof b.getState, "function");
    assert.equal(typeof b.setState, "function");
  });

  it("postMessage 打印日志且不抛（node 无 window 时跳过派发）", () => {
    const b = createBridge();
    b.postMessage({ type: "newChat" });
    assert.ok(
      logs.some((l) => Array.isArray(l) && String(l[0]).includes("[MockBridge→extension]"))
    );
  });

  it("getState/setState 在 mock 下为空操作不抛", () => {
    const b = createBridge();
    b.setState({ foo: 1 });
    assert.deepEqual(b.getState(), {});
  });

  it("send 类型消息在浏览器环境会回环为 assistant_delta", () => {
    const received: unknown[] = [];
    (globalThis as any).window = {
      dispatchEvent: (e: any) => received.push(e.data),
    };
    (globalThis as any).location = { search: "?sessionId=abc" } as any;
    const b = createBridge();
    b.postMessage({ type: "send", text: "你好" });
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        assert.ok(
          received.some(
            (m: any) =>
              m.type === "assistant_delta" && m.text === "你好" && m.sessionId === "abc"
          )
        );
        resolve();
      }, 80);
    });
  });
});
