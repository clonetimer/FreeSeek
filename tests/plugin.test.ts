import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parsePluginSpec,
  installPlugin,
  uninstallPlugin,
  listPlugins,
  listInstalledThemes,
} from "../src/plugin";

/** 构造一个含 plugin.json + 内容的临时套件，返回套件目录。 */
function makePluginKit(files: Record<string, string>, manifest: Record<string, unknown>): string {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), "fsplug-"));
  fs.writeFileSync(path.join(kit, "plugin.json"), JSON.stringify(manifest), "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(kit, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return kit;
}

function makeProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
}

test("parsePluginSpec: 识别三种协议来源", () => {
  const npm = parsePluginSpec("npm:@scope/pkg@1.2.3");
  assert.equal(npm.source, "npm");
  assert.equal(npm.raw, "@scope/pkg@1.2.3");
  assert.equal(npm.label, "npm:@scope/pkg@1.2.3");

  const git = parsePluginSpec("git:https://github.com/foo/bar.git");
  assert.equal(git.source, "git");
  assert.equal(git.raw, "https://github.com/foo/bar.git");

  const file = parsePluginSpec("file:./my-kit");
  assert.equal(file.source, "file");
  assert.equal(file.raw, "./my-kit");
});

test("parsePluginSpec: 裸 spec 按本地路径特征路由到 file，否则按 npm 包处理", () => {
  assert.equal(parsePluginSpec("@scope/pkg@1.0.0").source, "npm");
  assert.equal(parsePluginSpec("some-pkg").source, "npm");
  assert.equal(parsePluginSpec("./dir").source, "file");
  assert.equal(parsePluginSpec("/abs/dir").source, "file");
  assert.equal(parsePluginSpec("C:\\Users\\x\\kit").source, "file");
});

test("parsePluginSpec: 空 spec 报错", () => {
  assert.throws(() => parsePluginSpec("   "), /空插件 spec/);
});

test("installPlugin(file): 落地 skills/commands/agents/themes 并登记注册表", async () => {
  const kit = makePluginKit(
    {
      "skills/review/SKILL.md": "SOP",
      "commands/commit.md": "run commit",
      "agents/tester.md": "tester role",
      "themes/mono.css": 'body[data-theme="mono"] { --bg: #000; }',
    },
    {
      name: "plug-demo",
      skills: [{ name: "review" }],
      commands: [{ name: "commit" }],
      agents: [{ name: "tester" }],
      themes: [{ name: "mono" }],
    }
  );
  const proj = makeProject();
  const res = await installPlugin(`file:${kit}`, proj);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.source, "file");
  assert.ok(res.install, "应返回 install 结果");
  assert.equal(res.install!.themes, 1, res.message);

  // 落地文件
  assert.ok(fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(proj, ".agent", "commands", "commit.md")));
  assert.ok(fs.existsSync(path.join(proj, ".agent", "agents", "tester.md")));
  assert.ok(fs.existsSync(path.join(proj, ".agent", "themes", "mono.css")));

  // 注册表登记
  const plugins = listPlugins(proj);
  assert.ok(plugins.some((p) => p.name === "plug-demo"), "应登记到 kits 注册表");
});

test("installPlugin(file): 无 plugin.json 的目录安装失败", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "fsplug-"));
  const proj = makeProject();
  const res = await installPlugin(empty, proj);
  assert.equal(res.ok, false);
});

test("listInstalledThemes: 扫描 .agent/themes/*.css，忽略非 css", () => {
  const proj = makeProject();
  const dir = path.join(proj, ".agent", "themes");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "mono.css"), "a{}", "utf8");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a theme", "utf8");
  const themes = listInstalledThemes(proj);
  assert.deepEqual(themes.map((t) => t.name), ["mono"]);
  assert.equal(themes[0].css, "a{}");
});

test("uninstallPlugin: 依据注册表逆操作，文件被清除", async () => {
  const kit = makePluginKit(
    { "skills/review/SKILL.md": "SOP", "themes/mono.css": "a{}" },
    {
      name: "plug-remove",
      skills: [{ name: "review" }],
      themes: [{ name: "mono" }],
    }
  );
  const proj = makeProject();
  const res = await installPlugin(`file:${kit}`, proj);
  assert.equal(res.ok, true, res.message);

  const un = uninstallPlugin(proj, "plug-remove");
  assert.ok(un.removed.length > 0, "应删除已安装文件");
  assert.ok(!fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(proj, ".agent", "themes", "mono.css")));
  assert.ok(!listPlugins(proj).some((p) => p.name === "plug-remove"), "注册表应移除登记");
});
