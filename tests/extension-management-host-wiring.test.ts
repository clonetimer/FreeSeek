import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * 本测试静态读取源码树断言架构边界。测试可在多种布局下运行（esbuild bundle 位于
 * tests/.build/、tsc-fallback emit 位于 tests/.build/tests/、ts-node 直跑位于 tests/），
 * 因此 ROOT 必须解析到"真实源码树所在"：优先 __dirname/.. 下能找到 src/ 的候选，
 * 否则回退 process.cwd()（两种官方 runner 均以仓库根为 cwd）。
 */
const ROOT = [path.resolve(__dirname, ".."), process.cwd()].find((candidate) =>
  fs.existsSync(path.join(candidate, "src", "hosts", "acp", "server.ts"))
  && fs.existsSync(path.join(candidate, "src", "activate.ts"))
  && fs.existsSync(path.join(candidate, "package.json"))
) ?? process.cwd();
const read = (relative: string) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("H3 ACP management is a FreeSeek vendor adapter, not an ACP v1 session-protocol mutation", () => {
  const server = read("src/hosts/acp/server.ts");
  const adapter = read("src/hosts/acp/extension-management.ts");
  assert.match(server, /handleAcpExtensionManagement\(method, params, this\.extensions\.management\)/);
  assert.doesNotMatch(server, /case "freesek\/extensions\//, "vendor methods should stay outside the ACP session switch");
  for (const op of ["list", "status", "reload", "remove", "reconcile", "config", "audit"]) {
    assert.match(adapter, new RegExp(`freesek/extensions/${op}`));
  }
});

test("H3 Desktop operator UX stays behind preload/main/ACP and keeps Renderer privilege-minimal", () => {
  const renderer = read("apps/desktop/src/renderer.ts");
  const preload = read("apps/desktop/src/preload.ts");
  const main = read("apps/desktop/src/main.ts");
  assert.doesNotMatch(renderer, /node:fs|from ["']fs["']|FileExtensionHost|ExtensionRuntime/);
  assert.match(preload, /desktop:list-extensions/);
  assert.match(main, /validateAbsoluteDirectories\(request\.extensionDirs/);
  assert.match(main, /validateAbsoluteFile\(request\.extensionSandboxPolicyFile/);
  assert.match(renderer, /extensionSandboxPolicyFile/);
  assert.match(main, /runtime\.extensionConfigure/);
});

test("H3 VS Code HMR uses only explicit configured trust roots and global host state", () => {
  const pkg = JSON.parse(read("package.json"));
  const activate = read("src/activate.ts");
  const config = pkg.contributes?.configuration?.properties?.["freesek.extensionDirs"];
  const sandboxPolicy = pkg.contributes?.configuration?.properties?.["freesek.extensionSandboxPolicyFile"];
  assert.ok(config); assert.deepEqual(config.default, []); assert.equal(sandboxPolicy?.default, "");
  assert.ok((pkg.contributes?.commands ?? []).some((row: any) => row.command === "freesek.manageExtensions"));
  assert.match(activate, /get<string\[\]>\("extensionDirs", \[\]\)/);
  assert.match(activate, /get<string>\("extensionSandboxPolicyFile", ""\)/);
  assert.match(activate, /loadExtensionSandboxPolicyFile/);
  assert.match(activate, /filter\(\(dir(?:: string)?\) => path\.isAbsolute\(dir\)\)/);
  assert.match(activate, /context\.globalStorageUri\.fsPath/);
  assert.match(activate, /new ChatViewProvider\(context, extensionHost\?\.runtime\)/);
  assert.doesNotMatch(activate, /\.freesek[\\/]extensions|workspaceFolders.*extension/i);
});
