# General HMR H0-H4 部署与使用

General HMR 属于 FreeSeek 平台，不属于某一个 Host。

## Trusted package

每个包包含 `freeseek-extension.json` 和入口文件，例如：

```json
{
  "schemaVersion": 1,
  "id": "demo.tools",
  "version": "1.0.0",
  "trust": "trusted",
  "capabilities": { "tools": true },
  "entry": "index.cjs"
}
```

入口示例：

```js
module.exports = function activate(ctx) {
  ctx.registerTool({
    name: "echo",
    description: "demo echo",
    parameters: { type: "object" },
    runtime: { effect: "read", concurrency: "parallel", readOnlyAllowed: true, approval: "auto" },
    execute: async (args) => String(args.text ?? "")
  });
};
```

Host 通过 `--extension-dir /absolute/root` 或对应 UI/VS Code 设置显式信任根目录。文件变化会 stage 新 generation；新 Agent run 获取新 generation，旧 run 保持旧 lease。

## H2 contributions

Trusted package 可声明 Skill snapshots、monotonic Policy/Hook、MCP tool adapter。Policy/Hook 只能增加限制或提示，不能覆盖 built-in deny/approval。

## H3 management

支持 list/status/reload/remove(really disable+retire)/reconcile/config/audit。管理面不能新增 trust roots，也不能扩大 H4 capability grants。

## H4 untrusted Tool sandbox

`trust=untrusted` 不允许 Host 进程内执行。0.22 Source Stable 的已验证实现是 Linux + Node >=22 的 out-of-process Tool sandbox；其他平台 fail-closed。H4 v1 不支持 untrusted Connector/Skill/Hook/MCP/UI，也不支持 shell/process spawn。
