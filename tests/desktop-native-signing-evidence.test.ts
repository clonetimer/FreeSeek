import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd();
const WINDOWS = path.join(ROOT, "scripts/desktop-windows-signing-evidence.mjs");
const MACOS = path.join(ROOT, "scripts/desktop-macos-signing-evidence.mjs");

test("native Desktop signing collectors expose explicit target contracts and cannot manufacture cross-platform RC evidence", () => {
  const winHelp = spawnSync(process.execPath, [WINDOWS, "--help"], { cwd: ROOT, encoding: "utf8" });
  const macHelp = spawnSync(process.execPath, [MACOS, "--help"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(winHelp.status, 0, winHelp.stderr); assert.match(winHelp.stdout, /--stage dir/); assert.match(winHelp.stdout, /signing-policy/);
  assert.equal(macHelp.status, 0, macHelp.stderr); assert.match(macHelp.stdout, /--stage dir/); assert.match(macHelp.stdout, /signing-policy/);
  if (process.platform !== "win32") {
    const result = spawnSync(process.execPath, [WINDOWS], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must be collected on native Windows/);
  }
  if (process.platform !== "darwin") {
    const result = spawnSync(process.execPath, [MACOS], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(result.status, 0); assert.match(result.stderr, /must be collected on native macOS/);
  }
});

test("native signing collectors use OS verifiers and bind signed executables back to portable-stage evidence", () => {
  const windows = fs.readFileSync(WINDOWS, "utf8"), macos = fs.readFileSync(MACOS, "utf8");
  const shared = fs.readFileSync(path.join(ROOT, "scripts/lib/desktop-native-signature-preflight.mjs"), "utf8");
  assert.match(windows, /verifyNativeStageSignature/); assert.match(windows, /signedExecutableSha256/);
  assert.match(macos, /verifyNativeStageSignature/); assert.match(macos, /signedExecutableSha256/);
  assert.match(shared, /Get-AuthenticodeSignature/); assert.match(shared, /SignerCertificate\.RawData/); assert.doesNotMatch(shared, /FREESEEK_POWERSHELL_BIN/);
  assert.match(shared, /\/usr\/bin\/codesign/); assert.match(shared, /stapler/); assert.match(shared, /\/usr\/sbin\/spctl/); assert.match(shared, /TeamIdentifier/);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.equal(pkg.scripts["desktop:signing:evidence:windows"], "node scripts/desktop-windows-signing-evidence.mjs");
  assert.equal(pkg.scripts["desktop:signing:evidence:macos"], "node scripts/desktop-macos-signing-evidence.mjs");
});
