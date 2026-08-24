# FreeSeek 版本与分支规范

## 版本号

FreeSeek 使用 SemVer：`MAJOR.MINOR.PATCH[-PRERELEASE]`。

0.x 阶段语义：

- `MINOR`：一个可独立描述的产品能力阶段，例如 0.20 = standalone desktop host；
- `PATCH`：稳定分支兼容性修复，不承载大型新功能；
- `dev.N`：工程骨架/内部集成，允许功能不完整；
- `alpha.N`：核心接口可运行，但能力或兼容性仍不完整；
- `beta.N`：目标功能完整，重点转向兼容、回归和性能；
- `rc.N`：只接受阻塞性修复，不再增加产品范围；
- 无后缀：Stable。

标准推进：

`0.20.0-dev.1 → 0.20.0-alpha.1 → ... → 0.20.0-beta.1 → 0.20.0-rc.1 → 0.20.0`

## 分支

- `main`：始终指向最新 Stable；禁止直接做功能开发。
- `dev/<minor>`：当前 minor 的集成主线，例如 `dev/0.20`。
- `feat/<topic>`：短生命周期功能分支，从当前 `dev/<minor>` 分出并合回。
- `fix/<topic>`：开发线普通缺陷。
- `hotfix/<topic>`：从 `main` 分出，只修稳定版阻塞问题；完成后同时回合 `main` 和当前 `dev/*`。

## Tag

- Stable：`v0.20.0`
- Pre-release：`v0.20.0-alpha.1` / `v0.20.0-rc.1`
- Tag 必须指向通过 release gate 的提交，不移动 tag。

## 稳定版保护

- Stable tag 之后不改写历史。
- 新功能不得通过修改稳定归档包的方式“就地升级”。
- 需要修 0.18 时发布 `0.18.1`，而不是重新生成另一个内容不同但仍叫 0.18.0 的包。

## 版本单一真相源

发布版本号的权威值是 `package.json#version`；`docs/project/project-state.json` 必须与其一致。
`npm run check` 会验证二者一致性。
