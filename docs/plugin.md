# Plugin Ecosystem（0.26.0）

FreeSeek 0.26.0 引入**插件加装与套件皮肤**（对标 `dsh plugin add <spec>` / codex `codex plugin`）：
第三方套件（skills / commands / agents / themes）可安装进项目 `.agent/`，并可为 Web Console / VS Code 面板提供可注入的 UI 皮肤。

入口：`src/plugin.ts`（运行时）、`src/plugin-cli.ts`（CLI 分发）、`src/kits.ts`（落地与 themes 类型）。

## CLI

```bash
freeseek plugin add @scope/pkg@1.2.3     # npm registry（npm pack + tar 解包）
freeseek plugin add github:user/repo     # git clone --depth 1
freeseek plugin add file:./my-kit        # 本地目录直取
freeseek plugin add /abs/path/to/kit     # 绝对路径按 file 处理
freeseek plugin add <spec> --root <dir>  # 指定落地项目根（默认当前目录）
freeseek plugin remove my-kit            # 依 .agent/kits.json 注册表逆操作
freeseek plugin list [--json]            # 已安装套件与皮肤
```

spec 语法（`parsePluginSpec`）：`npm:`（裸 `@scope/pkg@ver` 默认按 npm registry）、`git:`（含 `github:user/repo` 短路径）、`file:` / 本地路径直取。

## 套件形态

套件根必须有 `plugin.json`（或 `package.json` 的 `freesek.plugin` 段）：

```json
{
  "name": "my-kit",
  "skills": [{ "name": "review" }],
  "commands": [{ "name": "commit" }],
  "agents": [{ "name": "tester" }],
  "themes": [{ "name": "mono", "file": "themes/mono.css" }]
}
```

目录约定（相对套件根）：`skills/<name>/SKILL.md`、`commands/<name>.md`、`agents/<name>.md`、`themes/<name>.css`（`file` 省略时默认 `themes/<name>.css`）。

## 落地与可逆卸载

- `installPlugin`（`src/plugin.ts`）下载/定位后复用 `installKit`（`src/kits.ts`）：skills / commands / agents / themes 复制到项目 `.agent/`，并在 `.agent/kits.json` 登记套件清单。
- `uninstallPlugin` / `freeseek plugin remove` 依据注册表逆操作删除，构成可逆闭环。
- 已安装主题清单由 `listInstalledThemes(projectRoot)` 扫描 `.agent/themes/*.css` 提供，供 Web Console / VS Code 设置面板主题下拉注入（`registerPluginThemes` + `applyTheme`，`body[data-theme]`，纯 CSS 变量覆盖）。

## 测试

`tests/plugin.test.ts`：7 个单测覆盖 spec 解析、`file:` 安装闭环、主题扫描、可逆卸载与错误路径。
