#!/usr/bin/env node
/** Build the final native portable Desktop release artifact from a productized portable stage. */
import * as fs from "node:fs";
import * as path from "node:path";
import { portableArtifactSuffix, packageNativePortableStage } from "./lib/desktop-native-portable-artifact.mjs";

function usage() { console.log("Usage: node scripts/desktop-portable-artifact.mjs --stage dir [--out artifact.tar.gz|artifact.zip]"); }
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (key === "--help" || key === "-h") { usage(); process.exit(0); }
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++i]; if (!value) throw new Error(`Missing value for ${key}`); out[key.slice(2)] = value;
  }
  if (!out.stage) throw new Error("--stage is required");
  return out;
}
try {
  const args = parseArgs(process.argv.slice(2));
  const rootManifest = JSON.parse(fs.readFileSync(path.join(path.resolve(args.stage), "freesek-release-manifest.json"), "utf8"));
  const suffix = portableArtifactSuffix(String(rootManifest.platform));
  const artifact = path.resolve(args.out || path.join(path.dirname(path.resolve(args.stage)), `${path.basename(path.resolve(args.stage))}${suffix}`));
  const result = packageNativePortableStage(args.stage, artifact);
  process.stdout.write(JSON.stringify({ artifact: result.artifact, target: result.stage.target, version: result.stage.manifest.version, stageManifestSha256: result.stage.manifestSha256, installerKind: result.installerKind }, null, 2) + "\n");
} catch (error) { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1); }
