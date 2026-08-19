// check:max-lines 140 (verify 工具族：验证命令探测/执行/失败定位；tools.ts 拆分)
import * as fs from "fs";
import * as path from "path";
import type { ToolContext } from "../tools";
import { execPolicyFromContext, commandExecPlan } from "../sandbox";
import { getCommandRunner } from "../seam";

/** 一次验证命令的执行结果（verify 工具内部使用）。 */
interface VerificationResult {
  /** 退出码；null 表示超时被终止 */
  code: number | null;
  /** 汇总后的 stdout+stderr（截断到合理长度） */
  output: string;
}

/**
 * 探测工作区的验证命令。按 kind / scripts 自动推断：
 *  - typecheck：tsconfig.json 存在 → `npx tsc --noEmit`
 *  - lint：package.json scripts 含 lint → `npm run lint`
 *  - test：package.json scripts 含 test → `npm test`
 *  - auto：优先 test，其次 lint，再 typecheck
 * 返回命令字符串；无法探测时返回 ""（调用方给出提示）。
 */
function detectVerifyCommand(root: string, kind: string): string {
  let pkgScripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    pkgScripts = pkg?.scripts ?? {};
  } catch {
    /* 无 package.json，下面按 kind 兜底 */
  }
  const hasTsc = fs.existsSync(path.join(root, "tsconfig.json"));
  const scripts: Record<string, string | undefined> = {
    typecheck: hasTsc ? "npx tsc --noEmit" : undefined,
    lint: pkgScripts["lint"] ? "npm run lint" : undefined,
    test: pkgScripts["test"] ? "npm test" : undefined,
  };
  if (kind === "typecheck") return scripts.typecheck ?? "";
  if (kind === "lint") return scripts.lint ?? "";
  if (kind === "test") return scripts.test ?? "";
  // auto：按 test → lint → typecheck 顺序选首个可用
  return scripts.test ?? scripts.lint ?? scripts.typecheck ?? "";
}

/**
 * 执行一条验证命令，返回退出码与输出。用异步 execFile + 超时，拿到确定退出码便于判定。
 * cwd 固定为工作区根；超过 timeoutMs 则终止并标记 code=null。
 */
async function runVerifyExec(
  cmd: string,
  ctx: ToolContext,
  timeoutMs: number
): Promise<VerificationResult> {
  const policy = execPolicyFromContext(ctx);
  const exec = commandExecPlan(policy);
  if (exec.plan.blocked) {
    return { code: null, output: exec.plan.blockedReason || "OS 沙箱不可用，验证已阻止" };
  }
  const output = await getCommandRunner().run({
    cwd: ctx.workspaceRoot,
    command: cmd,
    timeoutMs,
    envWhitelist: ctx.envWhitelist,
    exec,
    network: policy.network,
    label: "verify",
    signal: ctx.signal,
  });
  if (/命令超时|TOOL_TIMEOUT|aborted|AbortError|终止/i.test(output)) {
    return { code: null, output };
  }
  if (/\bexit 0\b/.test(output)) return { code: 0, output };
  const m = output.match(/code=([^）)\s]+)/);
  const parsed = m && /^-?\d+$/.test(m[1]) ? Number(m[1]) : 1;
  return { code: parsed, output };
}

/** 从验证输出中提取「文件:行」定位，供 Agent 直接读取修复点。支持常见格式。 */
function extractLocs(output: string, root: string): string[] {
  const locs = new Set<string>();
  const winDrive = /[A-Za-z]:/;
  for (const line of output.split("\n")) {
    // 形如:  src/foo.ts(12,3): error TS...
    const paren = line.match(/^([^(\s]+\.\w+)\((\d+),\s*(\d+)\):/);
    // 形如:  src/foo.ts:12:3 或  src/foo.ts:12: error
    const colon = line.match(/^([^:\s]+\.\w+):(\d+):(\d+)?/);
    let m = paren || colon;
    if (!m) continue;
    let fp = m[1];
    // 兼容 windows 盘符 "C:/..." 前缀（路径前有盘符时不处理，因为正则已含 : 会截断）
    if (!winDrive.test(fp) && !path.isAbsolute(fp)) {
      fp = path.join(root, fp);
    }
    const lineNo = m[2];
    locs.add(`${fp}:${lineNo}`);
    if (locs.size >= 15) break;
  }
  return [...locs];
}

/** verify 工具实现：质量门禁的「跑→定位→回填」。 */
export async function runVerification(ctx: ToolContext, args: any): Promise<string> {
  const kindRaw = String(args.kind ?? "auto");
  const kind = ["typecheck", "lint", "test"].includes(kindRaw) ? kindRaw : "auto";
  const cmd = args.command ? String(args.command) : detectVerifyCommand(ctx.workspaceRoot, kind);
  if (!cmd) {
    return (
      "⚠️ 无法自动探测验证命令。当前项目没有可用的 package.json scripts（test/lint）或 tsconfig.json。\n" +
      "可显式指定 verify({ command: \"<实际命令>\" })（如 'npm run check'）。"
    );
  }
  const timeout = ctx.commandTimeout ?? 120000;
  const res = await runVerifyExec(cmd, ctx, timeout);
  const output = res.output.slice(0, 4000);
  const locs = extractLocs(output, ctx.workspaceRoot);
  const ok = res.code === 0;
  const head = ok
    ? `✅ 验证通过：\`${cmd}\`（exit 0）`
    : res.code === null
      ? `⚠️ 验证超时或未完成：\`${cmd}\`（>${Math.round(timeout / 1000)}s）`
      : `❌ 验证失败：\`${cmd}\`（exit ${res.code}）`;
  const locBlock = locs.length
    ? `\n\n📌 失败定位（文件:行）：\n${locs.join("\n")}\n\n请用 read_file 读取这些位置并修复。`
    : res.code === 0
      ? ""
      : `\n\n（未解析到「文件:行」定位，请查看下方输出定位问题）`;
  const outBlock = output ? `\n\n--- 输出（截断）---\n${output}\n--- 结束 ---` : "";
  return `${head}${locBlock}${outBlock}`;
}
