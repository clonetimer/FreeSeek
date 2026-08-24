# VS Code 部署与使用

## 源码调试

```bash
npm ci
npm run compile
```

随后用 VS Code 打开仓库并按 F5 启动 Extension Development Host。

## VSIX

正式构建环境中：

```bash
npx --no-install vsce package --no-dependencies
code --install-extension freeseek-copilot-0.22.0.vsix
```

## General HMR

设置：

- `freesek.extensionDirs`：显式可信 Extension 根目录数组，只接受绝对路径；不会自动扫描 workspace。
- `freesek.extensionSandboxPolicyFile`：H4 startup-only policy 文件绝对路径。

修改进程级 HMR 配置后应 Reload Window，使 Extension Host 按新启动策略重建。
