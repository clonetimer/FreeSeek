# 升级指南：0.20/0.21 RC → 0.22

0.22 继承完成后的 Desktop UI U0-U5，并增加 General HMR H0-H4。

## 配置原则

- 原有 Provider、session、skills、MCP 配置继续使用各 Host 既有入口。
- General HMR 默认不会扫描工作区；需要显式配置 Extension root。
- 未配置 H4 policy 时，untrusted Tool 的 filesystem/network capability fail-closed。
- Windows/macOS 上 H4 untrusted sandbox fail-closed；trusted HMR H0-H3 不因此关闭。

## 回滚

生产环境应保留上一 Stable 的源码/制品和 session 数据备份。Extension package reload 有 generation-level LKG rollback，但它不等价于整个 FreeSeek 产品安装回滚。
