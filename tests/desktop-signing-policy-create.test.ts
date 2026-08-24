import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const ROOT = process.cwd(), SCRIPT = path.join(ROOT, "scripts/desktop-signing-policy-create.mjs");

test("Desktop signing policy generator derives Linux SPKI identity and normalizes native signer IDs", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-signing-policy-"));
  try {
    const { publicKey } = crypto.generateKeyPairSync("ed25519"), publicFile = path.join(temp, "public.pem"), out = path.join(temp, "policy.json");
    fs.writeFileSync(publicFile, publicKey.export({ type: "spki", format: "pem" }));
    const cert = "ab".repeat(32).match(/.{2}/g)!.join(":");
    const result = spawnSync(process.execPath, [SCRIPT, "--policy-id", "freeseek-0.20", "--linux", `x64=${publicFile}`, "--windows", `x64=${cert}`, "--macos", "arm64=abcde12345", "--out", out], { cwd: ROOT, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const policy = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.deepEqual(policy.targets.map((row: any) => `${row.platform}/${row.arch}`), ["darwin/arm64", "linux/x64", "win32/x64"]);
    const linux = policy.targets.find((row: any) => row.platform === "linux"), der = publicKey.export({ type: "spki", format: "der" });
    assert.equal(linux.publicKeySha256, crypto.createHash("sha256").update(der).digest("hex"));
    assert.equal(policy.targets.find((row: any) => row.platform === "win32").certificateSha256, "ab".repeat(32));
    assert.equal(policy.targets.find((row: any) => row.platform === "darwin").teamIdentifier, "ABCDE12345");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop signing policy generator rejects duplicate targets and private/non-Ed25519 key material", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-signing-policy-bad-"));
  try {
    const { publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }), key = path.join(temp, "rsa.pem"); fs.writeFileSync(key, publicKey.export({ type: "spki", format: "pem" }));
    const badKey = spawnSync(process.execPath, [SCRIPT, "--policy-id", "bad", "--linux", `x64=${key}`, "--out", path.join(temp, "bad.json")], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(badKey.status, 0); assert.match(badKey.stderr, /must be Ed25519/);
    const dup = spawnSync(process.execPath, [SCRIPT, "--policy-id", "dup", "--windows", `x64=${"a".repeat(64)}`, "--windows", `x64=${"b".repeat(64)}`, "--out", path.join(temp, "dup.json")], { cwd: ROOT, encoding: "utf8" });
    assert.notEqual(dup.status, 0); assert.match(dup.stderr, /duplicate signing target/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
