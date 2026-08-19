/**
 * Mermaid 懒加载渲染器（独立 bundle：dist/mermaid.js）。
 *
 * 不进主 webview bundle，仅在页面遇到 ```mermaid 代码块时通过 <script src> 按需加载，
 * 以避免把 ~1MB 的 mermaid 库打进主 bundle、拖慢首屏。
 *
 * 暴露全局 window.__freesekMermaid = { render }。
 */
import mermaid from "mermaid";

// 初始化一次（主题跟随 VS Code 深/浅色，简单起见用 neutral）
mermaid.initialize({
  startOnLoad: false,
  theme: "neutral",
  securityLevel: "strict",
  fontFamily: "var(--vscode-font-family)",
});

export interface RenderResult {
  ok: boolean;
  html: string;
  error?: string;
}

/** 渲染 Mermaid 定义，返回 SVG HTML；失败返回错误信息。 */
async function renderMermaid(code: string): Promise<RenderResult> {
  const id = "mermaid-" + Math.random().toString(36).slice(2, 10);
  try {
    const { svg } = await mermaid.render(id, code);
    return { ok: true, html: svg };
  } catch (e: any) {
    return { ok: false, html: "", error: e?.message ?? String(e) };
  }
}

// 暴露到 window 供主 bundle 动态加载后调用
declare global {
  interface Window {
    __freesekMermaid?: { render: typeof renderMermaid };
  }
}
window.__freesekMermaid = { render: renderMermaid };
