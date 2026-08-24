import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { SYSTEM_PROMPT } from "../src/prompts";

test("FreeSeek core persona 不把 Kernel 写死为 VS Code 或 DeepSeek", () => {
  assert.match(SYSTEM_PROMPT, /FreeSeek/);
  assert.match(SYSTEM_PROMPT, /VS Code Extension、CLI\/Headless、ACP Agent Server 或 Standalone Desktop Host/);
  assert.doesNotMatch(SYSTEM_PROMPT, /嵌入在 VS Code/);
  assert.doesNotMatch(SYSTEM_PROMPT, /由 DeepSeek 驱动/);
});

test("VS Code 扩展兼容 id 保持 freeseek-copilot，但展示品牌收敛为 FreeSeek", () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));
  assert.equal(pkg.name, "freeseek-copilot");
  assert.match(pkg.displayName, /^FreeSeek/);
  assert.equal(pkg.contributes.configuration.title, "FreeSeek");
  assert.equal(pkg.contributes.views.freesek[0].contextualTitle, "FreeSeek");
});
