/** Native portable artifact packaging/extraction for the 0.20 Desktop distribution channel. */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePortableStage } from "./desktop-portable-install.mjs";

function failCommand(result, label) {
  if (result.status === 0) return;
  const detail = String(result.stderr ?? result.stdout ?? "").trim();
  throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
}

/** Return the artifact format fixed for a Desktop platform. */
export function portableArtifactKind(platform) {
  if (platform === "linux") return "portable-tar-gzip-v1";
  if (platform === "win32" || platform === "darwin") return "portable-zip-v1";
  throw new Error(`Unsupported native portable artifact platform: ${platform}`);
}

/** Return the release filename suffix fixed for a Desktop platform. */
export function portableArtifactSuffix(platform) {
  return platform === "linux" ? ".tar.gz" : platform === "win32" || platform === "darwin" ? ".zip" : (() => { throw new Error(`Unsupported native portable artifact platform: ${platform}`); })();
}

/** Package an exact-Electron portable stage with the native platform archive tool. */
export function packageNativePortableStage(stageRoot, artifactFile, expectedPlatform = process.platform) {
  const stage = validatePortableStage(path.resolve(stageRoot));
  if (stage.manifest.platform !== expectedPlatform || process.platform !== expectedPlatform) {
    throw new Error(`Portable release artifact for ${stage.target} must be packaged on native ${stage.manifest.platform}`);
  }
  const out = path.resolve(artifactFile);
  if (!out.endsWith(portableArtifactSuffix(stage.manifest.platform))) throw new Error(`Portable ${stage.manifest.platform} artifact must end with ${portableArtifactSuffix(stage.manifest.platform)}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.rmSync(out, { force: true });
  if (stage.manifest.platform === "linux") {
    failCommand(spawnSync("tar", ["-czf", out, "-C", stage.root, "."], { encoding: "utf8" }), "tar packaging");
  } else if (stage.manifest.platform === "win32") {
    const ps = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:FREESEEK_STAGE_ROOT,$env:FREESEEK_ARTIFACT,[System.IO.Compression.CompressionLevel]::Optimal,$false)`;
    failCommand(spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, FREESEEK_STAGE_ROOT: stage.root, FREESEEK_ARTIFACT: out },
    }), "Windows zip packaging");
  } else {
    failCommand(spawnSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", stage.root, out], { encoding: "utf8" }), "macOS zip packaging");
  }
  const stat = fs.lstatSync(out);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw new Error("Native portable artifact was not produced as a regular non-empty file");
  return { artifact: out, stage, installerKind: portableArtifactKind(stage.manifest.platform) };
}

function findExtractedStageRoot(extractRoot) {
  const direct = path.join(extractRoot, "freesek-release-manifest.json");
  if (fs.existsSync(direct)) return extractRoot;
  const candidates = fs.readdirSync(extractRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(extractRoot, entry.name, "freesek-release-manifest.json")))
    .map((entry) => path.join(extractRoot, entry.name));
  if (candidates.length !== 1) throw new Error("Extracted portable artifact must contain exactly one FreeSeek stage root");
  return candidates[0];
}

/** Extract a native portable release artifact into an empty directory and validate the embedded stage. */
export function extractNativePortableArtifact(artifactFile, outDir, platform = process.platform, expectedTarget) {
  if (process.platform !== platform) throw new Error(`Portable installer evidence for ${platform} must execute on native ${platform}`);
  const artifact = path.resolve(artifactFile), out = path.resolve(outDir);
  const stat = fs.lstatSync(artifact);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Portable artifact must be a non-symlink regular file: ${artifact}`);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  if (platform === "linux") {
    if (!artifact.endsWith(".tar.gz")) throw new Error("Linux portable artifact must end with .tar.gz");
    failCommand(spawnSync("tar", ["-xzf", artifact, "-C", out, "--no-same-owner", "--no-same-permissions"], { encoding: "utf8" }), "tar extraction");
  } else if (platform === "win32") {
    if (!artifact.endsWith(".zip")) throw new Error("Windows portable artifact must end with .zip");
    const ps = String.raw`$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:FREESEEK_ARTIFACT,$env:FREESEEK_EXTRACT_ROOT)`;
    failCommand(spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, FREESEEK_ARTIFACT: artifact, FREESEEK_EXTRACT_ROOT: out },
    }), "Windows zip extraction");
  } else if (platform === "darwin") {
    if (!artifact.endsWith(".zip")) throw new Error("macOS portable artifact must end with .zip");
    failCommand(spawnSync("/usr/bin/ditto", ["-x", "-k", artifact, out], { encoding: "utf8" }), "macOS zip extraction");
  } else throw new Error(`Unsupported native portable artifact platform: ${platform}`);
  return validatePortableStage(findExtractedStageRoot(out), expectedTarget);
}
