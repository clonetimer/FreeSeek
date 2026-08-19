/**
 * Webview 宿主桥（HostBridge）。
 *
 * 把 VS Code 提供的 `acquireVsCodeApi()` 隔离成统一接口，使同一份 webview
 * 前端既能跑在真实 VS Code 侧边栏里，也能在普通浏览器里独立运行（UI Harness），
 * 便于开发期用 Chrome DevTools MCP 直接查看与交互，免去每次都进 VS Code。
 *
 * - VS Code 环境：`createBridge()` 检测到 `acquireVsCodeApi` 存在，使用真实 API。
 * - 浏览器环境：使用 mock 实现——postMessage 仅打印到 console，并可按 `?scenario=`
 *   从外部注入的初始消息里 replay（见 webview-dev/index.html），从而让界面有内容可调试。
 */
export interface HostBridge {
  /** 向扩展主进程（或 mock 回环）发送消息。 */
  postMessage(message: unknown): void;
  /** 读取跨刷新持久化的状态（VS Code getState）。 */
  getState(): unknown;
  /** 写入跨刷新持久化的状态。 */
  setState(state: unknown): void;
}

/**
 * 创建宿主桥。优先使用真实 VS Code API；浏览器开发环境回退到 mock。
 * 浏览器环境下，dev harness（`webview-dev/index.html`）会在加载 webview.js 之前
 * 把要 replay 的初始入站消息写入 `globalThis.__FRESEEK_HARNESS_INBOUND__`。
 */
export function createBridge(): HostBridge {
  const real = (globalThis as any).acquireVsCodeApi;
  if (typeof real === "function") {
    const vscode = real();
    return {
      postMessage: (m: unknown) => vscode.postMessage(m),
      getState: () => vscode.getState?.() ?? {},
      setState: (s: unknown) => vscode.setState?.(s),
    };
  }
  const inbound = (globalThis as any).__FRESEEK_HARNESS_INBOUND__ || [];
  return createMockBridge(inbound);
}

/**
 * 浏览器 mock 桥：把出站消息打印到 console，并把 initialInbound 逐条派发为
 * `window` message 事件，模拟扩展主进程推送给 webview 的入站消息。
 */
function createMockBridge(initialInbound: unknown[]): HostBridge {
  // 浏览器无 acquireVsCodeApi：标记 DEV 模式供 UI 提示（node 测试环境无 document 时跳过）
  if (typeof document !== "undefined" && document.body) {
    (document.body as any).dataset.devHarness = "true";
  }
  // 延后派发，确保 main.ts 的 message 监听器已注册；node 测试环境无 window 时跳过
  if (initialInbound.length > 0 && typeof window !== "undefined") {
    setTimeout(() => {
      for (const m of initialInbound) {
        window.dispatchEvent(new MessageEvent("message", { data: m }));
      }
      // eslint-disable-next-line no-console
      console.info(
        `[MockBridge] replayed ${initialInbound.length} inbound message(s) from scenario`
      );
    }, 0);
  }
  return {
    postMessage: (m: unknown) => {
      // eslint-disable-next-line no-console
      console.info("[MockBridge→extension]", m);
      // 把出站消息原样回环成入站，方便做基础交互验证（如 echo）
      if (
        m &&
        typeof m === "object" &&
        (m as any).type === "send" &&
        (m as any).text
      ) {
        const text = String((m as any).text);
        setTimeout(() => {
          window.dispatchEvent(
            new MessageEvent("message", {
              data: { type: "assistant_delta", text, sessionId: uiSessionId() },
            })
          );
        }, 50);
      }
    },
    getState: () => ({}),
    setState: () => {},
  };
}

/** 从 URL 读取当前 sessionId（dev harness 注入），供回环消息对齐。 */
function uiSessionId(): string {
  if (typeof location === "undefined") return "";
  const p = new URLSearchParams(location.search);
  return p.get("sessionId") || "";
}
