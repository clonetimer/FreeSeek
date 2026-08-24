import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

const ROOT = process.cwd();
const MODULE = path.join(ROOT, "scripts/lib/desktop-rc-promotion.mjs");
// 不能用动态 import(绝对路径)：esbuild(CJS) 保留真实 import()，Windows 下 ESM loader 拒绝 'e:' 协议；
// 直接 require 绝对路径（Node>=22.12 支持 require ESM）在 esbuild 与 tsc 两种布局下均可用。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const api = async (): Promise<any> => require(MODULE);
function fixture(version = "0.20.0-dev.3") {
  return {
    rootPackage: { version, name: "freeseek" },
    rootLock: { version, packages: { "": { version, name: "freeseek" } } },
    desktopPackage: { version, name: "freeseek-desktop" },
    projectState: { activeDevelopment: { version, status: "active", branch: "dev/0.20" }, stableBaseline: { version: "0.19.0" } },
  };
}

test("RC metadata promotion synchronizes pre-RC -> rc.1 without changing unrelated metadata", async () => {
  const { planRcMetadataPromotion } = await api();
  const input = fixture();
  const result = planRcMetadataPromotion({ ...input, targetVersion: "0.20.0-rc.1" });
  assert.equal(result.valid, true);
  assert.equal(result.documents.rootPackage.version, "0.20.0-rc.1");
  assert.equal(result.documents.rootLock.version, "0.20.0-rc.1");
  assert.equal(result.documents.rootLock.packages[""].version, "0.20.0-rc.1");
  assert.equal(result.documents.desktopPackage.version, "0.20.0-rc.1");
  assert.equal(result.documents.projectState.activeDevelopment.version, "0.20.0-rc.1");
  assert.equal(result.documents.projectState.stableBaseline.version, "0.19.0");
  assert.equal(input.rootPackage.version, "0.20.0-dev.3", "planner must be pure");
});


test("alpha/beta prereleases can promote directly to same-base rc.1", async () => {
  const { validateRcVersionTransition, planRcMetadataPromotion } = await api();
  assert.equal(validateRcVersionTransition("0.21.0-alpha.1", "0.21.0-rc.1").valid, true);
  assert.equal(validateRcVersionTransition("0.21.0-beta.1", "0.21.0-rc.1").valid, true);
  assert.equal(validateRcVersionTransition("0.21.0-beta.1", "0.21.0-rc.2").valid, false);
  const result = planRcMetadataPromotion({ ...fixture("0.21.0-beta.1"), targetVersion: "0.21.0-rc.1" });
  assert.equal(result.valid, true);
  assert.equal(result.documents.projectState.activeDevelopment.version, "0.21.0-rc.1");
});

test("RC metadata promotion rejects skipped first RC, base-version drift, and direct Stable promotion", async () => {
  const { validateRcVersionTransition } = await api();
  assert.equal(validateRcVersionTransition("0.20.0-dev.3", "0.20.0-rc.2").valid, false);
  assert.equal(validateRcVersionTransition("0.20.0-dev.3", "0.21.0-rc.1").valid, false);
  assert.equal(validateRcVersionTransition("0.20.0-dev.3", "0.20.0").valid, false);
});

test("published RC metadata can only advance to the immediately following RC serial", async () => {
  const { validateRcVersionTransition } = await api();
  assert.equal(validateRcVersionTransition("0.20.0-rc.1", "0.20.0-rc.2").valid, true);
  assert.equal(validateRcVersionTransition("0.20.0-rc.1", "0.20.0-rc.3").valid, false);
  assert.equal(validateRcVersionTransition("0.20.0-rc.2", "0.20.0-rc.2").valid, false);
});

test("RC preparation CLI is dry-run by default and cannot auto-commit/tag", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts/desktop-rc-prepare.mjs"), "utf8");
  assert.match(source, /apply:\s*false/);
  assert.match(source, /status["'],\s*["']--porcelain/);
  assert.match(source, /branch["'],\s*["']--show-current/);
  assert.match(source, /tag["'],\s*["']--list/);
  assert.doesNotMatch(source, /git\(\[\s*["']commit["']/);
  assert.doesNotMatch(source, /git\(\[\s*["']tag["']\s*,(?!\s*["']--list)/);
});
