import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawnSync } from "child_process";
import {
  installKit,
  uninstallKit,
  listInstalledKits,
  type KitInstallResult,
  type KitRecord,
} from "./kits";

/**
 * 远程插件下载器——对标 DSH 的 `dsh plugin --profile web add <spec>`（pnpm 转发器）。
 *
 * spec 语法（对齐 dsh plugin add 的 npm 包习惯）：
 *   freeseek plugin add @scope/pkg@version   → npm registry（裸 spec 默认按 npm 包处理）
 *   freeseek plugin add npm:@scope/pkg@ver   → 显式 npm registry
 *   freeseek plugin add git:https://.../x.git → git clone（含 github 短路径）
 *   freeseek plugin add file:./dir 或 /abs/dir → 本地目录（复用 kits.ts 原 installKit 路径）
 *
 * 下载/解包后走 kits.ts 的 installKit 落地项目 .agent/（技能/命令/子代理角色/主题），
 * 并登记 .agent/kits.json 注册表；卸载由 uninstallKit 依据注册表逆操作，构成可逆闭环。
 */

export type PluginSource = "npm" | "git" | "file";

export interface PluginSpec {
  source: PluginSource;
  /** 传给下载器的原始目标（已去除协议前缀）。 */
  raw: string;
  /** 用户输入的完整 spec（用于报错与回显）。 */
  label: string;
}

export function parsePluginSpec(spec: string): PluginSpec {
  const s = spec.trim();
  if (!s) throw new Error("空插件 spec");
  if (s.startsWith("npm:")) return { source: "npm", raw: s.slice(4).trim() || s, label: s };
  if (s.startsWith("git:")) return { source: "git", raw: s.slice(4).trim() || s, label: s };
  if (s.startsWith("file:")) {
    const raw = s.slice(5).trim() || s;
    return { source: "file", raw, label: s };
  }
  // 裸 spec：带本地路径特征（./、/、\、盘符 C:\、或路径已存在）→ file；否则按 npm 包处理。
  const looksLocal =
    s.startsWith(".") || s.startsWith("/") || s.startsWith("\\") || /^[a-zA-Z]:[\\/]/.test(s) || fs.existsSync(s);
  if (looksLocal) return { source: "file", raw: s, label: s };
  return { source: "npm", raw: s, label: s };
}

interface ToolResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function runTool(tool: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): ToolResult {
  const win = process.platform === "win32";
  const timeout = opts.timeoutMs ?? 180_000;
  try {
    let r: ReturnType<typeof spawnSync>;
    if (win && tool === "npm") {
      // Windows 下 npm 是 cmd 批处理（npm.cmd），spawnSync 无法直接执行 .cmd；
      // 用 cmd.exe /c 转发（参数均为简单 token，windowsVerbatimArguments 原样传递，无注入风险）。
      r = spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
        encoding: "utf8",
        cwd: opts.cwd,
        timeout,
        env: process.env,
        windowsVerbatimArguments: true,
      });
    } else {
      r = spawnSync(tool, args, {
        encoding: "utf8",
        cwd: opts.cwd,
        timeout,
        env: process.env,
      });
    }
    return { ok: r.status === 0, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), status: r.status };
  } catch (error: any) {
    return { ok: false, stdout: "", stderr: `${error?.message ?? error}`, status: null };
  }
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 在 npm/git 包根定位套件目录：根有 plugin.json，或 package.json 声明 freesek.plugin（DSH dsh.bundle 类比）。 */
function locateKitDir(pkgDir: string): string | null {
  if (fs.existsSync(path.join(pkgDir, "plugin.json"))) return pkgDir;
  const pj = path.join(pkgDir, "package.json");
  if (fs.existsSync(pj)) {
    try {
      const d = JSON.parse(fs.readFileSync(pj, "utf8"));
      const plug = d?.freesek?.plugin;
      if (typeof plug === "string" && plug.trim()) {
        const sub = path.resolve(pkgDir, plug.trim());
        if (fs.existsSync(path.join(sub, "plugin.json"))) return sub;
      } else if (plug && typeof plug === "object") {
        const dir = String(plug.dir ?? plug.path ?? "").trim();
        if (dir) {
          const sub = path.resolve(pkgDir, dir);
          if (fs.existsSync(path.join(sub, "plugin.json"))) return sub;
        }
      }
    } catch {
      // 清单损坏视为未命中，由调用方报错
    }
  }
  return null;
}

function fetchNpmPlugin(raw: string): { kitDir: string; cleanup: () => void } {
  const tmp = makeTempDir("freesek-plugin-npm-");
  const cleanup = (): void => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 清理失败可忽略
    }
  };
  try {
    // 用临时目录内的专用缓存：绕开用户全局 npm 缓存目录的写权限问题，用完随 cleanup 一起删除。
    const pack = runTool("npm", ["pack", raw, "--pack-destination", tmp, "--cache", path.join(tmp, "npm-cache"), "--json"]);
    if (!pack.ok) {
      const detail = (pack.stderr || pack.stdout).trim().slice(0, 400) || `npm 退出码 ${pack.status}（npm 不可用或无网络访问）`;
      throw new Error(`npm pack 失败：${detail}`);
    }
    let filename = "";
    try {
      const d = JSON.parse(pack.stdout);
      const entry = Array.isArray(d) ? d[0] : d;
      filename = String(entry?.filename ?? "");
    } catch {
      // JSON 解析失败 → 兜底正则抓取
    }
    if (!filename) {
      const m = /([^\s"']+\.tgz)/.exec(pack.stdout + "\n" + pack.stderr);
      filename = m ? m[1].trim() : "";
    }
    if (!filename) throw new Error("npm pack 未返回 tarball 文件名");
    const extract = path.join(tmp, "extract");
    fs.mkdirSync(extract, { recursive: true });
    const tar = runTool("tar", ["-xzf", path.join(tmp, filename), "-C", extract]);
    if (!tar.ok) throw new Error(`解压 tarball 失败：${(tar.stderr || tar.stdout).trim().slice(0, 400)}`);
    const kitDir = locateKitDir(path.join(extract, "package"));
    if (!kitDir) throw new Error("npm 包中未找到 plugin.json（也不存在 package.json 的 freesek.plugin 声明）");
    return { kitDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function fetchGitPlugin(raw: string): { kitDir: string; cleanup: () => void } {
  const tmp = makeTempDir("freesek-plugin-git-");
  const cleanup = (): void => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // 清理失败可忽略
    }
  };
  try {
    const repo = path.join(tmp, "repo");
    const git = runTool("git", ["clone", "--depth", "1", raw, repo]);
    if (!git.ok) throw new Error(`git clone 失败：${(git.stderr || git.stdout).trim().slice(0, 400)}`);
    const kitDir = locateKitDir(repo);
    if (!kitDir) throw new Error("git 仓库中未找到 plugin.json（或 package.json 的 freesek.plugin 声明）");
    return { kitDir, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

export interface PluginInstallResult {
  ok: boolean;
  message: string;
  spec: string;
  source: PluginSource;
  install?: KitInstallResult;
}

/** 安装插件：解析 spec → 下载/解包到临时目录 → 复用 installKit 落地项目 → 清理临时目录。 */
export async function installPlugin(specText: string, projectRoot: string): Promise<PluginInstallResult> {
  let spec: PluginSpec;
  try {
    spec = parsePluginSpec(specText);
  } catch (error: any) {
    return { ok: false, message: `插件 spec 无效：${error?.message ?? error}`, spec: specText, source: "file" };
  }
  try {
    let kitDir: string;
    let cleanup: (() => void) | null = null;
    if (spec.source === "npm") {
      const fetched = fetchNpmPlugin(spec.raw);
      kitDir = fetched.kitDir;
      cleanup = fetched.cleanup;
    } else if (spec.source === "git") {
      const fetched = fetchGitPlugin(spec.raw);
      kitDir = fetched.kitDir;
      cleanup = fetched.cleanup;
    } else {
      kitDir = path.resolve(spec.raw);
    }
    try {
      const res = installKit(kitDir, projectRoot);
      if (!res) {
        return {
          ok: false,
          message: `「${spec.label}」不是有效的套件：缺少可解析的 plugin.json。`,
          spec: specText,
          source: spec.source,
        };
      }
      const via = spec.source === "npm" ? "npm registry" : spec.source === "git" ? "git" : "本地目录";
      return { ok: true, message: `[${via}] ${res.summary}`, install: res, spec: specText, source: spec.source };
    } finally {
      if (cleanup) cleanup();
    }
  } catch (error: any) {
    return { ok: false, message: `插件安装失败：${error?.message ?? error}`, spec: specText, source: spec.source };
  }
}

/** 卸载插件（依据 kits.json 注册表逆操作删除）。 */
export function uninstallPlugin(projectRoot: string, name: string): { ok: boolean; message: string; removed: string[] } {
  return uninstallKit(projectRoot, name);
}

/** 列出已安装插件。 */
export function listPlugins(projectRoot: string): KitRecord[] {
  return listInstalledKits(projectRoot);
}

export interface PluginTheme {
  name: string;
  label: string;
  css: string;
}

/** 扫描项目 <root>/.agent/themes/*.css，返回插件皮肤（供 VS Code 面板下发 webview 注入）。 */
export function listInstalledThemes(projectRoot: string): PluginTheme[] {
  const dir = path.join(projectRoot, ".agent", "themes");
  const out: PluginTheme[] = [];
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const f of entries.sort()) {
    if (!f.endsWith(".css")) continue;
    const name = f.slice(0, -4).trim();
    if (!name) continue;
    try {
      const css = fs.readFileSync(path.join(dir, f), "utf8");
      out.push({ name, label: name, css });
    } catch {
      // 单个文件读取失败跳过，不阻断其余皮肤
    }
  }
  return out;
}
