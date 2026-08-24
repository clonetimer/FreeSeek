import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = process.cwd();

test("release smoke treats ACP as a first-class production artifact", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "smoke.mjs"), "utf8");
  assert.match(source, /dist\/freeseek-acp\.js/);
  assert.match(source, /dist\/freeseek-acp\.js/);
  assert.match(source, /--built/);
});

test("release pipeline cannot bypass regression, conformance, or RC interop evidence", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "release.mjs"), "utf8");
  assert.match(source, /\["test"\]/);
  assert.match(source, /"acp:conformance"/);
  assert.match(source, /acp-interop-gate\.mjs/);
  assert.match(source, /requires two --interop-report files/);
  assert.match(source, /--expected-version/);
  assert.match(source, /--expected-commit/);
  assert.match(source, /rev-parse["']?,?\s*["']HEAD/);
  assert.match(source, /release worktree must be clean and committed/);
  assert.doesNotMatch(source, /pkg\.version\s*=/, "release script must not mutate only package.json version");
});


test("Node host bundles preserve builtin subpath imports for production packaging", () => {
  const esbuild = fs.readFileSync(path.join(ROOT, "esbuild.js"), "utf8");
  const headless = fs.readFileSync(path.join(ROOT, "src", "headless.ts"), "utf8");
  assert.match(esbuild, /NODE_HOST_EXTERNALS\s*=\s*\[[^\]]*"node:\*"/s);
  assert.match(headless, /from\s+["']node:readline\/promises["']/);
  assert.doesNotMatch(headless, /from\s+["']readline\/promises["']/);
});


test("release smoke validates stable artifact contracts instead of private minified symbols", () => {
  const source = fs.readFileSync(path.join(ROOT, "scripts", "smoke.mjs"), "utf8");
  assert.doesNotMatch(source, /encodeBuffer[^\n]*key marker|key marker[^\n]*encodeBuffer/i);
  assert.match(source, /pkg\.main/);
  assert.match(source, /pkg\.bin/);
  assert.match(source, /freesek\.openChat/);
  assert.match(source, /node --check/);
});
