import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  parseKitManifest,
  installKit,
  uninstallKit,
  listInstalledKits,
  readKitRegistry,
} from "../src/kits";

/** 构造一个含 plugin.json + 若干内容的临时套件，返回套件目录。 */
function makeKit(files: Record<string, string>, manifest: Record<string, unknown>): string {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), "fskit-"));
  fs.writeFileSync(path.join(kit, "plugin.json"), JSON.stringify(manifest), "utf8");
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(kit, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
  }
  return kit;
}

test("parseKitManifest: 解析清单并过滤空名", () => {
  const m = parseKitManifest(
    JSON.stringify({
      name: "demo",
      skills: [{ name: "s1" }, { name: "" }],
      commands: [{ name: "c1" }],
      agents: [{ name: "a1" }],
    })
  );
  assert.ok(m);
  assert.equal(m!.name, "demo");
  assert.equal(m!.skills!.length, 1);
  assert.equal(m!.commands!.length, 1);
  assert.equal(m!.agents!.length, 1);
});

test("installKit: 落位到项目约定目录", () => {
  const kit = fs.mkdtempSync(path.join(os.tmpdir(), "fskit-"));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  fs.writeFileSync(
    path.join(kit, "plugin.json"),
    JSON.stringify({
      name: "demo",
      skills: [{ name: "review" }],
      commands: [{ name: "commit" }],
      agents: [{ name: "tester" }],
    })
  );
  fs.mkdirSync(path.join(kit, "skills", "review"), { recursive: true });
  fs.writeFileSync(path.join(kit, "skills", "review", "SKILL.md"), "SOP", "utf8");
  fs.mkdirSync(path.join(kit, "commands"), { recursive: true });
  fs.writeFileSync(path.join(kit, "commands", "commit.md"), "run commit", "utf8");
  fs.mkdirSync(path.join(kit, "agents"), { recursive: true });
  fs.writeFileSync(path.join(kit, "agents", "tester.md"), "tester role", "utf8");

  const r = installKit(kit, proj);
  assert.ok(r);
  assert.equal(r!.skills, 1);
  assert.equal(r!.commands, 1);
  assert.equal(r!.agents, 1);
  assert.ok(fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  assert.ok(fs.existsSync(path.join(proj, ".agent", "commands", "commit.md")));
  assert.ok(fs.existsSync(path.join(proj, ".agent", "agents", "tester.md")));

  fs.rmSync(kit, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("installKit: 登记注册表并返回 installed/overwritten 清单（可逆性）", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  const kit = makeKit(
    { "skills/review/SKILL.md": "SOP v1" },
    { name: "demo", version: "1.2.0", skills: [{ name: "review" }] }
  );
  const r1 = installKit(kit, proj);
  assert.ok(r1);
  assert.equal(r1!.installed.length, 1);
  assert.equal(r1!.overwritten.length, 0);
  // 注册表记录文件清单
  const reg = readKitRegistry(proj);
  assert.ok(reg.kits["demo"]);
  assert.equal(reg.kits["demo"]!.version, "1.2.0");
  assert.equal(reg.kits["demo"]!.files.length, 1);
  // 二次安装：覆盖报告
  const r2 = installKit(kit, proj);
  assert.ok(r2);
  assert.equal(r2!.overwritten.length, 1);
  fs.rmSync(kit, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("installKit: requires 缺失依赖告警但不阻塞", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  const kit = makeKit(
    { "skills/review/SKILL.md": "SOP" },
    { name: "demo", requires: ["missing-skill"], skills: [{ name: "review" }] }
  );
  const r = installKit(kit, proj);
  assert.ok(r);
  assert.deepEqual(r!.missingRequires, ["missing-skill"]);
  assert.ok(fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  fs.rmSync(kit, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("uninstallKit: 逆操作删除已安装文件并移除登记", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  const kit = makeKit(
    { "skills/review/SKILL.md": "SOP", "commands/commit.md": "run" },
    { name: "demo", skills: [{ name: "review" }], commands: [{ name: "commit" }] }
  );
  installKit(kit, proj);
  assert.ok(fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  const res = uninstallKit(proj, "demo");
  assert.equal(res.ok, true);
  assert.equal(res.removed.length, 2);
  assert.ok(!fs.existsSync(path.join(proj, ".agent", "skills", "review", "SKILL.md")));
  assert.ok(!fs.existsSync(path.join(proj, ".agent", "commands", "commit.md")));
  // 注册表已移除
  assert.ok(!readKitRegistry(proj).kits["demo"]);
  // 再次卸载：提示未找到登记
  const again = uninstallKit(proj, "demo");
  assert.equal(again.ok, false);
  fs.rmSync(kit, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

test("uninstallKit: 注册表路径逃逸防护（越界文件不删除）", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  const victim = path.join(proj, "user-kept.txt");
  fs.writeFileSync(victim, "keep me", "utf8");
  // 手工构造恶意注册表：files 指向项目根外/用户文件
  const reg = readKitRegistry(proj);
  reg.kits["evil"] = {
    name: "evil",
    installedAt: "",
    files: ["../user-kept.txt", "user-kept.txt", ".agent/skills/ok/SKILL.md"],
  };
  fs.mkdirSync(path.join(proj, ".agent", "skills", "ok"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".agent", "skills", "ok", "SKILL.md"), "x", "utf8");
  fs.mkdirSync(path.join(proj, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".agent", "kits.json"), JSON.stringify(reg), "utf8");
  const res = uninstallKit(proj, "evil");
  // 只有 .agent 内文件被删，项目内用户文件被跳过（../ 越界 + 用户文件不在登记范围判定）
  assert.ok(fs.existsSync(victim), "项目根下未登记文件应保留");
  assert.ok(!fs.existsSync(path.join(proj, ".agent", "skills", "ok", "SKILL.md")));
  assert.equal(res.removed.length, 1);
  fs.rmSync(proj, { recursive: true, force: true });
});

test("listInstalledKits: 按名称排序列出已装套件", () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "fsproj-"));
  const reg = readKitRegistry(proj);
  reg.kits["b"] = { name: "b", installedAt: "", files: [] };
  reg.kits["a"] = { name: "a", installedAt: "", files: [] };
  fs.mkdirSync(path.join(proj, ".agent"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".agent", "kits.json"), JSON.stringify(reg), "utf8");
  const list = listInstalledKits(proj);
  assert.deepEqual(
    list.map((x) => x.name),
    ["a", "b"]
  );
  fs.rmSync(proj, { recursive: true, force: true });
});