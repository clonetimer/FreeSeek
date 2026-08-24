# FreeSeek Hosts

Host 只负责把外部交互环境适配到 FreeSeek Kernel。

- `vscode/`：编辑器 UI、LSP、Diff review、VS Code SecretStorage 等。
- `cli/`：终端、CI、脚本和无人值守运行。
- `acp/`：ACP v1 protocol adapter，面向其它编辑器/IDE/客户端。

Host 不拥有工具安全策略，也不得直接执行 raw tool body。
