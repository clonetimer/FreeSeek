# Third-Party Notices

FreeSeek Coder 基于 [Deep Copilot](https://github.com/deep-copilot/DeepCopilot)
架构继续开发，并集成了若干开源组件。本文件列出随扩展分发或运行时依赖的第三方
软件及其许可证。完整许可证文本见各项目源仓库或本地 `node_modules/<pkg>/LICENSE*`。

## 随扩展分发的组件

### deepseek-free-api（内置 vendored 源码）

- **项目**：[jonnyquan/deepseek-free-api](https://github.com/jonnyquan/DeepSeek-Free-Api)（作者 Vinlic）
- **版本**：v0.0.17（目录：`deepseek-free-api/`）
- **许可证**：`deepseek-free-api/package.json` 声明为 **ISC**；
  仓库内 `LICENSE` 文件为 **GPL-3.0**。二者存在不一致，以 `LICENSE` 文件为准。
- **用途**：把 chat.deepseek.com 免费网页对话转成 OpenAI 兼容接口的本地服务，
  随扩展打包以便「启动免费 DeepSeek 服务」的 Node 方式离线安装运行。
- **注意**：GPL-3.0 是 copyleft 许可证。该目录独立于 FreeSeek 本体分发，
  仅作为独立服务运行，不与扩展代码合并编译。

### PaperSeek 连接器

- **项目**：[MingfengHong/PaperSeek](https://github.com/MingfengHong/PaperSeek)
- **许可证**：**Apache-2.0**
- **用途**：学术文献检索（OpenAlex / arXiv / Semantic Scholar / PubMed /
  Google Scholar / 顶会），FreeSeek 通过其 CLI（`paperseek search`）调用，
  不内嵌其代码。需用户自行 `pip install "paperseek[mcp]"`。

## 运行时依赖（npm）

### mermaid

- **版本**：^11.16.1
- **许可证**：**MIT**
- **用途**：webview 中懒加载渲染 ```` ```mermaid ```` 代码块为 SVG 图表。
- **完整文本**：`node_modules/mermaid/LICENSE`

## 打包进扩展 bundle 的前端依赖

以下依赖在构建时经 esbuild 打包进 `dist/`（webview 端），随扩展分发。

### marked

- **版本**：^16.4.2
- **许可证**：**MIT**
- **用途**：markdown 渲染。
- **完整文本**：`node_modules/marked/LICENSE.md`

### dompurify

- **版本**：^3.4.13
- **许可证**：**MPL-2.0 OR Apache-2.0**（双许可，任选其一）
- **用途**：markdown HTML 净化（XSS 防护）。
- **完整文本**：`node_modules/dompurify/LICENSE`

### highlight.js

- **版本**：^11.9.0
- **许可证**：**BSD-3-Clause**
- **用途**：代码块语法高亮。
- **完整文本**：`node_modules/highlight.js/LICENSE`

## 构建 / 开发期依赖（不随扩展分发）

| 组件 | 版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| esbuild | ^0.21.0 | MIT | 构建打包 |
| typescript | ^5.4.0 | Apache-2.0 | 类型检查 / 编译 |
| @vscode/vsce | ^3.9.2 | MIT | vsix 打包发布 |
| @types/vscode | ^1.85.0 | MIT | VS Code API 类型 |
| @types/node | ^20.11.0 | MIT | Node 类型 |

## 协议 / 服务声明

FreeSeek 对接的外部服务（DeepSeek 官方 API、deepseek-free-api 逆向服务、
各第三方 Provider、MCP server）均为用户自行配置接入，与以上开源组件无关。

## 许可证全文

各许可证全文可从以下地址获取：

- MIT：<https://opensource.org/licenses/MIT>
- Apache-2.0：<https://www.apache.org/licenses/LICENSE-2.0>
- BSD-3-Clause：<https://opensource.org/licenses/BSD-3-Clause>
- MPL-2.0：<https://www.mozilla.org/en-US/MPL/2.0/>
- ISC：<https://opensource.org/licenses/ISC>
- GPL-3.0：<https://www.gnu.org/licenses/gpl-3.0.html>

本扩展本体采用 MIT 许可证，见 [LICENSE](LICENSE)。
