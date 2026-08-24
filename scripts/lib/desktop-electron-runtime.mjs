/** Electron release archive verification/extraction helpers for Desktop native validation. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

const PLATFORMS = new Set(["linux", "win32", "darwin"]);
const ARCHES = new Set(["x64", "arm64"]);

function hashRegularFile(file) {
  const absolute = path.resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Electron release input must be a non-symlink regular file: ${absolute}`);
  const hash = crypto.createHash("sha256"), fd = fs.openSync(absolute, "r"), chunk = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, chunk, 0, Math.min(chunk.length, stat.size - offset), offset);
      if (read <= 0) throw new Error(`Unexpected EOF while hashing ${absolute}`);
      hash.update(chunk.subarray(0, read)); offset += read;
    }
  } finally { fs.closeSync(fd); }
  return { sha256: hash.digest("hex"), size: stat.size };
}

export function electronReleaseAssetName(version, platform, arch) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version))) throw new Error(`Invalid Electron version: ${version}`);
  if (!PLATFORMS.has(platform)) throw new Error(`Unsupported Electron platform: ${platform}`);
  if (!ARCHES.has(arch)) throw new Error(`Unsupported Electron architecture: ${arch}`);
  return `electron-v${version}-${platform}-${arch}.zip`;
}

/** Verify an Electron archive against the exact official SHASUMS256 entry selected by pin/target. */
export function verifyElectronReleaseArchive(input) {
  const archive = path.resolve(input.archive), shasums = path.resolve(input.shasums);
  const assetName = electronReleaseAssetName(input.version, input.platform, input.arch);
  const shasumsStat = fs.lstatSync(shasums);
  if (!shasumsStat.isFile() || shasumsStat.isSymbolicLink()) throw new Error(`Electron SHASUMS256 must be a non-symlink regular file: ${shasums}`);
  const shasumsBytes = fs.readFileSync(shasums);
  const matches = [];
  for (const line of shasumsBytes.toString("utf8").split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+\*?(.+?)\s*$/i);
    if (match && match[2] === assetName) matches.push(match[1].toLowerCase());
  }
  if (matches.length !== 1) throw new Error(`Electron SHASUMS256 must contain exactly one entry for ${assetName}`);
  const archiveDigest = hashRegularFile(archive);
  if (archiveDigest.sha256 !== matches[0]) throw new Error(`Electron archive SHA-256 mismatch for ${assetName}`);
  return {
    assetName,
    archive,
    archiveSha256: archiveDigest.sha256,
    archiveSize: archiveDigest.size,
    shasums,
    shasumsSha256: crypto.createHash("sha256").update(shasumsBytes).digest("hex"),
  };
}

export function electronDistributionExecutable(root, platform) {
  const dist = path.resolve(root);
  if (platform === "linux") return path.join(dist, "electron");
  if (platform === "win32") return path.join(dist, "electron.exe");
  if (platform === "darwin") return path.join(dist, "Electron.app", "Contents", "MacOS", "Electron");
  throw new Error(`Unsupported Electron platform: ${platform}`);
}

export function readElectronDistributionVersion(root, platform) {
  const dist = path.resolve(root), versionFile = path.join(dist, "version");
  if (fs.existsSync(versionFile)) return fs.readFileSync(versionFile, "utf8").trim().replace(/^v/, "");
  if (platform === "darwin") {
    const plist = path.join(dist, "Electron.app", "Contents", "Info.plist");
    if (fs.existsSync(plist)) {
      const text = fs.readFileSync(plist, "utf8");
      const match = text.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
      if (match) return match[1].trim().replace(/^v/, "");
    }
  }
  throw new Error(`Unable to determine Electron distribution version: ${dist}`);
}

function runExtraction(platform, archive, out) {
  let result;
  if (platform === "win32") {
    const script = "$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:FREESEEK_ELECTRON_ARCHIVE -DestinationPath $env:FREESEEK_ELECTRON_OUT -Force";
    result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, FREESEEK_ELECTRON_ARCHIVE: archive, FREESEEK_ELECTRON_OUT: out },
    });
  } else if (platform === "darwin") {
    result = spawnSync("/usr/bin/ditto", ["-x", "-k", archive, out], { encoding: "utf8" });
  } else {
    result = spawnSync("unzip", ["-q", archive, "-d", out], { encoding: "utf8" });
  }
  if (result.status !== 0) throw new Error(`Electron archive extraction failed: ${String(result.stderr ?? result.stdout).trim() || `exit=${result.status}`}`);
}

/** Verify and extract the exact Electron release archive on its target native OS. */
export function prepareElectronReleaseDistribution(input) {
  if (input.platform !== process.platform) throw new Error(`Electron runtime extraction for ${input.platform} must execute on native ${input.platform}`);
  const verified = verifyElectronReleaseArchive(input);
  const out = path.resolve(input.out);
  fs.rmSync(out, { recursive: true, force: true }); fs.mkdirSync(out, { recursive: true });
  runExtraction(input.platform, verified.archive, out);
  const actualVersion = readElectronDistributionVersion(out, input.platform);
  if (actualVersion !== input.version) throw new Error(`Extracted Electron version mismatch: expected ${input.version}, got ${actualVersion}`);
  const executable = electronDistributionExecutable(out, input.platform);
  const executableStat = fs.lstatSync(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error(`Extracted Electron executable is invalid: ${executable}`);
  return { ...verified, distribution: out, executable, electronVersion: actualVersion, platform: input.platform, arch: input.arch };
}
