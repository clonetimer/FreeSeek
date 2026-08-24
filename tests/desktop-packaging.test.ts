import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Desktop package and preload keep renderer privileges narrow", () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
  assert.equal(pkg.version, JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version);
  assert.equal(pkg.main, "dist/apps/desktop/src/main.js");
  assert.equal(pkg.devDependencies.electron, "43.3.0");

  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.ts"), "utf8");
  assert.match(main, /contextIsolation:\s*true/);
  assert.match(main, /nodeIntegration:\s*false/);
  assert.match(main, /sandbox:\s*true/);
  assert.doesNotMatch(main, /ToolRuntime|runAgent|executeToolBody/);

  const preload = fs.readFileSync(path.join(root, "apps/desktop/src/preload.ts"), "utf8");
  assert.match(preload, /contextBridge\.exposeInMainWorld\("freesekDesktop"/);
  assert.doesNotMatch(preload, /child_process|node:fs|ToolRuntime/);
});

test("Desktop keeps platform-neutral dev build separate from production bundle build", () => {
  const root = process.cwd();
  const dev = fs.readFileSync(path.resolve(root, "scripts/desktop-build.mjs"), "utf8");
  const prod = fs.readFileSync(path.resolve(root, "scripts/desktop-build-prod.mjs"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(dev, /tsconfig\.desktop\.json/);
  assert.doesNotMatch(dev, /from\s+["']esbuild["']/);
  assert.match(prod, /esbuild\.js/);
  assert.match(prod, /--production/);
  assert.match(prod, /--build-target=acp/);
  assert.match(prod, /dist\/freeseek-acp\.js/);
  const esbuildScript = fs.readFileSync(path.resolve(root, "esbuild.js"), "utf8");
  assert.match(esbuildScript, /FREESEEK_ESBUILD_BIN/);
  assert.match(esbuildScript, /native esbuild CLI fallback/);
  assert.equal(pkg.scripts["desktop:build:prod"], "node scripts/desktop-build-prod.mjs");
  assert.equal(pkg.scripts["desktop:stage:portable"], "node scripts/desktop-portable-stage.mjs");
});

test("Desktop portable staging embeds compiled app and ACP sidecar into Electron resources", () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-stage-"));
  try {
    const electron = path.join(temp, "electron-dist");
    const resources = path.join(electron, "resources");
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(electron, "electron"), "fake-electron");
    fs.chmodSync(path.join(electron, "electron"), 0o755);
    fs.writeFileSync(path.join(electron, "version"), "43.3.0\n");
    fs.writeFileSync(path.join(resources, "default_app.asar"), "remove-me");

    const desktopDist = path.join(temp, "desktop-dist");
    const desktopSrc = path.join(desktopDist, "apps/desktop/src");
    fs.mkdirSync(desktopSrc, { recursive: true });
    for (const name of ["main.js", "preload.js", "index.html"]) fs.writeFileSync(path.join(desktopSrc, name), name);
    const sidecar = path.join(temp, "freeseek-acp.js");
    fs.writeFileSync(sidecar, "#!/usr/bin/env node\nconsole.log('acp')\n");
    const out = path.join(temp, "out");
    const result = spawnSync(process.execPath, [
      path.join(root, "scripts/desktop-portable-stage.mjs"),
      "--skip-build", "--platform", "linux", "--arch", "x64", "--version", "0.20.0-rc.1",
      "--electron-dist", electron, "--desktop-dist", desktopDist, "--sidecar", sidecar, "--out", out,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const stage = path.join(out, "FreeSeek-0.20.0-rc.1-linux-x64");
    const app = path.join(stage, "resources/app");
    assert.equal(fs.existsSync(path.join(stage, "electron")), false);
    assert.equal(fs.existsSync(path.join(stage, "FreeSeek")), true);
    assert.equal(fs.existsSync(path.join(stage, "resources/default_app.asar")), false);
    assert.equal(fs.readFileSync(path.join(app, "package.json"), "utf8").includes('"productName": "FreeSeek"'), true);
    assert.equal(fs.readFileSync(path.join(stage, "resources/freeseek/sidecar/freeseek-acp.js"), "utf8").includes("acp"), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, "freesek-release-manifest.json"), "utf8"));
    assert.equal(manifest.kind, "freeseek-desktop-portable-stage");
    assert.equal(manifest.platform, "linux");
    assert.equal(manifest.electronExecutable, "FreeSeek");
    assert.equal(manifest.electronVersion, "43.3.0");
    assert.equal(manifest.expectedElectronVersion, "43.3.0");
    assert.equal(manifest.versionMatched, true);
    assert.equal(manifest.embeddedManifestPath, "resources/freeseek/release-manifest.json");
    assert.deepEqual(
      fs.readFileSync(path.join(stage, manifest.embeddedManifestPath)),
      fs.readFileSync(path.join(stage, "freesek-release-manifest.json")),
    );
    assert.equal(manifest.files.length, 5);
    assert.ok(manifest.files.every((row: any) => /^[a-f0-9]{64}$/.test(row.sha256)));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop portable staging rejects an Electron runtime that does not match the pinned RC version", () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-version-gate-"));
  try {
    const electron = path.join(temp, "electron-dist");
    fs.mkdirSync(path.join(electron, "resources"), { recursive: true });
    fs.writeFileSync(path.join(electron, "electron"), "fake-electron");
    fs.writeFileSync(path.join(electron, "version"), "43.2.0\n");
    const result = spawnSync(process.execPath, [
      path.join(root, "scripts/desktop-portable-stage.mjs"), "--skip-build",
      "--platform", "linux", "--arch", "x64", "--electron-dist", electron,
    ], { cwd: root, encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Electron version mismatch: expected 43\.3\.0, got 43\.2\.0/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop runtime paths are launch-layout independent and Electron smoke drives the public bridge", () => {
  const root = process.cwd();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "apps/desktop/package.json"), "utf8"));
  assert.equal(pkg.scripts.start, "electron .", "Desktop start must honor package.main instead of a stale dist/main.js path");

  const main = fs.readFileSync(path.join(root, "apps/desktop/src/main.ts"), "utf8");
  assert.match(main, /parsed\.name === "freeseek-copilot"/, "repo root must be discovered from package identity");
  assert.doesNotMatch(main, /path\.resolve\(__dirname, "\.\.\/\.\.\/\.\."\)/, "compiled output depth must not define repo root");

  const smoke = fs.readFileSync(path.join(root, "scripts/desktop-electron-smoke.mjs"), "utf8");
  assert.match(smoke, /FREESEEK_ELECTRON_BIN/);
  assert.match(smoke, /expectedElectronVersion/);
  assert.match(smoke, /Electron version mismatch/);
  assert.match(smoke, /FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH/);
  assert.match(smoke, /FREESEEK_DESKTOP_E2E_NO_SANDBOX/);
  assert.match(smoke, /FREESEEK_DESKTOP_PACKAGED_E2E/);
  assert.match(smoke, /appIsPackaged !== packagedMode/);
  assert.match(smoke, /FREESEEK_DESKTOP_E2E_CONFIG/);
  assert.match(smoke, /ELECTRON_DESKTOP_E2E_OK/);
  assert.match(smoke, /xvfb-run/);
  const e2e = fs.readFileSync(path.join(root, "apps/desktop/src/e2e.ts"), "utf8");
  assert.match(e2e, /window\.freesekDesktop/);
});

test("Desktop uses first-class ACP permission/elicitation dialogs instead of browser confirm/prompt", () => {
  const root = process.cwd();
  const renderer = fs.readFileSync(path.join(root, "apps/desktop/src/renderer.ts"), "utf8");
  const html = fs.readFileSync(path.join(root, "apps/desktop/src/index.html"), "utf8");
  assert.doesNotMatch(renderer, /window\.(confirm|prompt)\(/);
  assert.match(renderer, /showHostRequestDialog/);
  assert.match(renderer, /payload\?\.options/);
  assert.match(renderer, /requestedSchema/);
  for (const id of ["hostDialog", "hostDialogField", "hostDialogActions", "hostDialogCancel"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
});

test("Desktop portable staging productizes Windows layout without claiming launch evidence", () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-win-layout-"));
  try {
    const electron = path.join(temp, "electron-dist");
    fs.mkdirSync(path.join(electron, "resources"), { recursive: true });
    fs.writeFileSync(path.join(electron, "electron.exe"), "fake-windows-electron");
    fs.writeFileSync(path.join(electron, "version"), "43.3.0\n");
    fs.writeFileSync(path.join(electron, "resources/default_app.asar"), "remove-me");
    const desktopDist = path.join(temp, "desktop-dist");
    const desktopSrc = path.join(desktopDist, "apps/desktop/src");
    fs.mkdirSync(desktopSrc, { recursive: true });
    for (const name of ["main.js", "preload.js", "index.html"]) fs.writeFileSync(path.join(desktopSrc, name), name);
    const sidecar = path.join(temp, "freeseek-acp.js"); fs.writeFileSync(sidecar, "#!/usr/bin/env node\n");
    const out = path.join(temp, "out");
    const result = spawnSync(process.execPath, [
      path.join(root, "scripts/desktop-portable-stage.mjs"), "--skip-build",
      "--platform", "win32", "--arch", "x64", "--version", "0.20.0-rc.1",
      "--electron-dist", electron, "--desktop-dist", desktopDist, "--sidecar", sidecar, "--out", out,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stage = path.join(out, "FreeSeek-0.20.0-rc.1-win32-x64");
    assert.equal(fs.existsSync(path.join(stage, "electron.exe")), false);
    assert.equal(fs.existsSync(path.join(stage, "FreeSeek.exe")), true);
    assert.equal(fs.existsSync(path.join(stage, "resources/app/package.json")), true);
    assert.equal(fs.existsSync(path.join(stage, "resources/freeseek/sidecar/freeseek-acp.js")), true);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, "freesek-release-manifest.json"), "utf8"));
    assert.equal(manifest.platform, "win32");
    assert.equal(manifest.electronExecutable, "FreeSeek.exe");
    assert.equal(manifest.versionMatched, true);
    assert.equal(manifest.embeddedManifestPath, "resources/freeseek/release-manifest.json");
    assert.deepEqual(
      fs.readFileSync(path.join(stage, manifest.embeddedManifestPath)),
      fs.readFileSync(path.join(stage, "freesek-release-manifest.json")),
    );
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("Desktop portable staging productizes macOS bundle metadata without claiming launch evidence", () => {
  const root = process.cwd();
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "freeseek-portable-mac-layout-"));
  try {
    const electron = path.join(temp, "electron-dist");
    const contents = path.join(electron, "Electron.app/Contents");
    fs.mkdirSync(path.join(contents, "MacOS"), { recursive: true });
    fs.mkdirSync(path.join(contents, "Resources"), { recursive: true });
    fs.writeFileSync(path.join(contents, "MacOS/Electron"), "fake-macos-electron");
    fs.writeFileSync(path.join(contents, "Resources/default_app.asar"), "remove-me");
    fs.writeFileSync(path.join(contents, "Info.plist"), `<?xml version="1.0"?><plist><dict>
<key>CFBundleExecutable</key><string>Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleShortVersionString</key><string>43.3.0</string>
</dict></plist>`);
    const desktopDist = path.join(temp, "desktop-dist");
    const desktopSrc = path.join(desktopDist, "apps/desktop/src");
    fs.mkdirSync(desktopSrc, { recursive: true });
    for (const name of ["main.js", "preload.js", "index.html"]) fs.writeFileSync(path.join(desktopSrc, name), name);
    const sidecar = path.join(temp, "freeseek-acp.js"); fs.writeFileSync(sidecar, "#!/usr/bin/env node\n");
    const out = path.join(temp, "out");
    const result = spawnSync(process.execPath, [
      path.join(root, "scripts/desktop-portable-stage.mjs"), "--skip-build",
      "--platform", "darwin", "--arch", "arm64", "--version", "0.20.0-rc.1",
      "--electron-dist", electron, "--desktop-dist", desktopDist, "--sidecar", sidecar, "--out", out,
    ], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const stage = path.join(out, "FreeSeek-0.20.0-rc.1-darwin-arm64");
    const app = path.join(stage, "FreeSeek.app/Contents");
    assert.equal(fs.existsSync(path.join(stage, "Electron.app")), false);
    assert.equal(fs.existsSync(path.join(app, "MacOS/FreeSeek")), true);
    assert.equal(fs.existsSync(path.join(app, "Resources/app/package.json")), true);
    assert.equal(fs.existsSync(path.join(app, "Resources/freeseek/sidecar/freeseek-acp.js")), true);
    const plist = fs.readFileSync(path.join(app, "Info.plist"), "utf8");
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>FreeSeek<\/string>/);
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>FreeSeek<\/string>/);
    assert.match(plist, /<key>CFBundleDisplayName<\/key>\s*<string>FreeSeek<\/string>/);
    const manifest = JSON.parse(fs.readFileSync(path.join(stage, "freesek-release-manifest.json"), "utf8"));
    assert.equal(manifest.platform, "darwin");
    assert.equal(manifest.electronExecutable, "FreeSeek.app/Contents/MacOS/FreeSeek");
    assert.equal(manifest.electronVersion, "43.3.0");
    assert.equal(manifest.versionMatched, true);
    assert.equal(manifest.embeddedManifestPath, "FreeSeek.app/Contents/Resources/freeseek/release-manifest.json");
    assert.deepEqual(
      fs.readFileSync(path.join(stage, manifest.embeddedManifestPath)),
      fs.readFileSync(path.join(stage, "freesek-release-manifest.json")),
    );
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
