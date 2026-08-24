/**
 * Webview 前端共享状态与消息发送句柄。
 * 组件模块（components.ts）与入口（main.ts）共用，避免把 DOM 状态传来传去。
 */
export const ui: {
  /** 向扩展主进程发送消息（由 main.ts 在启动时注入 vscode.postMessage）。 */
  post: (msg: unknown) => void;
  /** 任务清单卡片引用（renderTodos 增量替换用）。 */
  todoCard: HTMLElement | null;
  /** 当前子智能体日志块引用（appendSubLine 增量追加用）。 */
  currentSubLog: HTMLElement | null;
  /** 最近一次会话列表（侧栏搜索过滤用）。 */
  lastSessions: unknown[];
  /** 当前视图正在显示的会话 id：用于过滤后台会话的流式消息，避免串台到当前视图。 */
  currentViewSessionId: string;
} = {
  post: () => {},
  todoCard: null,
  currentSubLog: null,
  lastSessions: [],
  currentViewSessionId: "",
};

export function setPost(fn: (msg: unknown) => void): void {
  ui.post = fn;
}

/** 内置主题 id（与 package.json freesek.theme 枚举一致）。 */
export const THEMES = ["default", "genshin", "wuthering", "academic", "industrial"] as const;
export type ThemeId = (typeof THEMES)[number];

/** 插件皮肤（freeseek plugin add 安装，后端 settings 下发）。 */
export interface PluginThemeInfo {
  name: string;
  label: string;
  css: string;
}

const pluginThemes: PluginThemeInfo[] = [];

/** 注册插件皮肤：注入 <style id="plugin-theme-<name>"> 并进入可切换集合。 */
export function registerPluginThemes(list: PluginThemeInfo[]): void {
  pluginThemes.length = 0;
  for (const item of list) {
    if (!item || !item.name || typeof item.css !== "string") continue;
    let style = document.getElementById(`plugin-theme-${item.name}`) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement("style");
      style.id = `plugin-theme-${item.name}`;
      document.head.appendChild(style);
    }
    style.textContent = item.css;
    pluginThemes.push(item);
  }
}

/** 当前已注册的插件皮肤（设置面板渲染用）。 */
export function getPluginThemes(): PluginThemeInfo[] {
  return [...pluginThemes];
}

/**
 * 应用面板主题：切换 <body data-theme="...">，由 html.ts 与插件注入的 CSS 生效。
 * 默认主题不设 data-theme，完全跟随 VS Code 编辑器主题。
 * 内置主题与插件皮肤等价放行，未知主题回落默认。
 */
export function applyTheme(name: string): void {
  const t =
    (THEMES as readonly string[]).includes(name) || pluginThemes.some((p) => p.name === name) ? name : "default";
  if (t === "default") delete document.body.dataset.theme;
  else document.body.dataset.theme = t;
}
