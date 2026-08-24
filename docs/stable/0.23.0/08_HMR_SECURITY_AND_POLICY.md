# HMR 安全模型与 Sandbox Policy

## 支持矩阵

| 能力 | Linux | Windows | macOS |
|---|---:|---:|---:|
| H0 generation lifecycle | 支持 | 支持 | 支持 |
| H1 trusted package HMR | 支持 | 支持 | 支持 |
| H2 trusted contributions | 支持 | 支持 | 支持 |
| H3 management/audit | 支持 | 支持 | 支持 |
| H4 untrusted Tool sandbox | 支持（需 Node>=22 + namespace/chroot） | fail-closed | fail-closed |

H4 不是 VM/hypervisor 安全边界，不声称抵御未知 Node/Linux kernel escape。

## Policy 原则

- policy 是 Host 启动时只读输入；H3 运行时管理不能扩大 grant。
- filesystem 只允许显式 absolute real roots。
- network 只允许 exact HTTP(S) origin。
- package capability 声明不能扩大 Host grant。
- network broker 还要求具体 Tool `runtime.requiresNetwork=true`。
- shell/process spawn 在 H4 v1 中不开放。

示例结构：

```json
{
  "grants": {
    "demo.sandbox": {
      "filesystem": {
        "read": ["/srv/project/input"],
        "write": ["/srv/project/output"]
      },
      "network": {
        "allowedOrigins": ["https://api.example.com"]
      }
    }
  }
}
```
