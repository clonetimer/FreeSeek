/**
 * 测试环境的 vscode API stub（最小可用）。
 * 被 tests/*.test.ts 通过 esbuild `--alias:vscode=` 引用，
 * 让纯逻辑模块（context / provider / promptFragments …）能在 node:test 下 bundle 运行，
 * 而无需真正加载 vscode 扩展运行时。
 * 原则：凡测试会触碰到的 API 给最小实现，其余用 Proxy 兜底返回无害值，不抛错。
 */

function cfgGet(_key: string, def: unknown): unknown {
  return def;
}

const configuration = new Proxy(
  { get: cfgGet, update: async () => {} },
  {
    get: (t, k) => {
      if (typeof k === "string" && k in t) return (t as Record<string, unknown>)[k];
      if (k === "get") return cfgGet;
      return () => {};
    },
  }
);

function cfgOf(_section: string): unknown {
  return configuration;
}

const noop = () => {};

export const workspace = new Proxy(
  { getConfiguration: cfgOf, workspaceFolders: [] },
  {
    get: (t, k) => {
      if (typeof k === "string" && k in t) return (t as Record<string, unknown>)[k];
      return noop;
    },
  }
);

export const window = new Proxy(
  {},
  {
    get: () => () => ({ dispose: noop }),
  }
);

export const commands = new Proxy(
  {},
  {
    get: () => () => ({ dispose: noop }),
  }
);

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file", path: p }),
  parse: (s: string) => ({ fsPath: s, scheme: "file", path: s }),
};

export class EventEmitter {
  event = () => ({ dispose: noop });
  fire = noop;
  dispose = noop;
}

export class ThemeIcon {}

export const workspaceFolders: unknown[] = [];
export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const ProgressLocation = { Notification: 1 };
export const ViewColumn = { Active: 1, Beside: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
