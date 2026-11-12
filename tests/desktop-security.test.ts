import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DesktopRecoveryStore } from "../apps/desktop/src/recovery-store";
import { DesktopProviderSecretStore, describeDesktopSafeStorage, desktopProviderIdentity, type DesktopSafeStorageAdapter } from "../apps/desktop/src/secure-store";
import { DesktopSettingsStore } from "../apps/desktop/src/settings-store";
import { previewDesktopArtifact, resolveDesktopArtifactPath } from "../apps/desktop/src/artifact-access";
import {
  compareDesktopSemver,
  readDesktopUpdateHighWater,
  selectDesktopUpdateArtifact,
  verifyDesktopUpdateArtifact,
  verifyDesktopUpdateCandidate,
  verifyDesktopUpdateManifest,
  verifyDesktopUpdateProvenance,
  writeDesktopUpdateHighWater,
  type DesktopUpdateManifest,
} from "../apps/desktop/src/update-verifier";
import { buildDesktopAcpArgs, buildDesktopAcpEnv } from "../src/hosts/desktop/acp-client";
import type { DesktopStartRequest } from "../apps/desktop/src/contracts";

function tempDir(): string { return fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-desktop-security-")); }

const UPDATE_PROVENANCE_REF = { url: "https://updates.example/freesek-desktop-provenance.json", sha256: "d".repeat(64), size: 456 };

const provider = {
  baseUrl: "https://provider.example/v1/",
  model: "model-1",
  format: "openai" as const,
  toolMode: "native" as const,
  authType: "bearer" as const,
};

class FakeSafeStorage implements DesktopSafeStorageAdapter {
  constructor(private readonly backend: string, private readonly available = true) {}
  isEncryptionAvailable(): boolean { return this.available; }
  getSelectedStorageBackend(): string { return this.backend; }
  encryptString(value: string): Buffer { return Buffer.from(`cipher:${value}`, "utf8"); }
  decryptString(value: Buffer): string { return value.toString("utf8").replace(/^cipher:/, ""); }
}

test("Desktop safeStorage evidence uses platform-native backend semantics", () => {
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("unused"), "win32"), { secure: true, backend: "dpapi" });
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("unused", false), "win32"), { secure: false, backend: "dpapi" });
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("unused"), "darwin"), { secure: true, backend: "keychain" });
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("gnome_libsecret"), "linux"), { secure: true, backend: "gnome_libsecret" });
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("basic_text"), "linux"), { secure: false, backend: "basic_text" });
  assert.deepEqual(describeDesktopSafeStorage(new FakeSafeStorage("unknown"), "linux"), { secure: false, backend: "unknown" });
});

test("Desktop provider credentials fail closed and are persisted only as ciphertext", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "provider-secret.json");
    const insecure = new DesktopProviderSecretStore(file, new FakeSafeStorage("basic_text", false));
    assert.equal(insecure.status().secure, false);
    assert.throws(() => insecure.save(provider, "secret-basic-text"), /unavailable/);
    assert.equal(fs.existsSync(file), false);

    const secure = new DesktopProviderSecretStore(file, new FakeSafeStorage("keychain"));
    secure.save(provider, "top-secret-value");
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /top-secret-value/);
    assert.match(raw, /ciphertext/);
    assert.equal(secure.load(provider), "top-secret-value");
    assert.equal(secure.load({ ...provider, model: "other-model" }), undefined);
    assert.equal(desktopProviderIdentity(provider), desktopProviderIdentity({ ...provider, baseUrl: "https://provider.example/v1" }));
    secure.forget(provider);
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop settings strip provider and MCP secrets before disk persistence", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "settings.json");
    const store = new DesktopSettingsStore(file);
    const request: DesktopStartRequest = {
      workspace: root,
      provider: { ...provider, apiKey: "provider-secret" },
      allowShell: false,
      allowNetwork: true,
      enableSkills: true,
      skillDirs: [],
      extensionDirs: [],
      enableMultiAgent: false,
      additionalDirectories: [],
      mcpServers: [{ name: "demo", command: "node", args: ["server.js"], env: [{ name: "TOKEN", value: "mcp-secret" }] }],
    };
    const saved = store.write(request);
    const raw = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(raw, /provider-secret|mcp-secret|TOKEN/);
    assert.equal("apiKey" in saved.provider, false);
    assert.deepEqual(saved.mcpServers, [{ name: "demo", command: "node", args: ["server.js"] }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop ACP launch keeps provider credentials out of argv and blocks inherited keys", () => {
  const options = {
    agentEntry: "/opt/freeseek/freeseek-acp.js",
    baseUrl: provider.baseUrl,
    apiKey: "argv-must-not-contain-this",
    model: provider.model,
    format: provider.format,
    toolMode: provider.toolMode,
    authType: provider.authType,
    sessionDir: "/tmp/freeseek-sessions",
  };
  const args = buildDesktopAcpArgs(options);
  assert.equal(args.includes("--api-key"), false);
  assert.doesNotMatch(args.join(" "), /argv-must-not-contain-this/);
  assert.equal(buildDesktopAcpEnv(options).FREESEEK_API_KEY, "argv-must-not-contain-this");

  const inherited = process.env.FREESEEK_API_KEY;
  process.env.FREESEEK_API_KEY = "stale-parent-key";
  try {
    const { apiKey: _ignored, ...withoutApiKey } = options;
    assert.equal(buildDesktopAcpEnv(withoutApiKey).FREESEEK_API_KEY, undefined);
    assert.equal(buildDesktopAcpEnv({ ...withoutApiKey, env: { FREESEEK_API_KEY: "spoofed-env-key" } }).FREESEEK_API_KEY, undefined);
    assert.equal(buildDesktopAcpEnv({ ...options, env: { FREESEEK_API_KEY: "spoofed-env-key" } }).FREESEEK_API_KEY, options.apiKey);
  } finally {
    if (inherited === undefined) delete process.env.FREESEEK_API_KEY;
    else process.env.FREESEEK_API_KEY = inherited;
  }
});

test("Desktop recovery journal accepts only recent absolute in-flight state", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "recovery.json");
    const store = new DesktopRecoveryStore(file);
    store.begin("session-1", root);
    assert.deepEqual(store.read()?.sessionId, "session-1");

    fs.writeFileSync(file, JSON.stringify({ sessionId: "session-1", workspace: "relative", updatedAt: new Date().toISOString(), inFlight: true }));
    assert.equal(store.read(), null);
    fs.writeFileSync(file, JSON.stringify({ sessionId: "session-1", workspace: root, updatedAt: "2000-01-01T00:00:00.000Z", inFlight: true }));
    assert.equal(store.read(1_000), null);
    fs.writeFileSync(file, "not-json");
    assert.equal(store.read(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop artifact access rejects paths and symlinks escaping authorized roots", (t) => {
  const root = tempDir();
  const outside = tempDir();
  try {
    const inside = path.join(root, "inside.txt");
    fs.writeFileSync(inside, "inside");
    assert.equal(resolveDesktopArtifactPath("inside.txt", [root]), fs.realpathSync(inside));
    assert.equal(previewDesktopArtifact(inside, [root]).text, "inside");

    const outsideFile = path.join(outside, "outside.txt");
    fs.writeFileSync(outsideFile, "outside");
    assert.throws(() => resolveDesktopArtifactPath(outsideFile, [root]), /outside/);
    const link = path.join(root, "escape.txt");
    try { fs.symlinkSync(outsideFile, link, "file"); }
    catch (error) { t.diagnostic(`symlink check skipped on this platform: ${String(error)}`); return; }
    assert.throws(() => resolveDesktopArtifactPath(link, [root]), /outside/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("Desktop signed update verification rejects tampering, rollback and equivocation", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const now = new Date("2026-08-20T12:00:00.000Z");
  const manifest: DesktopUpdateManifest = {
    schemaVersion: 2,
    channel: "beta",
    version: "0.20.0-beta.4",
    issuedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    provenance: UPDATE_PROVENANCE_REF,
    artifacts: [{ platform: "linux", arch: "x64", url: "https://updates.example/freeseek.zip", sha256: "a".repeat(64), size: 123 }],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, bytes, privateKey);
  const accepted = verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/manifest.json", currentVersion: "0.20.0-beta.3", now });
  assert.equal(accepted.manifest.version, manifest.version);
  assert.equal(accepted.idempotent, false);
  assert.equal(compareDesktopSemver("0.20.0", "0.20.0-rc.1"), 1);

  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "http://updates.example/manifest.json", currentVersion: "0.20.0-beta.3", now }), /HTTPS/);
  const tampered = Buffer.from(JSON.stringify({ ...manifest, version: "0.20.0-beta.5" }));
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: tampered, signature, publicKey, manifestUrl: "https://updates.example/manifest.json", currentVersion: "0.20.0-beta.3", now }), /signature/);
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/manifest.json", currentVersion: "0.20.0-beta.2", highWater: { version: "0.20.0-beta.5", issuedAt: manifest.issuedAt, manifestSha256: "b".repeat(64) }, now }), /rollback/);
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/manifest.json", currentVersion: "0.20.0-beta.3", highWater: { version: manifest.version, issuedAt: manifest.issuedAt, manifestSha256: "b".repeat(64) }, now }), /equivocation/);
});

test("Desktop update target selection is unique and channel-bound", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const manifest: DesktopUpdateManifest = {
    schemaVersion: 2,
    channel: "rc",
    version: "0.20.0-rc.2",
    issuedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    provenance: UPDATE_PROVENANCE_REF,
    artifacts: [
      { platform: "linux", arch: "x64", url: "https://updates.example/linux-x64.zip", sha256: "a".repeat(64), size: 1 },
      { platform: "darwin", arch: "arm64", url: "https://updates.example/darwin-arm64.zip", sha256: "b".repeat(64), size: 1 },
    ],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, bytes, privateKey);
  const accepted = verifyDesktopUpdateManifest({
    manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/m",
    currentVersion: "0.20.0-rc.1", expectedChannel: "rc", now: new Date("2026-08-20T12:00:00Z"),
  });
  assert.equal(selectDesktopUpdateArtifact(accepted.manifest, "linux", "x64").url, "https://updates.example/linux-x64.zip");
  assert.throws(() => selectDesktopUpdateArtifact(accepted.manifest, "win32", "x64"), /found 0/);
  assert.throws(() => verifyDesktopUpdateManifest({
    manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/m",
    currentVersion: "0.20.0-rc.1", expectedChannel: "stable", now: new Date("2026-08-20T12:00:00Z"),
  }), /channel mismatch/);

  const duplicate: DesktopUpdateManifest = { ...manifest, artifacts: [manifest.artifacts[0], { ...manifest.artifacts[0], url: "https://updates.example/linux-x64-2.zip" }] };
  const duplicateBytes = Buffer.from(JSON.stringify(duplicate));
  assert.throws(() => verifyDesktopUpdateManifest({
    manifestBytes: duplicateBytes, signature: crypto.sign(null, duplicateBytes, privateKey), publicKey,
    manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-rc.1", expectedChannel: "rc",
    now: new Date("2026-08-20T12:00:00Z"),
  }), /Duplicate update artifact target/);
});

test("Desktop signed update manifest cryptographically binds clean release provenance and artifact targets", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const artifacts = [
    { platform: "linux" as const, arch: "x64" as const, url: "https://updates.example/FreeSeek-linux-x64.tar.gz", sha256: "a".repeat(64), size: 111 },
    { platform: "darwin" as const, arch: "arm64" as const, url: "https://updates.example/FreeSeek-darwin-arm64.zip", sha256: "b".repeat(64), size: 222 },
  ];
  const makeProvenance = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: "freeseek-desktop-release-provenance",
    version: "0.20.0-rc.2",
    desktopVersion: "0.20.0-rc.2",
    electronVersionPin: "43.3.0",
    gitCommit: "1".repeat(40),
    gitTreeState: "clean",
    generatedAt: "2026-08-20T11:00:00.000Z",
    artifacts: [
      { platform: "linux", arch: "x64", name: "FreeSeek-linux-x64.tar.gz", electronVersion: "43.3.0", stageManifestSha256: "c".repeat(64), sha256: "a".repeat(64), size: 111 },
      { platform: "darwin", arch: "arm64", name: "FreeSeek-darwin-arm64.zip", electronVersion: "43.3.0", stageManifestSha256: "d".repeat(64), sha256: "b".repeat(64), size: 222 },
    ],
    ...overrides,
  }));
  const provenanceBytes = makeProvenance();
  const manifest: DesktopUpdateManifest = {
    schemaVersion: 2,
    channel: "rc",
    version: "0.20.0-rc.2",
    issuedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    provenance: {
      url: "https://updates.example/freesek-desktop-provenance.json",
      sha256: crypto.createHash("sha256").update(provenanceBytes).digest("hex"),
      size: provenanceBytes.length,
    },
    artifacts,
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const accepted = verifyDesktopUpdateManifest({
    manifestBytes,
    signature: crypto.sign(null, manifestBytes, privateKey),
    publicKey,
    manifestUrl: "https://updates.example/manifest.json",
    currentVersion: "0.20.0-rc.1",
    expectedChannel: "rc",
    now: new Date("2026-08-20T12:00:00Z"),
  });
  const provenance = verifyDesktopUpdateProvenance(provenanceBytes, accepted.manifest);
  assert.equal(provenance.gitTreeState, "clean");
  assert.deepEqual(provenance.artifacts.map((row) => `${row.platform}/${row.arch}`).sort(), ["darwin/arm64", "linux/x64"]);

  const tamperedBytes = Buffer.from(provenanceBytes);
  tamperedBytes[tamperedBytes.length - 2] ^= 1;
  assert.throws(() => verifyDesktopUpdateProvenance(tamperedBytes, accepted.manifest), /SHA-256 mismatch/);

  const dirtyBytes = makeProvenance({ gitTreeState: "dirty" });
  const dirtyManifest = { ...manifest, provenance: { ...manifest.provenance, sha256: crypto.createHash("sha256").update(dirtyBytes).digest("hex"), size: dirtyBytes.length } };
  assert.throws(() => verifyDesktopUpdateProvenance(dirtyBytes, dirtyManifest), /clean committed worktree/);

  const mismatchedBytes = makeProvenance({
    artifacts: [
      { platform: "linux", arch: "x64", name: "FreeSeek-linux-x64.tar.gz", electronVersion: "43.3.0", stageManifestSha256: "c".repeat(64), sha256: "f".repeat(64), size: 111 },
      { platform: "darwin", arch: "arm64", name: "FreeSeek-darwin-arm64.zip", electronVersion: "43.3.0", stageManifestSha256: "d".repeat(64), sha256: "b".repeat(64), size: 222 },
    ],
  });
  const mismatchedManifest = { ...manifest, provenance: { ...manifest.provenance, sha256: crypto.createHash("sha256").update(mismatchedBytes).digest("hex"), size: mismatchedBytes.length } };
  assert.throws(() => verifyDesktopUpdateProvenance(mismatchedBytes, mismatchedManifest), /digest\/size mismatch for linux\/x64/);
});

test("Desktop update manifest rejects missing or insecure release-provenance binding", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const base: DesktopUpdateManifest = {
    schemaVersion: 2,
    channel: "beta",
    version: "0.20.0-beta.4",
    issuedAt: "2026-08-20T11:00:00.000Z",
    expiresAt: "2026-08-27T11:00:00.000Z",
    provenance: UPDATE_PROVENANCE_REF,
    artifacts: [{ platform: "linux", arch: "x64", url: "https://updates.example/a", sha256: "a".repeat(64), size: 1 }],
  };
  const verify = (manifest: unknown) => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    return verifyDesktopUpdateManifest({ manifestBytes: bytes, signature: crypto.sign(null, bytes, privateKey), publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") });
  };
  const { provenance: _ignored, ...missing } = base;
  assert.throws(() => verify(missing), /Invalid update manifest schema/);
  assert.throws(() => verify({ ...base, provenance: { ...base.provenance, url: "http://updates.example/provenance.json" } }), /release provenance URL must use HTTPS/);
  assert.throws(() => verify({ ...base, provenance: { ...base.provenance, sha256: "bad" } }), /release provenance sha256/);
});

test("Desktop complete update candidate gate verifies manifest, provenance and artifact before high-water persistence", () => {
  const root = tempDir();
  try {
    const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
    const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
    const artifactFile = path.join(root, "FreeSeek-linux-x64.tar.gz");
    const artifactBytes = Buffer.from("candidate artifact bytes");
    fs.writeFileSync(artifactFile, artifactBytes);
    const artifactSha256 = crypto.createHash("sha256").update(artifactBytes).digest("hex");
    const provenanceBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1,
      kind: "freeseek-desktop-release-provenance",
      version: "0.20.0-rc.2",
      desktopVersion: "0.20.0-rc.2",
      electronVersionPin: "43.3.0",
      gitCommit: "1".repeat(40),
      gitTreeState: "clean",
      generatedAt: "2026-08-20T11:00:00.000Z",
      artifacts: [{ platform: "linux", arch: "x64", name: "FreeSeek-linux-x64.tar.gz", electronVersion: "43.3.0", stageManifestSha256: "c".repeat(64), sha256: artifactSha256, size: artifactBytes.length }],
    }));
    const manifest: DesktopUpdateManifest = {
      schemaVersion: 2,
      channel: "rc",
      version: "0.20.0-rc.2",
      issuedAt: "2026-08-20T11:00:00.000Z",
      expiresAt: "2026-08-27T11:00:00.000Z",
      provenance: { url: "https://updates.example/provenance.json", sha256: crypto.createHash("sha256").update(provenanceBytes).digest("hex"), size: provenanceBytes.length },
      artifacts: [{ platform: "linux", arch: "x64", url: "https://updates.example/FreeSeek-linux-x64.tar.gz", sha256: artifactSha256, size: artifactBytes.length }],
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    const verified = verifyDesktopUpdateCandidate({
      manifestBytes,
      signature: crypto.sign(null, manifestBytes, privateKey),
      publicKey,
      manifestUrl: "https://updates.example/update-rc.json",
      provenanceBytes,
      artifactFile,
      platform: "linux",
      arch: "x64",
      currentVersion: "0.20.0-rc.1",
      expectedChannel: "rc",
      now: new Date("2026-08-20T12:00:00Z"),
    });
    assert.equal(verified.artifact.sha256, artifactSha256);
    assert.equal(verified.provenance.gitCommit, "1".repeat(40));
    assert.equal(verified.highWater.version, "0.20.0-rc.2");

    fs.writeFileSync(artifactFile, "tampered");
    assert.throws(() => verifyDesktopUpdateCandidate({
      manifestBytes,
      signature: crypto.sign(null, manifestBytes, privateKey),
      publicKey,
      manifestUrl: "https://updates.example/update-rc.json",
      provenanceBytes,
      artifactFile,
      platform: "linux",
      arch: "x64",
      currentVersion: "0.20.0-rc.1",
      expectedChannel: "rc",
      now: new Date("2026-08-20T12:00:00Z"),
    }), /size mismatch|SHA-256 mismatch/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop update artifact and high-water state are verified before use", () => {
  const root = tempDir();
  try {
    const artifactFile = path.join(root, "artifact.bin");
    const data = Buffer.from("signed release artifact");
    fs.writeFileSync(artifactFile, data);
    const artifact = {
      platform: "linux" as const,
      arch: "x64" as const,
      url: "https://updates.example/artifact.bin",
      size: data.length,
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
    };
    assert.doesNotThrow(() => verifyDesktopUpdateArtifact(artifactFile, artifact));
    const largeFile = path.join(root, "large-artifact.bin");
    const largeData = Buffer.alloc(2 * 1024 * 1024 + 17, 7);
    fs.writeFileSync(largeFile, largeData);
    assert.doesNotThrow(() => verifyDesktopUpdateArtifact(largeFile, {
      ...artifact,
      size: largeData.length,
      sha256: crypto.createHash("sha256").update(largeData).digest("hex"),
    }));
    assert.throws(() => verifyDesktopUpdateArtifact(artifactFile, { ...artifact, size: data.length + 1 }), /size mismatch/);
    assert.throws(() => verifyDesktopUpdateArtifact(artifactFile, { ...artifact, sha256: "0".repeat(64) }), /SHA-256 mismatch/);

    const highWaterFile = path.join(root, "update-high-water.json");
    const highWater = { version: "0.20.0-beta.4", issuedAt: "2026-08-20T11:00:00.000Z", manifestSha256: "c".repeat(64) };
    writeDesktopUpdateHighWater(highWaterFile, highWater);
    assert.deepEqual(readDesktopUpdateHighWater(highWaterFile), highWater);
    fs.writeFileSync(highWaterFile, "{}", "utf8");
    assert.equal(readDesktopUpdateHighWater(highWaterFile), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop BrowserWindow and CSP keep the renderer local and privilege-minimal", () => {
  const root = process.cwd();
  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.ts"), "utf8");
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/src/renderer.ts"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/src/index.html"), "utf8");
  assert.match(main, /event\?\.sender !== contents/);
  assert.match(main, /contents\.getURL\?\.\(\) !== desktopEntryUrl/);
  assert.match(main, /if \(url !== desktopEntryUrl\) event\.preventDefault\(\)/);
  assert.match(main, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(main, /webviewTag:\s*false/);
  assert.match(main, /devTools:\s*!app\.isPackaged/);
  assert.match(renderer, /function consumeRequestFromForm\(\): DesktopStartRequest \{[\s\S]*finally \{ apiKey\.value = ""; \}/);
  assert.match(renderer, /api\.start\(consumeRequestFromForm\(\)\)/);
  assert.match(renderer, /api\.loadHistory\(consumeRequestFromForm\(\)\)/);
  assert.match(renderer, /api\.load\(consumeRequestFromForm\(\), selected\)/);
  assert.match(renderer, /recoverInterruptedTurn\("recover", consumeRequestFromForm\(\)\)/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /object-src 'none'/);
  assert.match(html, /frame-ancestors 'none'/);
  assert.doesNotMatch(html, /'unsafe-inline'|'unsafe-eval'/);
});

test("Desktop settings fail closed to sanitized defaults on corrupt persisted JSON", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(file, "{not-json", "utf8");
    const value = new DesktopSettingsStore(file).read();
    assert.equal(value.provider.authType, "none");
    assert.equal(value.allowShell, false);
    assert.equal(value.enableSkills, true);
    assert.deepEqual(value.mcpServers, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop settings discard malformed enums, empty roots and secret-bearing MCP fields", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "settings.json");
    fs.writeFileSync(file, JSON.stringify({
      workspace: root,
      provider: { baseUrl: "https://x", model: "m", format: "invalid", toolMode: "invalid", authType: "invalid", apiKey: "leak" },
      skillDirs: ["", "  ", "/tmp/skill"],
      extensionDirs: ["", "  ", "/tmp/extensions"],
      additionalDirectories: ["", "/tmp/extra"],
      mcpServers: [{ name: "demo", command: "node", args: ["", "a"], env: [{ name: "TOKEN", value: "secret" }] }, { name: "", command: "bad" }],
    }), "utf8");
    const value = new DesktopSettingsStore(file).read();
    assert.equal(value.provider.format, "openai");
    assert.equal(value.provider.toolMode, "native");
    assert.equal(value.provider.authType, "none");
    assert.deepEqual(value.skillDirs, ["/tmp/skill"]);
    assert.deepEqual(value.extensionDirs, ["/tmp/extensions"]);
    assert.deepEqual(value.additionalDirectories, ["/tmp/extra"]);
    assert.deepEqual(value.mcpServers, [{ name: "demo", command: "node", args: ["a"] }]);
    assert.equal(JSON.stringify(value).includes("secret"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop sidecar resolver uses repo dist in development and honors explicit test overrides", async () => {
  const { resolveDesktopSidecarLaunch } = await import("../apps/desktop/src/sidecar-launch");
  const value = resolveDesktopSidecarLaunch({
    isPackaged: false,
    processExecPath: "/electron/electron",
    repoRoot: "/repo",
    overrideEntry: "/tmp/custom-acp.js",
    overrideNode: "/usr/bin/node-custom",
  });
  assert.equal(value.agentEntry, path.resolve("/tmp/custom-acp.js"));
  assert.equal(value.nodeCommand, "/usr/bin/node-custom");
  assert.deepEqual(value.env, {});
});

test("Desktop packaged sidecar uses Electron-as-Node and never depends on system Node", async () => {
  const { resolveDesktopSidecarLaunch } = await import("../apps/desktop/src/sidecar-launch");
  const value = resolveDesktopSidecarLaunch({
    isPackaged: true,
    resourcesPath: "/opt/FreeSeek/resources",
    processExecPath: "/opt/FreeSeek/FreeSeek",
    repoRoot: "/unused",
    overrideNode: "/usr/bin/node-must-be-ignored",
  });
  assert.equal(value.agentEntry, path.resolve("/opt/FreeSeek/resources/freeseek/sidecar/freeseek-acp.js"));
  assert.equal(value.nodeCommand, "/opt/FreeSeek/FreeSeek");
  assert.equal(value.env.ELECTRON_RUN_AS_NODE, "1");
});

test("Desktop secret store ignores malformed or mismatched envelopes without decrypting", () => {
  const root = tempDir();
  try {
    const file = path.join(root, "provider-secret.json");
    const secure = new DesktopProviderSecretStore(file, new FakeSafeStorage("keychain"));
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, providerHash: "bad", ciphertext: "xxx" }));
    assert.equal(secure.has(provider), false);
    assert.equal(secure.load(provider), undefined);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, providerHash: "f".repeat(64), ciphertext: "xxx" }));
    assert.equal(secure.load(provider), undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop recovery clear removes an interrupted-turn marker idempotently", () => {
  const root = tempDir();
  try {
    const store = new DesktopRecoveryStore(path.join(root, "recovery.json"));
    store.begin("session-2", root);
    assert.ok(store.read());
    store.clear();
    store.clear();
    assert.equal(store.read(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop artifact preview is bounded and reports truncation", () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, "large.txt"), "abcdefghij", "utf8");
    const preview = previewDesktopArtifact("large.txt", [root], 4);
    assert.equal(preview.text, "abcd");
    assert.equal(preview.truncated, true);
    assert.equal(preview.size, 10);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop artifact preview does not decode NUL-containing binary content as text", () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, "binary.bin"), Buffer.from([1, 0, 2, 3]));
    const preview = previewDesktopArtifact("binary.bin", [root]);
    assert.equal(preview.binary, true);
    assert.match(preview.text, /Binary artifact preview is disabled/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Desktop SemVer comparison follows prerelease numeric and release precedence", () => {
  assert.equal(compareDesktopSemver("0.20.0-beta.2", "0.20.0-beta.10"), -1);
  assert.equal(compareDesktopSemver("0.20.0-beta.10", "0.20.0-rc.1"), -1);
  assert.equal(compareDesktopSemver("0.20.0-rc.1", "0.20.0"), -1);
  assert.equal(compareDesktopSemver("0.20.0", "0.20.0"), 0);
  assert.throws(() => compareDesktopSemver("v0.20", "0.20.0"), /Invalid semantic version/);
});

test("Desktop update manifest rejects expired and future-issued signed metadata", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const base: DesktopUpdateManifest = {
    schemaVersion: 2, channel: "beta", version: "0.20.0-beta.4",
    issuedAt: "2026-08-20T10:00:00.000Z", expiresAt: "2026-08-20T11:00:00.000Z",
    provenance: UPDATE_PROVENANCE_REF,
    artifacts: [{ platform: "linux", arch: "x64", url: "https://updates.example/a", sha256: "a".repeat(64), size: 1 }],
  };
  const expiredBytes = Buffer.from(JSON.stringify(base));
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: expiredBytes, signature: crypto.sign(null, expiredBytes, privateKey), publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") }), /expired/);
  const future = { ...base, issuedAt: "2026-08-20T13:00:00.000Z", expiresAt: "2026-08-21T13:00:00.000Z" };
  const futureBytes = Buffer.from(JSON.stringify(future));
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: futureBytes, signature: crypto.sign(null, futureBytes, privateKey), publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") }), /future/);
});

test("Desktop update manifest rejects insecure artifact URLs and malformed digests", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const make = (artifact: any) => Buffer.from(JSON.stringify({
    schemaVersion: 2, channel: "beta", version: "0.20.0-beta.4",
    issuedAt: "2026-08-20T11:00:00.000Z", expiresAt: "2026-08-27T11:00:00.000Z", provenance: UPDATE_PROVENANCE_REF, artifacts: [artifact],
  }));
  const insecure = make({ platform: "linux", arch: "x64", url: "http://updates.example/a", sha256: "a".repeat(64), size: 1 });
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: insecure, signature: crypto.sign(null, insecure, privateKey), publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") }), /HTTPS/);
  const badDigest = make({ platform: "linux", arch: "x64", url: "https://updates.example/a", sha256: "xyz", size: 1 });
  assert.throws(() => verifyDesktopUpdateManifest({ manifestBytes: badDigest, signature: crypto.sign(null, badDigest, privateKey), publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") }), /SHA-256/);
});

test("Desktop update verification accepts byte-identical high-water replay idempotently", () => {
  const { publicKey: publicKeyObject, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicKey = publicKeyObject.export({ type: "spki", format: "pem" }).toString();
  const manifest: DesktopUpdateManifest = {
    schemaVersion: 2, channel: "beta", version: "0.20.0-beta.4",
    issuedAt: "2026-08-20T11:00:00.000Z", expiresAt: "2026-08-27T11:00:00.000Z",
    provenance: UPDATE_PROVENANCE_REF,
    artifacts: [{ platform: "linux", arch: "x64", url: "https://updates.example/a", sha256: "a".repeat(64), size: 1 }],
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const signature = crypto.sign(null, bytes, privateKey);
  const first = verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", now: new Date("2026-08-20T12:00:00Z") });
  const second = verifyDesktopUpdateManifest({ manifestBytes: bytes, signature, publicKey, manifestUrl: "https://updates.example/m", currentVersion: "0.20.0-beta.3", highWater: first.highWater, now: new Date("2026-08-20T12:00:00Z") });
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.highWater, first.highWater);
});

test("ACP history presentation maps reasoning, tool cards and results without re-executing tools", async () => {
  const { replayAcpHistory } = await import("../src/hosts/acp/presentation");
  const updates: any[] = [];
  replayAcpHistory("session-1", [
    { role: "user", content: "inspect" },
    { role: "assistant", content: "working", reasoning_content: "reason", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] },
    { role: "tool", content: "file text", tool_call_id: "call-1" },
  ] as any, "plan", (_sessionId, update) => updates.push(update));
  assert.ok(updates.some((row) => row.sessionUpdate === "agent_thought_chunk" && row.content.text === "reason"));
  assert.ok(updates.some((row) => row.sessionUpdate === "tool_call" && row.kind === "read" && row.rawInput.path === "a.txt"));
  assert.ok(updates.some((row) => row.sessionUpdate === "tool_call_update" && row.status === "completed"));
  assert.deepEqual(updates.at(-1), { sessionUpdate: "current_mode_update", currentModeId: "plan" });
});
