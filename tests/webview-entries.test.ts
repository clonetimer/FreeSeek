/**
 * Webview 功能入口契约测试（零依赖，node:test）。
 * 覆盖：webview 侧边栏工具区按钮 + 顶部「工具」下拉菜单项
 *  ↔ main.ts 的 ui.post 接线 ↔ extension.ts 的 case 分发
 *  ↔ 转发的 freesek.* 命令 / 方法 ↔ package.json 已注册命令
 * 四者必须一致。侧边栏按钮用字面量 type；工具下拉用 data-act + 动态派发。
 */
import { test } from 'node:test';
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

// 测试 runner 始终以仓库根为 cwd；不要依赖 bundle/tsc 输出目录的 __dirname。
const root = process.cwd();

type Entry =
  | { type: string; source: "sidebar" | "tools-menu"; btnId?: string; via: "command"; command: string }
  | { type: string; source: "sidebar" | "tools-menu"; btnId?: string; via: "method"; method: string; command: string };

/** Webview 入口契约表：type → 来源（侧边栏按钮 或 顶部工具下拉）→ 转发目标 */
const entries: Entry[] = [
  // 侧边栏工具区按钮（字面量 ui.post({ type: "X" })）
  { type: "schedules", source: "sidebar", btnId: "schedulesSb", via: "command", command: "freesek.addSchedule" },
  { type: "install_kit", source: "sidebar", btnId: "installKitSb", via: "command", command: "freesek.installKit" },
  { type: "start_free_server", source: "sidebar", btnId: "freeServerSb", via: "command", command: "freesek.startFreeServer" },
  { type: "edit_providers", source: "sidebar", btnId: "editProvidersSb", via: "method", method: "editProviders", command: "freesek.editProviders" },
  { type: "open_session_log", source: "sidebar", btnId: "sessionLogSb", via: "method", method: "openSessionLog", command: "freesek.openSessionLog" },
  { type: "hookify", source: "sidebar", btnId: "hookifySb", via: "command", command: "freesek.manageHookifyRules" },
  { type: "manage_kits", source: "sidebar", btnId: "manageKitsSb", via: "method", method: "manageKits", command: "freesek.manageKits" },
  // 顶部「工具」下拉菜单项（main.ts 用 data-act 动态派发）
  { type: "schedules", source: "tools-menu", via: "command", command: "freesek.addSchedule" },
  { type: "manage_schedules", source: "tools-menu", via: "command", command: "freesek.manageSchedules" },
  { type: "hookify", source: "tools-menu", via: "command", command: "freesek.manageHookifyRules" },
  { type: "install_kit", source: "tools-menu", via: "command", command: "freesek.installKit" },
  { type: "manage_kits", source: "tools-menu", via: "method", method: "manageKits", command: "freesek.manageKits" },
  { type: "start_free_server", source: "tools-menu", via: "command", command: "freesek.startFreeServer" },
  { type: "edit_providers", source: "tools-menu", via: "method", method: "editProviders", command: "freesek.editProviders" },
  { type: "open_session_log", source: "tools-menu", via: "method", method: "openSessionLog", command: "freesek.openSessionLog" },
];

const mainTs = fs.readFileSync(path.join(root, "src/webview/main.ts"), "utf8");
const extTs = fs.readFileSync(path.join(root, "src/extension.ts"), "utf8");
const htmlTs = fs.readFileSync(path.join(root, "src/webview/html.ts"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const registeredCommands: string[] = (pkg.contributes?.commands ?? []).map((c: any) => c.command);

test("每个 webview 入口：main.ts 都有对应 post type 接线", () => {
  // 侧边栏：要求字面量 ui.post({ type: "X" })；工具下拉：要求动态派发存在（type: act 或 dataset.act）
  for (const e of entries) {
    if (e.source === "sidebar") {
      assert.ok(
        mainTs.includes(`ui.post({ type: "${e.type}" }`),
        `侧边栏按钮缺 ui.post({ type: "${e.type}" }) 接线`
      );
    } else {
      // tools-menu：通过 #toolsMenu .dropdown-item 的 dataset.act + ui.post 动态派发
      assert.ok(mainTs.includes("#toolsMenu"), "main.ts 缺 #toolsMenu 选择器");
      assert.ok(mainTs.includes("dataset.act"), "main.ts 缺 dataset.act 处理");
      assert.ok(/ui\.post\(\s*\{\s*type:\s*[^}]*\}/.test(mainTs), "main.ts 缺动态 ui.post 模板");
    }
  }
});

test("每个侧边栏按钮入口：html.ts 存在对应元素", () => {
  for (const e of entries) {
    if (!e.btnId) continue;
    assert.ok(htmlTs.includes(`id="${e.btnId}"`), `html.ts 缺少按钮 #${e.btnId}`);
  }
});

test("每个工具下拉菜单项：html.ts 在 #toolsMenu 内声明", () => {
  for (const e of entries) {
    if (e.source !== "tools-menu") continue;
    assert.ok(
      htmlTs.includes(`data-act="${e.type}"`),
      `html.ts 的 #toolsMenu 缺少 data-act="${e.type}"`
    );
  }
});

test("html.ts 顶部工具栏存在 #toolsDropdown 与 #toolsBtn", () => {
  assert.ok(htmlTs.includes(`id="toolsDropdown"`), "html.ts 缺少 #toolsDropdown");
  assert.ok(htmlTs.includes(`id="toolsBtn"`), "html.ts 缺少 #toolsBtn");
});

test("每个 webview 入口：extension.ts 有对应 case 并转发到正确目标", () => {
  for (const e of entries) {
    assert.ok(extTs.includes(`case "${e.type}":`), `extension.ts 缺少 case "${e.type}": 分发`);
    if (e.via === "command") {
      assert.ok(
        extTs.includes(`executeCommand("${e.command}")`),
        `extension.ts 的 case "${e.type}" 未转发到命令 ${e.command}`
      );
    } else {
      assert.ok(
        extTs.includes(`this.${e.method}()`),
        `extension.ts 的 case "${e.type}" 未调用 this.${e.method}()`
      );
    }
  }
});

test("每个 webview 入口关联的命令已在 package.json 注册", () => {
  for (const e of entries) {
    assert.ok(
      registeredCommands.includes(e.command),
      `命令 ${e.command} 未在 package.json contributes.commands 中注册`
    );
  }
});