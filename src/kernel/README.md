# FreeSeek Kernel boundary

`src/kernel/` contains host-neutral contracts and, over the 0.19 line, the services that are shared by every product surface.

Hard rules:

1. Kernel code must not import `vscode`.
2. Kernel code must not import `src/hosts/*` or `src/webview/*`.
3. UI/transport hosts depend on the kernel; the kernel never depends on a host.
4. Host capabilities describe interaction services only. They never bypass `ToolRegistry -> ToolRuntime` policy/approval/sandbox enforcement.
5. Migration from the legacy flat `src/` tree is incremental and behavior-preserving; no big-bang file move is allowed without an independent regression gate.
