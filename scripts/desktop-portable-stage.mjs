#!/usr/bin/env node
/** Stage an unpacked Electron runtime as a portable FreeSeek Desktop release candidate. */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    if (key === '--skip-build') { out.skipBuild = true; continue; }
    if (key === '--allow-electron-version-mismatch') { out.allowElectronVersionMismatch = true; continue; }
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${key}`);
    out[key.slice(2)] = value;
  }
  return out;
}

function copyTree(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true, preserveTimestamps: true });
}

function hashFile(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    const size = fs.fstatSync(fd).size;
    while (position < size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, size - position), position);
      if (count <= 0) throw new Error(`Unexpected EOF while hashing ${file}`);
      hash.update(buffer.subarray(0, count));
      position += count;
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function runProductionBuild() {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'scripts/desktop-build-prod.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function readElectronDistributionVersion(electronDist, platform) {
  const versionFile = path.join(electronDist, 'version');
  if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, 'utf8').trim().replace(/^v/, '');
  if (platform === 'darwin') {
    const plist = path.join(electronDist, 'Electron.app', 'Contents', 'Info.plist');
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, 'utf8');
      const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      if (match) return match[1].trim().replace(/^v/, '');
    }
  }
  throw new Error(`Unable to determine Electron distribution version: ${electronDist}`);
}

function productizeRuntime(stageRoot, platform) {
  if (platform === 'linux') {
    const source = path.join(stageRoot, 'electron');
    const executable = path.join(stageRoot, 'FreeSeek');
    if (fs.existsSync(source)) fs.renameSync(source, executable);
    return { resources: path.join(stageRoot, 'resources'), executable };
  }
  if (platform === 'win32') {
    const source = path.join(stageRoot, 'electron.exe');
    const executable = path.join(stageRoot, 'FreeSeek.exe');
    if (fs.existsSync(source)) fs.renameSync(source, executable);
    return { resources: path.join(stageRoot, 'resources'), executable };
  }
  if (platform === 'darwin') {
    const sourceApp = path.join(stageRoot, 'Electron.app');
    const appRoot = path.join(stageRoot, 'FreeSeek.app');
    if (fs.existsSync(sourceApp)) fs.renameSync(sourceApp, appRoot);
    const sourceExecutable = path.join(appRoot, 'Contents', 'MacOS', 'Electron');
    const executable = path.join(appRoot, 'Contents', 'MacOS', 'FreeSeek');
    if (fs.existsSync(sourceExecutable)) fs.renameSync(sourceExecutable, executable);
    const plist = path.join(appRoot, 'Contents', 'Info.plist');
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, 'utf8')
        .replace(/(<key>CFBundleExecutable<\/key>\s*<string>)Electron(<\/string>)/, '$1FreeSeek$2')
        .replace(/(<key>CFBundleName<\/key>\s*<string>)Electron(<\/string>)/, '$1FreeSeek$2')
        .replace(/(<key>CFBundleDisplayName<\/key>\s*<string>)Electron(<\/string>)/, '$1FreeSeek$2');
      fs.writeFileSync(plist, text, 'utf8');
    }
    return { resources: path.join(appRoot, 'Contents', 'Resources'), executable };
  }
  throw new Error(`Unsupported Desktop portable platform: ${platform}`);
}

const args = parseArgs(process.argv.slice(2));
const platform = args.platform || process.platform;
const arch = args.arch || process.arch;
if (!['linux', 'win32', 'darwin'].includes(platform)) throw new Error(`Unsupported platform: ${platform}`);
if (!['x64', 'arm64'].includes(arch)) throw new Error(`Unsupported architecture: ${arch}`);

const electronDist = path.resolve(args['electron-dist'] || process.env.FREESEEK_ELECTRON_DIST || '');
if (!electronDist || !fs.existsSync(electronDist)) throw new Error('Electron distribution is required via --electron-dist or FREESEEK_ELECTRON_DIST');
const desktopPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'apps', 'desktop', 'package.json'), 'utf8'));
const expectedElectronVersion = String(desktopPackage.devDependencies?.electron || '').trim();
const electronVersion = readElectronDistributionVersion(electronDist, platform);
const versionMatched = !!expectedElectronVersion && electronVersion === expectedElectronVersion;
const allowVersionMismatch = !!args.allowElectronVersionMismatch || process.env.FREESEEK_ALLOW_ELECTRON_VERSION_MISMATCH === '1';
if (!versionMatched && !allowVersionMismatch) {
  throw new Error(`Electron version mismatch: expected ${expectedElectronVersion || '<unset>'}, got ${electronVersion || '<unknown>'}`);
}
if (!versionMatched) console.error(`[desktop-stage] compatibility preflight only: Electron ${electronVersion}, RC pin ${expectedElectronVersion}`);
if (!args.skipBuild) runProductionBuild();

const rootPackage = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const version = args.version || rootPackage.version;
const desktopDist = path.resolve(args['desktop-dist'] || path.join(ROOT, 'apps/desktop/dist'));
const sidecar = path.resolve(args.sidecar || path.join(ROOT, 'dist/freeseek-acp.js'));
if (!fs.existsSync(desktopDist)) throw new Error(`Desktop dist missing: ${desktopDist}`);
if (!fs.existsSync(sidecar)) throw new Error(`ACP sidecar missing: ${sidecar}`);

const outRoot = path.resolve(args.out || path.join(ROOT, '.freesek', 'desktop-portable'));
const stageRoot = path.join(outRoot, `FreeSeek-${version}-${platform}-${arch}`);
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });
copyTree(electronDist, stageRoot);

const layout = productizeRuntime(stageRoot, platform);
if (!fs.existsSync(layout.executable)) throw new Error(`Electron executable missing from distribution: ${layout.executable}`);
fs.rmSync(path.join(layout.resources, 'default_app.asar'), { force: true });
const appRoot = path.join(layout.resources, 'app');
const sidecarRoot = path.join(layout.resources, 'freeseek', 'sidecar');
fs.rmSync(appRoot, { recursive: true, force: true });
fs.mkdirSync(appRoot, { recursive: true });
fs.mkdirSync(sidecarRoot, { recursive: true });
copyTree(desktopDist, path.join(appRoot, 'dist'));
fs.copyFileSync(sidecar, path.join(sidecarRoot, 'freeseek-acp.js'));
fs.chmodSync(path.join(sidecarRoot, 'freeseek-acp.js'), 0o755);
fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({
  name: '@freeseek/desktop-portable',
  productName: 'FreeSeek',
  version,
  private: true,
  main: 'dist/apps/desktop/src/main.js',
}, null, 2) + '\n', 'utf8');

const critical = [
  path.join(appRoot, 'package.json'),
  path.join(appRoot, 'dist/apps/desktop/src/main.js'),
  path.join(appRoot, 'dist/apps/desktop/src/preload.js'),
  path.join(appRoot, 'dist/apps/desktop/src/index.html'),
  path.join(sidecarRoot, 'freeseek-acp.js'),
];
for (const file of critical) if (!fs.existsSync(file)) throw new Error(`Portable critical file missing: ${file}`);
const embeddedManifestFile = path.join(layout.resources, 'freeseek', 'release-manifest.json');
const embeddedManifestPath = path.relative(stageRoot, embeddedManifestFile).replaceAll('\\', '/');
const manifest = {
  schemaVersion: 1,
  kind: 'freeseek-desktop-portable-stage',
  version,
  platform,
  arch,
  electronVersion,
  expectedElectronVersion,
  versionMatched,
  electronExecutable: path.relative(stageRoot, layout.executable).replaceAll('\\', '/'),
  embeddedManifestPath,
  files: critical.map((file) => ({
    path: path.relative(stageRoot, file).replaceAll('\\', '/'),
    size: fs.statSync(file).size,
    sha256: hashFile(file),
  })),
};
const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');
fs.mkdirSync(path.dirname(embeddedManifestFile), { recursive: true });
fs.writeFileSync(path.join(stageRoot, 'freesek-release-manifest.json'), manifestBytes);
fs.writeFileSync(embeddedManifestFile, manifestBytes);
console.log(JSON.stringify({ stageRoot, manifest }, null, 2));
