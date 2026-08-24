import * as path from "path";
import { installPlugin, uninstallPlugin, listPlugins } from "./plugin";

interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
}

function pluginUsage(): string {
  return [
    "FreeSeek 插件管理（对标 `dsh plugin --profile web add <spec>`）",
    "",
    "用法：",
    "  freeseek plugin add <spec> [--root <dir>]      安装插件（npm / git / 本地目录）",
    "  freeseek plugin remove <name> [--root <dir>]   卸载插件（依据 kits.json 注册表逆操作）",
    "  freeseek plugin list [--root <dir>] [--json]   列出已安装插件",
    "  freeseek plugin help                           显示本帮助",
    "",
    "spec 示例：",
    "  @scope/pkg@latest                npm registry 包（裸 spec 默认按 npm 包处理）",
    "  npm:name@1.2.3                   显式 npm registry",
    "  git:https://github.com/user/repo  git clone",
    "  file:./dir 或 /abs/dir           本地套件目录",
    "",
    "插件内容：plugin.json 声明的 skills / commands / agents / themes，",
    "安装到项目 .agent/ 并可逆卸载；themes 为 webview 面板皮肤（.agent/themes/<name>.css）。",
    "未指定 --root 时默认使用当前工作目录。",
  ].join("\n");
}

/** 统计注册表 files 中各类内容数量（POSIX 相对路径）。 */
function summarizeFiles(files: string[]): string {
  const count = (prefix: string): number => files.filter((f) => f.startsWith(prefix)).length;
  const parts: string[] = [];
  const s = count(".agent/skills/");
  if (s) parts.push(`技能 ${s}`);
  const c = count(".agent/commands/");
  if (c) parts.push(`命令 ${c}`);
  const a = count(".agent/agents/");
  if (a) parts.push(`角色 ${a}`);
  const t = count(".agent/themes/");
  if (t) parts.push(`主题 ${t}`);
  return parts.length ? ` [${parts.join(" / ")}]` : "";
}

/** 解析 --root（默认 cwd），其余参数进 rest。 */
function parsePluginArgs(argv: string[]): { root: string; rest: string[]; error?: string } {
  let root = process.cwd();
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") {
      const v = argv[i + 1];
      if (!v || v.startsWith("--")) return { root, rest, error: "--root 缺少参数" };
      root = path.resolve(v);
      i++;
      continue;
    }
    rest.push(a);
  }
  return { root, rest };
}

export async function runPluginCli(argv: string[], io: CliIO): Promise<number> {
  const sub = argv[0];
  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    io.stdout(pluginUsage() + "\n");
    return 0;
  }
  const { root, rest, error } = parsePluginArgs(argv.slice(1));
  if (error) {
    io.stderr(error + "\n");
    return 2;
  }
  if (sub === "add" || sub === "install") {
    const spec = rest[0];
    if (!spec || spec.startsWith("--")) {
      io.stderr("用法：freeseek plugin add <spec> [--root <dir>]\n");
      return 2;
    }
    const res = await installPlugin(spec, root);
    if (res.ok) {
      io.stdout(res.message + "\n");
      return 0;
    }
    io.stderr(res.message + "\n");
    return 1;
  }
  if (sub === "remove" || sub === "rm" || sub === "uninstall") {
    const name = rest[0];
    if (!name || name.startsWith("--")) {
      io.stderr("用法：freeseek plugin remove <name> [--root <dir>]\n");
      return 2;
    }
    const r = uninstallPlugin(root, name);
    if (r.ok) {
      io.stdout(r.message + "\n");
      return 0;
    }
    io.stderr(r.message + "\n");
    return 1;
  }
  if (sub === "list" || sub === "ls") {
    const records = listPlugins(root);
    if (rest.includes("--json")) {
      io.stdout(JSON.stringify({ root, count: records.length, plugins: records }, null, 2) + "\n");
      return 0;
    }
    if (!records.length) {
      io.stdout(`没有已安装插件（项目根：${root}）\n`);
      return 0;
    }
    io.stdout(`已安装插件（${records.length}）：\n`);
    for (const r of records) {
      io.stdout(`  ${r.name}${r.version ? " v" + r.version : ""} — ${r.installedAt}${summarizeFiles(r.files)}\n`);
    }
    return 0;
  }
  io.stderr(`plugin 未知子命令：${sub}\n\n${pluginUsage()}\n`);
  return 2;
}
