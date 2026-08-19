# FreeSeek Bench v2 — Private Holdout 与 Pinned Real Repositories

Bench v2 把日常回归、私有泛化评测和真实仓库评测拆成三个互不替代的层级：

```text
public v1 micro-regression
        +
private v2 holdout
        +
public real-v1 pinned repositories
        ↓
      Eval Harness
        ↓
Headless → ToolRegistry → ToolRuntime → EventLog
```

公开 v1 适合每次 PR 快速跑；private holdout 用来检测 prompt/context/tool 改动是否只是在公开题上过拟合；real-v1 用历史真实仓库状态验证 Agent 在非合成目录结构中的定位和修改能力。

## v2 source schema

v2 case 不再直接写绝对 workspace，而必须声明 `source`。本地私有 pack 使用 manifest 相对路径：

```json
{
  "kind": "local",
  "path": "./fixtures/holdout-001"
}
```

真实仓库使用 immutable Git pin：

```json
{
  "kind": "git",
  "url": "https://github.com/owner/repo.git",
  "commit": "<full-40-or-64-hex-sha>",
  "goldCommit": "<full-40-or-64-hex-sha>"
}
```

禁止 branch/tag/短 SHA。HTTP、SSH、`git://` 与 URL 内嵌凭据也拒绝；公开 real-v1 进一步由工程门禁限制为 HTTPS。

Git source 首次运行保存为 bare cache，执行时从固定 commit 物化到临时目录。`--offline-sources` 要求所需 base/gold commit 已在 cache 中，否则 fail-closed，不会偷偷使用当前默认分支。

## Private holdout

创建仓库外私有 pack：

```bash
freeseek-bench init-holdout --out ~/.freesek/private-bench
```

然后编辑：

```text
private-bench/
  manifest.json
  fixtures/
  verifiers/
```

验证：

```bash
freeseek-bench validate \
  --suite ~/.freesek/private-bench/manifest.json \
  --trust-suite \
  --gold
```

private suite 的 verifier 是宿主代码，只有显式 `--trust-suite` 才执行。verifier 必须位于 Agent workspace 之外，因此模型不能通过修改 verifier 来骗过评测。

### 默认脱敏

`visibility: "private"` 时，落盘 report 默认：

- suite 名改为 `private-holdout`；
- case id 转为稳定 opaque id；
- prompt 不进入 report；
- tags、workspace、sessionDir、stdout/stderr、verifier check 细节删除；
- Provider endpoint 删除；
- Git URL/commit/repository hash 不进入共享 report；
- 每个 attempt 的 session/event trace 默认从磁盘清理。

只保留 correctness、token、steps、tool calls、duration、approval/blocked/timeout 等比较所需指标。调试私有失败时可显式 `--keep-private-traces`，但这些 trace 不应上传公开 CI artifact。

`.gitignore`、`.vscodeignore` 与 `npm run check` 都把 `benchmarks/private/` / `.freesek-holdout/` 视为泄漏边界。推荐仍将真正 holdout 放在 FreeSeek 仓库之外。

## Real Repo v1

内置 real-v1 只保存 source coordinates、任务元数据与 FreeSeek 自己的 host verifier，不重新分发第三方仓库源码。

```bash
freeseek-bench list --real
freeseek-bench validate --real --gold
freeseek-bench run --real --base-url ... --api-key ... --model ...
```

当前三题来自历史已合并 PR 的 base/head：

- `escape-string-regexp-unicode-hyphen`；
- `p-defer-unbound-method-typing`；
- `is-stream-http-instances`。

base commit 是 Agent 起点，gold commit 仅用于 suite 自检，不提供给 Agent。host verifier 位于 `benchmarks/real-v1/verifiers/`，在 Agent 完成后由评测宿主执行。

这些题故意不依赖 `npm install`：验证器只使用 Node 内置模块读取/加载目标文件，因此能作为轻量真实仓库层。未来需要完整依赖环境的任务应接 Docker/Remote Sandbox execution world，而不是让 benchmark runner 随机安装最新依赖。

## Cache 与 CI

建议 CI 分两阶段：

```text
trusted prewarm job (network)
  ↓ immutable git cache artifact
benchmark job (--offline-sources)
```

cache identity 基于 repository URL hash；每个运行仍用完整 commit 做 `cat-file` / `rev-parse` 校验。cache 只影响获取成本，不参与 benchmark correctness。

## 结果纪律

三层 suite 不应该混成一个排行榜分数。比较时至少要求：

- `sameSuiteFingerprint=true`；
- `sameSelection=true`；
- 相同 repeat 和相同权限/模型配置；
- private/public/real 分开报告。

公开 v1 是 regression，不是 holdout；private holdout 是本地/组织内部评测，不应提交到源码；real-v1 是公开历史任务，也可能被模型训练数据包含，因此同样不能被宣传成“无污染能力分数”。
