/** Native stage signature/notarization preflight used before final portable artifact packaging. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { validatePortableStage } from "./desktop-portable-install.mjs";
import { hashNativeEvidenceFile } from "./desktop-native-signing-evidence.mjs";

function readPolicy(file, target) {
  const absolute = path.resolve(file), stat = fs.lstatSync(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Desktop signing policy must be a non-symlink regular file");
  const bytes = fs.readFileSync(absolute); let policy;
  try { policy = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Desktop signing policy must be valid JSON"); }
  if (policy?.schemaVersion !== 1 || policy.kind !== "freesek-desktop-signing-policy" || !Array.isArray(policy.targets)) throw new Error("Invalid Desktop signing policy");
  const rows = policy.targets.filter((row) => `${row?.platform}/${row?.arch}` === target);
  if (rows.length !== 1) throw new Error(`Desktop signing policy must contain exactly one ${target} target`);
  return { row: rows[0], sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function verifyWindows(executable, policy) {
  const powershell = String.raw`
$ErrorActionPreference = 'Stop'
$sig = Get-AuthenticodeSignature -LiteralPath $env:FREESEEK_AUTHENTICODE_FILE
if ($null -eq $sig.SignerCertificate) { throw 'SignerCertificate is missing' }
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $certSha = ([BitConverter]::ToString($sha.ComputeHash($sig.SignerCertificate.RawData))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
[ordered]@{ status = [string]$sig.Status; certificateSha256 = $certSha; subject = $sig.SignerCertificate.Subject; issuer = $sig.SignerCertificate.Issuer } | ConvertTo-Json -Compress
`;
  const result = spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershell], {
    encoding: "utf8", windowsHide: true, env: { ...process.env, FREESEEK_AUTHENTICODE_FILE: executable },
  });
  if (result.status !== 0) throw new Error(`Get-AuthenticodeSignature failed: ${String(result.stderr ?? result.stdout).trim()}`);
  let native; try { native = JSON.parse(String(result.stdout ?? "").trim()); } catch { throw new Error("Get-AuthenticodeSignature did not return valid JSON evidence"); }
  if (native.status !== "Valid") throw new Error(`Authenticode status is ${native.status || "unknown"}, expected Valid`);
  if (String(native.certificateSha256 ?? "").toLowerCase() !== String(policy.certificateSha256 ?? "").toLowerCase()) throw new Error("Authenticode signer is not authorized by Desktop signing policy");
  return { signatureKind: "authenticode", signatureVerified: true, signerIdentityMatched: true, certificateSha256: String(native.certificateSha256).toLowerCase(), certificateSubject: native.subject, certificateIssuer: native.issuer };
}

function runMac(bin, args, label) {
  const result = spawnSync(bin, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${label} failed: ${String(result.stderr ?? result.stdout).trim()}`);
  return `${String(result.stdout ?? "")}\n${String(result.stderr ?? "")}`;
}
function verifyMac(stageRoot, policy) {
  const app = path.join(stageRoot, "FreeSeek.app");
  runMac("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], "codesign verification");
  const details = runMac("/usr/bin/codesign", ["-d", "--verbose=4", app], "codesign identity inspection");
  const teamIdentifier = details.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim();
  if (!teamIdentifier) throw new Error("codesign did not report TeamIdentifier");
  if (teamIdentifier !== policy.teamIdentifier) throw new Error(`Apple TeamIdentifier ${teamIdentifier} is not authorized by Desktop signing policy`);
  runMac("/usr/bin/xcrun", ["stapler", "validate", app], "notarization staple validation");
  runMac("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app], "Gatekeeper assessment");
  if (policy.notarizationRequired !== true) throw new Error("Desktop signing policy must require macOS notarization");
  return { signatureKind: "apple-codesign", signatureVerified: true, signerIdentityMatched: true, teamIdentifier, notarized: true, gatekeeperAccepted: true, stapleValidated: true };
}

/** Verify target-native stage signing before packaging the final portable release artifact. */
export function verifyNativeStageSignature(input) {
  const platform = input.platform ?? process.platform, arch = input.arch ?? process.arch, target = `${platform}/${arch}`;
  if (platform !== process.platform) throw new Error(`Desktop native signing preflight for ${platform} must execute on native ${platform}`);
  const stage = validatePortableStage(path.resolve(input.stage), target);
  const policy = readPolicy(input.signingPolicy, target), executable = path.resolve(stage.root, String(stage.manifest.electronExecutable ?? ""));
  const rel = path.relative(stage.root, executable);
  if (!rel || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Portable stage executable path escapes stage root");
  const executableDigest = hashNativeEvidenceFile(executable);
  let native;
  if (platform === "win32") native = verifyWindows(executable, policy.row);
  else if (platform === "darwin") native = verifyMac(stage.root, policy.row);
  else {
    if (policy.row.signatureKind !== "ed25519-update-manifest" || !/^[a-f0-9]{64}$/i.test(String(policy.row.publicKeySha256 ?? ""))) throw new Error("Linux Desktop signing policy is invalid");
    native = { signatureKind: "ed25519-update-manifest", signatureVerified: false, signerIdentityMatched: false, updateManifestSigningDeferred: true, publicKeySha256: String(policy.row.publicKeySha256).toLowerCase() };
  }
  return { target, platform, arch, stageManifestSha256: stage.manifestSha256, executableSha256: executableDigest.sha256, signingPolicySha256: policy.sha256, ...native };
}
