# FreeSeek Bench v1 — Public Core

这是 FreeSeek 自己的**公开持续回归基准**。目标不是制造一个单一排行榜数字，而是持续回答：

1. Agent 是否真的解决了任务；
2. 哪类任务退化了；
3. 在正确率相同的情况下，token / steps / tool calls / duration 是否下降；
4. 安全与上下文优化有没有以牺牲正确率为代价。

## 组成

v1 包含 20 个离线、零第三方运行时依赖的 JavaScript 小型代码库：

- `core`：10 个边界条件、解析、配置、时间/单位等基础程序修复；
- `multifile`：4 个跨文件契约/迁移任务；
- `context`：4 个带 24–30 个干扰模块的代码定位任务；
- `security`：2 个路径穿越/命令注入类修复任务。

每个 case 的 `workspace/` 是模型实际看到的初始代码。`gold/<case-id>/` 不复制给 Agent，只用于基准自检，确保 verifier 确实存在可行解。

## 自检

```bash
freeseek-bench validate --gold
```

自检必须满足：

- pristine workspace 的 verifier 不应全部通过；
- gold overlay 应让对应 verifier 通过；
- case id 唯一；
- workspace 不能逃逸 manifest 目录，也不能包含 symlink/特殊文件；
- suite fingerprint 对相同题库必须稳定。

## 评分

主指标：`weightedScore`（0–100）。

每个 case 的得分为多次运行的 `successRate`，再按 `weight` 汇总。`repeat=1` 时等价于加权 resolved rate。

辅助指标独立报告，不混进主分：

- token；
- steps；
- tool calls；
- duration；
- blocked / timeout；
- approvals；
- budget pass rate。

这样不会出现“通过砍掉工具步骤换一个高综合分，但实际少解题”的情况。

## Public vs Holdout

这一套公开任务适合 PR/版本回归，不适合声称是防污染排行榜。后续可以使用相同 manifest schema 建立：

- 私有 holdout；
- 真实 GitHub issue / pinned commit suite；
- Docker / Remote Sandbox suite；
- 多语言 suite。

公开 gold 的存在是为了验证 harness 和题目可解性，而不是为了排行榜保密性。
