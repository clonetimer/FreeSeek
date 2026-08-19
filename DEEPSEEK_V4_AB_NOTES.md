# DeepSeek V4 A/B readiness

本轮在 Context Presentation v1.2 基线上完成：

- DeepSeek 官方默认 endpoint 迁到 `https://api.deepseek.com`；
- 官方模型默认改为 `deepseek-v4-flash`，并提供 `deepseek-v4-pro`；
- 更新 V4 cache-miss input / output 的近似成本估算；
- 修复 thinking-mode tool call 后 `reasoning_content` 未回传、未持久化的问题；
- 新增 `npm run bench:deepseek-context`，默认跑 Public context 的 `v1.1 → v1.2`、repeat=3；
- API key 只允许环境变量输入，dry-run/report 不输出 key；
- 新增 DeepSeek V4 与安全 wrapper 回归测试。

验证：工程 6 道门禁通过，312/312 tests 通过，Public gold 20/20，retrieval 指标未改变。

当前执行沙箱没有任何出站网络能力，因此无法在本环境向 DeepSeek 官方 API 发出真实模型请求；没有用 fake/synthetic 分数冒充 DeepSeek A/B。详见 `docs/deepseek-v4-ab.md` 在联网开发机运行。
