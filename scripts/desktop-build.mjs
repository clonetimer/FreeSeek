#!/usr/bin/env node
/**
 * Build the Desktop development tree with TypeScript plus a sandbox-safe browser renderer bundle.
 * Production release bundling uses desktop-build-prod.mjs plus the native target workflow;
 * General HMR remains intentionally absent on the 0.21 UI convergence line.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, "apps/desktop/dist");
const ASSET_OUT = resolve(OUT, "apps/desktop/src");
const tsc = resolve(ROOT, "node_modules/typescript/bin/tsc");
const esbuild = resolve(ROOT, "node_modules/esbuild/bin/esbuild");

rmSync(OUT, { recursive: true, force: true });
const result = spawnSync(process.execPath, [tsc, "-p", "tsconfig.desktop.json"], { cwd: ROOT, stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);
mkdirSync(ASSET_OUT, { recursive: true });
copyFileSync(resolve(ROOT, "apps/desktop/src/index.html"), resolve(ASSET_OUT, "index.html"));
copyFileSync(resolve(ROOT, "apps/desktop/src/styles.css"), resolve(ASSET_OUT, "styles.css"));

// The renderer is sandboxed with nodeIntegration=false, so its module graph must be a browser bundle.
// TypeScript still checks/emits the full Desktop tree above; this step replaces only renderer.js with
// an IIFE that contains the renderer-safe presentation modules and no runtime require().
const rendererBundle = spawnSync(process.execPath, [
  esbuild,
  resolve(ROOT, "apps/desktop/src/renderer.ts"),
  "--bundle",
  "--platform=browser",
  "--format=iife",
  "--target=es2020",
  `--outfile=${resolve(ASSET_OUT, "renderer.js")}`,
  "--log-level=error",
], { cwd: ROOT, stdio: "inherit" });
if (rendererBundle.status !== 0) process.exit(rendererBundle.status ?? 1);

console.log(`desktop dev build complete: ${ASSET_OUT}`);
