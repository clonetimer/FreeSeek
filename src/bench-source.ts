/** Immutable benchmark source materialization for local fixtures and pinned Git repositories. */
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";

export type BenchSource =
  | { kind: "local"; path: string }
  | { kind: "git"; url: string; commit: string; goldCommit?: string; subdir?: string };

export interface BenchSourceOptions {
  cacheDir?: string;
  offline?: boolean;
}

export interface MaterializedBenchSource {
  workspace: string;
  sourceKind: BenchSource["kind"];
  commit?: string;
  cleanup(): void;
}

const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function safeGitEnv(cacheDir: string): NodeJS.ProcessEnv {
  const keep = ["PATH", "PATHEXT", "SystemRoot", "ComSpec", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  const home = path.join(cacheDir, "git-home");
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  env.HOME = home;
  env.USERPROFILE = home;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = path.join(home, "empty-gitconfig");
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_ASKPASS = "";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function git(args: string[], cacheDir: string, cwd?: string, timeoutMs = 120_000): string {
  const result = spawnSync("git", args, {
    cwd,
    shell: false,
    windowsHide: true,
    encoding: "utf8",
    env: safeGitEnv(cacheDir),
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || `exit=${result.status}`).trim().slice(0, 1200);
    throw new Error(`git ${args[0] ?? "command"} 失败：${detail}`);
  }
  return String(result.stdout ?? "").trim();
}

function assertGitUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`benchmark git URL 非法：${raw}`); }
  if (!(["https:", "file:"] as string[]).includes(parsed.protocol)) {
    throw new Error(`benchmark git URL 仅允许 https:// 或 file://：${raw}`);
  }
  if (parsed.username || parsed.password) throw new Error("benchmark git URL 禁止内嵌凭据；请使用 Git credential helper");
  if (parsed.protocol === "https:" && !parsed.hostname) throw new Error(`benchmark git URL 缺少 host：${raw}`);
  return parsed.toString();
}

function assertCommit(commit: string, label = "commit"): string {
  if (!COMMIT_RE.test(commit)) throw new Error(`benchmark ${label} 必须是完整 immutable Git SHA：${commit}`);
  return commit.toLowerCase();
}

function safeSubdir(root: string, subdir: string | undefined): string {
  if (!subdir || subdir === ".") return fs.realpathSync(root);
  const target = path.resolve(root, subdir);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`benchmark git subdir 不存在：${subdir}`);
  const rootReal = fs.realpathSync(root);
  const real = fs.realpathSync(target);
  const rel = path.relative(rootReal, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`benchmark git subdir 越界：${subdir}`);
  return real;
}

function repoCachePath(cacheDir: string, url: string): string {
  const id = crypto.createHash("sha256").update(url).digest("hex");
  return path.join(cacheDir, "git", `${id}.git`);
}

function hasCommit(repo: string, commit: string, cacheDir: string): boolean {
  const result = spawnSync("git", ["--git-dir", repo, "cat-file", "-e", `${commit}^{commit}`], {
    shell: false, windowsHide: true, encoding: "utf8", env: safeGitEnv(cacheDir), timeout: 30_000,
  });
  return result.status === 0;
}

function ensureGitCache(source: Extract<BenchSource, { kind: "git" }>, options: BenchSourceOptions): { repo: string; url: string } {
  const cacheDir = path.resolve(options.cacheDir ?? path.join(os.homedir(), ".freesek", "bench-cache"));
  fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
  const url = assertGitUrl(source.url);
  const repo = repoCachePath(cacheDir, url);
  if (!fs.existsSync(repo)) {
    if (options.offline) throw new Error(`offline 模式下 benchmark source 尚未缓存：${url}`);
    fs.mkdirSync(path.dirname(repo), { recursive: true, mode: 0o700 });
    const temporary = `${repo}.tmp-${process.pid}-${Date.now()}`;
    try {
      git(["clone", "--bare", "--no-tags", "--", url, temporary], cacheDir);
      try { fs.renameSync(temporary, repo); }
      catch (error) { if (!fs.existsSync(repo)) throw error; }
    } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
  }
  if (fs.lstatSync(repo).isSymbolicLink() || !fs.statSync(repo).isDirectory()) throw new Error(`benchmark git cache 非法：${repo}`);
  if (git(["--git-dir", repo, "rev-parse", "--is-bare-repository"], cacheDir) !== "true") throw new Error(`benchmark git cache 不是 bare repository：${repo}`);
  const origin = assertGitUrl(git(["--git-dir", repo, "remote", "get-url", "origin"], cacheDir));
  if (origin !== url) throw new Error(`benchmark git cache origin 不匹配：${repo}`);
  return { repo, url };
}

function ensureCommit(repo: string, commit: string, cacheDir: string, offline: boolean): void {
  if (hasCommit(repo, commit, cacheDir)) return;
  if (offline) throw new Error(`offline 模式下缓存缺少 commit：${commit}`);
  git(["--git-dir", repo, "fetch", "--no-tags", "origin", commit], cacheDir);
  if (!hasCommit(repo, commit, cacheDir)) throw new Error(`远程仓库未提供固定 commit：${commit}`);
}

function materializeGit(source: Extract<BenchSource, { kind: "git" }>, options: BenchSourceOptions, requestedCommit?: string): MaterializedBenchSource {
  const cacheDir = path.resolve(options.cacheDir ?? path.join(os.homedir(), ".freesek", "bench-cache"));
  const commit = assertCommit(requestedCommit ?? source.commit, requestedCommit ? "goldCommit" : "commit");
  const { repo } = ensureGitCache(source, options);
  ensureCommit(repo, commit, cacheDir, options.offline === true);
  const resolved = git(["--git-dir", repo, "rev-parse", `${commit}^{commit}`], cacheDir).toLowerCase();
  if (resolved !== commit) throw new Error(`Git commit pin 校验失败：期望 ${commit}，实际 ${resolved}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "freesek-bench-source-"));
  try {
    git(["--git-dir", repo, `--work-tree=${root}`, "-c", "core.autocrlf=false", "checkout", "--force", commit, "--", "."], cacheDir);
    const workspace = safeSubdir(root, source.subdir);
    return { workspace, sourceKind: "git", commit, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

/** Validate a source declaration without fetching network content. */
export function validateBenchSource(source: BenchSource): void {
  if (source.kind === "local") {
    if (!source.path?.trim()) throw new Error("benchmark local source.path 不能为空");
    if (path.isAbsolute(source.path)) throw new Error("benchmark local source.path 必须是 manifest 相对路径");
    if (source.path.split(/[\\/]+/).includes("..")) throw new Error("benchmark local source.path 禁止 ..");
    return;
  }
  assertGitUrl(source.url);
  assertCommit(source.commit);
  if (source.goldCommit) assertCommit(source.goldCommit, "goldCommit");
  if (source.subdir && path.isAbsolute(source.subdir)) throw new Error("benchmark git subdir 必须是相对路径");
  if (source.subdir?.split(/[\\/]+/).includes("..")) throw new Error("benchmark git subdir 禁止 ..");
}

/** Materialize one immutable benchmark source. Call cleanup() when the caller no longer needs it. */
export function materializeBenchSource(
  source: BenchSource,
  manifestDir: string,
  options: BenchSourceOptions = {},
  requestedCommit?: string
): MaterializedBenchSource {
  validateBenchSource(source);
  if (source.kind === "git") return materializeGit(source, options, requestedCommit);
  const base = fs.realpathSync(manifestDir);
  const target = path.resolve(base, source.path);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Error(`benchmark local source 不存在：${source.path}`);
  const real = fs.realpathSync(target);
  const rel = path.relative(base, real);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error(`benchmark local source 越界：${source.path}`);
  return { workspace: real, sourceKind: "local", cleanup: () => {} };
}

/** Return a stable source identity suitable for report metadata without exposing local paths. */
export function benchSourceIdentity(source: BenchSource): { kind: "local" | "git"; commit?: string; repositoryHash?: string } {
  if (source.kind === "local") return { kind: "local" };
  const url = assertGitUrl(source.url);
  return {
    kind: "git",
    commit: assertCommit(source.commit),
    repositoryHash: crypto.createHash("sha256").update(url).digest("hex").slice(0, 16),
  };
}
