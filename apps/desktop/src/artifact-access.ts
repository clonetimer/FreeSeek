import * as fs from "node:fs";
import * as path from "node:path";
import type { DesktopArtifactPreview } from "./contracts";

function realDirectory(directory: string): string {
  const resolved = fs.realpathSync(path.resolve(directory));
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`Not a directory: ${directory}`);
  return resolved;
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

/** Resolve an artifact path under the current ACP-authorized workspace roots. */
export function resolveDesktopArtifactPath(input: string, roots: readonly string[]): string {
  if (!input.trim()) throw new Error("Artifact path is required");
  const canonicalRoots = roots.map(realDirectory);
  const candidate = path.resolve(path.isAbsolute(input) ? input : path.join(canonicalRoots[0] ?? process.cwd(), input));
  const real = fs.realpathSync(candidate);
  if (!canonicalRoots.some((root) => inside(root, real))) throw new Error("Artifact path is outside the authorized Desktop workspace scope");
  if (!fs.statSync(real).isFile()) throw new Error("Artifact preview supports files only");
  return real;
}

/** Read a bounded text preview in the main process; renderer never receives fs access. */
export function previewDesktopArtifact(input: string, roots: readonly string[], maxBytes = 512 * 1024): DesktopArtifactPreview {
  const file = resolveDesktopArtifactPath(input, roots);
  const stat = fs.statSync(file);
  const readBytes = Math.min(stat.size, maxBytes);
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(readBytes);
  try { fs.readSync(fd, buffer, 0, readBytes, 0); } finally { fs.closeSync(fd); }
  const binary = buffer.includes(0);
  return {
    path: file,
    name: path.basename(file),
    size: stat.size,
    text: binary ? "Binary artifact preview is disabled." : buffer.toString("utf8"),
    truncated: stat.size > readBytes,
    binary,
  };
}
