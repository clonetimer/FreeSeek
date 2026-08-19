/**
 * Markdown 渲染层：marked（严格 GFM：空行分段，段内单换行折叠为空格）→ DOMPurify 消毒防 XSS。
 * 对齐 CodeBuddy / Claude Code 排版：关闭 breaks（换行即 <br>），避免 agent 输出渲染成碎行。
 * 另含代码块美化（语言标签 + 复制按钮）与剪贴板工具函数。
 */
import { marked } from "marked";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";

marked.setOptions({ breaks: false, gfm: true });

// 消毒后给链接补 target/rel，webview 内点击由 main.ts 委托转发给主进程打开外部浏览器
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** 渲染 markdown 为已消毒的 HTML 字符串。 */
export function renderMarkdown(src: string): string {
  const html = marked.parse(src || "", { async: false }) as string;
  return DOMPurify.sanitize(html);
}

/**
 * 代码块增强：为每个 <pre><code> 添加「语言标签 + 复制按钮」头栏（只处理一次）。
 * 特例：language-csv / language-tsv 代码块渲染为可预览的 HTML 表格（对齐 CodeBuddy 产物预览）。
 * @param root 查找范围（通常是一条消息气泡）
 */
export function enhanceCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll("pre > code").forEach((codeEl) => {
    const pre = codeEl.parentElement;
    if (!pre || pre.dataset.enhanced) return;
    pre.dataset.enhanced = "1";
    const lang = /language-([\w+-]+)/.exec(codeEl.className)?.[1] || "text";

    // CSV/TSV 产物预览：解析并渲染为表格（保留原始数据供复制）
    if (lang === "csv" || lang === "tsv") {
      const table = renderDelimitedTable(codeEl.textContent || "", lang === "tsv");
      if (table) {
        const holder = document.createElement("div");
        holder.className = "table-preview";
        const bar = document.createElement("div");
        bar.className = "code-bar";
        const label = document.createElement("span");
        label.className = "code-lang";
        label.textContent = lang.toUpperCase();
        const btn = document.createElement("button");
        btn.className = "code-copy";
        btn.textContent = "复制";
        btn.title = "复制原始数据";
        btn.addEventListener("click", () => copyText(codeEl.textContent || "", btn));
        bar.appendChild(label);
        bar.appendChild(btn);
        holder.appendChild(bar);
        holder.appendChild(table);
        pre.parentElement?.replaceChild(holder, pre);
        return;
      }
    }

    // Mermaid 图表渲染：命中 ```mermaid 代码块，懒加载 dist/mermaid.js 并渲染为 SVG
    if (lang === "mermaid") {
      const holder = document.createElement("div");
      holder.className = "mermaid-preview";
      const bar = document.createElement("div");
      bar.className = "code-bar";
      const label = document.createElement("span");
      label.className = "code-lang";
      label.textContent = "MERMAID";
      const btn = document.createElement("button");
      btn.className = "code-copy";
      btn.textContent = "复制";
      btn.title = "复制 Mermaid 源码";
      btn.addEventListener("click", () => copyText(codeEl.textContent || "", btn));
      bar.appendChild(label);
      bar.appendChild(btn);
      holder.appendChild(bar);
      const box = document.createElement("div");
      box.className = "mermaid-box";
      box.textContent = "正在渲染图表…";
      holder.appendChild(box);
      pre.parentElement?.replaceChild(holder, pre);
      void renderMermaidBlock(codeEl.textContent || "", box, btn);
      return;
    }

    pre.classList.add("code-block");
    // 语法高亮：hljs 读取 textContent 并按 language-xxx 或自动检测着色；
    // 高亮会改写 code 内部为带 .hljs-* 类的 span，CSS 主题见 extension.ts。
    try {
      hljs.highlightElement(codeEl as HTMLElement);
    } catch {
      /* 个别未知语言回退为纯文本，不影响渲染 */
    }
    const bar = document.createElement("div");
    bar.className = "code-bar";
    const label = document.createElement("span");
    label.className = "code-lang";
    label.textContent = lang;
    const btn = document.createElement("button");
    btn.className = "code-copy";
    btn.textContent = "复制";
    btn.title = "复制代码";
    btn.addEventListener("click", () => copyText(codeEl.textContent || "", btn));
    bar.appendChild(label);
    bar.appendChild(btn);
    pre.prepend(bar);
  });
}

/**
 * 渲染 Mermaid 代码块：动态加载 dist/mermaid.js（懒加载，不进主 bundle）后调用其 render。
 * script 的 URI 由扩展侧通过 window.__freesekMermaidUri 注入。
 */
async function renderMermaidBlock(code: string, box: HTMLElement, _copyBtn: HTMLButtonElement): Promise<void> {
  try {
    // 1) 确保 mermaid-loader 已加载
    if (!(window as any).__freesekMermaid) {
      const uri = (window as any).__freesekMermaidUri as string | undefined;
      if (!uri) {
        box.textContent = "⚠ 无法加载 Mermaid 渲染器（未注入 script URI）。";
        return;
      }
      await loadScript(uri);
    }
    const api = (window as any).__freesekMermaid;
    if (!api) {
      box.textContent = "⚠ Mermaid 渲染器加载失败。";
      return;
    }
    // 2) 渲染
    box.textContent = "正在渲染图表…";
    const res = await api.render(code);
    if (res?.ok) {
      box.innerHTML = res.html;
    } else {
      box.textContent = "⚠ Mermaid 渲染失败：" + (res?.error ?? "未知错误");
    }
  } catch (e: any) {
    box.textContent = "⚠ Mermaid 渲染异常：" + (e?.message ?? String(e));
  }
}

/** 动态加载一个 <script src> 并等待其执行完成。 */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("脚本加载失败: " + src));
    document.head.appendChild(s);
  });
}

/** 解析 CSV/TSV 文本并渲染为 HTML 表格；解析失败返回 null（回退为普通代码块）。 */
function renderDelimitedTable(text: string, tsv: boolean): HTMLElement | null {
  const rows = text
    .trim()
    .split(/\r?\n/)
    .map((line) => parseDelimitedRow(line, tsv));
  if (!rows.length || rows.some((r) => r.length === 0)) return null;
  const ncol = Math.max(...rows.map((r) => r.length));
  if (ncol < 2) return null; // 单列无预览价值
  const table = document.createElement("table");
  table.className = "data-table";
  rows.forEach((row, idx) => {
    const tr = document.createElement("tr");
    const tag = idx === 0 ? "th" : "td";
    for (let i = 0; i < ncol; i++) {
      const cell = document.createElement(tag);
      cell.textContent = row[i] ?? "";
      tr.appendChild(cell);
    }
    table.appendChild(tr);
  });
  return table;
}

/** 解析单行分隔符数据（支持引号包裹的字段，逗号/制表符）。 */
function parseDelimitedRow(line: string, tsv: boolean): string[] {
  const sep = tsv ? "\t" : ",";
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQ = !inQ;
      }
    } else if (ch === sep && !inQ) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

/** 复制文本到剪贴板；btn 存在时给出「✓ 已复制」的按钮内反馈。 */
export function copyText(text: string, btn?: HTMLElement): void {
  const done = () => {
    if (btn) {
      const old = btn.textContent;
      btn.textContent = "✓ 已复制";
      setTimeout(() => (btn.textContent = old), 1200);
    }
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}

/** 无 Clipboard API 时的兜底复制（execCommand）。 */
export function fallbackCopy(text: string, done: () => void): void {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
    done();
  } catch {
    /* 复制失败，静默 */
  }
}

/** 移除 <tool_call> / <tool_result> 标签与 ReAct markdown 代码围栏（历史回看与隐藏原始调用文本）。 */
export function stripTags(s: string): string {
  return s
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<\/?tool_call>/g, "")
    .replace(/<\/?tool_result[^>]*>/g, "")
    .replace(/```(?:json)?\s*\n?([\s\S]*?)```/g, (match, inner: string) => {
      const t = inner.trim();
      if (t.includes('"name"') && t.includes('"arguments"')) return "";
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj.name === "string") return "";
      } catch {
        /* 普通代码块保留 */
      }
      return match;
    })
    .trim();
}

export function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string)
  );
}
