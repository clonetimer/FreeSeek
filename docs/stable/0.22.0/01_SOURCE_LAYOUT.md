# 源码结构与构建入口

## 关键目录

- `src/`：共享 Agent/Kernel、ToolRuntime、ToolRegistry、Provider、Skills、CLI/ACP/VS Code host glue。
- `src/kernel/extensions/`：General HMR H0-H4。
- `src/hosts/`：非 VS Code Host 适配层。
- `apps/desktop/`：Electron Desktop shell/renderer/preload/main。
- `scripts/`：check/test/release/Desktop 发行与证据脚本。
- `docs/`：架构、CLI、ACP、项目状态与稳定版资料。
- `tests/`：核心/Host/HMR/Desktop 回归。

## 标准源码构建

要求 Node.js >=18；H4 Linux untrusted sandbox 要求 Node.js >=22，并且主机支持所需 Linux namespace/chroot 隔离原语。

```bash
npm ci
npm run check
npm test
npm run compile
```

生产构建：

```bash
node esbuild.js --production
```

Desktop：

```bash
npm --prefix apps/desktop ci
npm run desktop:build
npm --prefix apps/desktop start
```

当前 Source Stable Kit 不携带 `node_modules`。应使用 lockfile 恢复依赖，不应把其他版本依赖树复制进源码。
