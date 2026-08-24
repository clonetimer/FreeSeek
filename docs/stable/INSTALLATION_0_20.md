# FreeSeek 0.20.0 安装说明

## Desktop Windows x64
1. 解压 `FreeSeek-Desktop-0.20.0-Stable-win32-x64.zip`。
2. 运行 `FreeSeek.exe`。
3. 在 Settings 中配置 Provider。

该包是未执行 Authenticode 的本地/内部 Stable 包；Windows 可能显示未知发布者提示。

## CLI
1. 安装 Node.js 18 或更高版本。
2. 解压 CLI 包。
3. 执行 `node freeseek.js --help`。

## VS Code Extension
本交付包包含稳定 Extension Source/Host bundle 与离线构建说明。若使用 VSIX，请在具备锁定 npm 依赖的环境执行包内的 packaging 脚本生成 VSIX。

## Source
源码包包含完整 0.20.0 Stable 源码；Git bundle 包含可恢复历史。
