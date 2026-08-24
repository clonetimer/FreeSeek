#!/usr/bin/env node
/** Verify an official Electron release archive against SHASUMS256 without executing it. */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareElectronReleaseDistribution, verifyElectronReleaseArchive } from "./lib/desktop-electron-runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
function fail(message) { console.error(`✗ ${message}`); process.exit(1); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { console.log("Usage: node scripts/desktop-electron-runtime-verify.mjs --archive electron.zip --shasums SHASUMS256.txt --platform linux|win32|darwin --arch x64|arm64 [--extract dir] [--out evidence.json]"); process.exit(0); }
    if (!key.startsWith("--")) fail(`unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) fail(`missing value for ${key}`); out[key.slice(2)] = value;
  }
  for (const key of ["archive", "shasums", "platform", "arch"]) if (!out[key]) fail(`--${key} is required`);
  return out;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const desktop = JSON.parse(fs.readFileSync(path.join(ROOT, "apps", "desktop", "package.json"), "utf8"));
  const version = String(desktop.devDependencies?.electron ?? "");
  const input = { archive: args.archive, shasums: args.shasums, version, platform: args.platform, arch: args.arch };
  const verified = args.extract ? prepareElectronReleaseDistribution({ ...input, out: args.extract }) : verifyElectronReleaseArchive(input);
  const report = { schemaVersion: 1, kind: "freesek-electron-runtime-integrity-evidence", passed: true, electronVersion: version, platform: args.platform, arch: args.arch, assetName: verified.assetName, archive: verified.archive, archiveSha256: verified.archiveSha256, archiveSize: verified.archiveSize, shasums: verified.shasums, shasumsSha256: verified.shasumsSha256, ...(args.extract ? { extractedDistribution: verified.distribution, extractedExecutable: verified.executable } : {}) };
  const text = JSON.stringify(report, null, 2) + "\n";
  if (args.out) { const out = path.resolve(args.out); fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, text, "utf8"); }
  process.stdout.write(text);
} catch (error) { fail(error instanceof Error ? error.message : String(error)); }
