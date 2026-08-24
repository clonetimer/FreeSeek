import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const MODULE = path.join(ROOT, "scripts/lib/desktop-stable-metadata-promotion.mjs");
// 不能用动态 import(绝对路径)：esbuild(CJS) 保留真实 import()，Windows 下 ESM loader 拒绝 'e:' 协议；
// 直接 require 绝对路径（Node>=22.12 支持 require ESM）在 esbuild 与 tsc 两种布局下均可用。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = async (): Promise<any> => require(MODULE);
function fixture(version = "0.20.0-rc.1") {
  return {
    rootPackage: { version, name: "freeseek" },
    rootLock: { version, packages: { "": { version, name: "freeseek" } } },
    desktopPackage: { version, name: "freeseek-desktop" },
    projectState: {
      activeDevelopment: { version, status: "active", branch: "dev/0.20" },
      stableBaseline: { version: "0.19.0" },
    },
  };
}

test("Stable metadata promotion synchronizes rc.N -> same-base Stable without mutating the released baseline", async () => {
  const { planStableMetadataPromotion } = await api();
  const input = fixture();
  const result = planStableMetadataPromotion({ ...input, targetVersion: "0.20.0" });
  assert.equal(result.valid, true);
  assert.equal(result.documents.rootPackage.version, "0.20.0");
  assert.equal(result.documents.rootLock.version, "0.20.0");
  assert.equal(result.documents.rootLock.packages[""].version, "0.20.0");
  assert.equal(result.documents.desktopPackage.version, "0.20.0");
  assert.equal(result.documents.projectState.activeDevelopment.version, "0.20.0");
  assert.equal(result.documents.projectState.stableBaseline.version, "0.19.0");
  assert.equal(input.rootPackage.version, "0.20.0-rc.1", "planner must be pure");
});

test("Stable metadata promotion rejects non-RC sources, base drift and unsynchronized metadata", async () => {
  const { planStableMetadataPromotion, validateStableVersionTransition } = await api();
  assert.equal(validateStableVersionTransition("0.20.0-dev.3", "0.20.0").valid, false);
  assert.equal(validateStableVersionTransition("0.20.0-rc.1", "0.21.0").valid, false);
  assert.equal(validateStableVersionTransition("0.20.0-rc.1", "0.20.0-rc.2").valid, false);
  const input = fixture(); input.desktopPackage.version = "0.20.0-rc.2";
  assert.equal(planStableMetadataPromotion({ ...input, targetVersion: "0.20.0" }).valid, false);
});

test("Stable preparation CLI is dry-run by default and requires an audited immutable RC without auto-tagging", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/desktop-stable-prepare.mjs"), "utf8");
  assert.match(source, /apply:\s*false/);
  assert.match(source, /status["'],\s*["']--porcelain/);
  assert.match(source, /tag["'],\s*["']--list/);
  assert.match(source, /rev-list["'],\s*["']-n["'],\s*["']1/);
  assert.match(source, /rcEligible\s*!==\s*true/);
  assert.match(source, /preflightOnly\s*!==\s*false/);
  assert.doesNotMatch(source, /git\(\[\s*["']commit["']/);
  assert.doesNotMatch(source, /git\(\[\s*["']tag["']\s*,(?!\s*["']--list)/);
});
