// check:max-lines 250 (run_python / run_code 代码执行器；tools.ts 拆分；v0.17.9 收敛 TOOL_OUTPUT_PREVIEW_CAP 引用 +1)
import * as fs from "fs";
import * as path from "path";
import { resolveSafe, resolveSafeInRoots } from "./fs_utils";
import { truncatePreview } from "../agent-utils";
import { execPolicyFromContext, commandExecPlan } from "../sandbox";
import { getCommandRunner } from "../seam";
import type { ToolContext } from "../tools";

/**
 * run_python：专门的 Python 执行器（数据分析 / 可视化缺口补齐）。
 *  - 把代码写入工作区内临时文件（.agent/tmp/），用 python / python3 运行；
 *  - 父进程前置注入 matplotlib Agg 后端（无显示环境也能存图），并自动可用 pandas/numpy/matplotlib；
 *  - 运行后收集工作目录内新生成的 PNG（图表）编码为 base64，经 onPythonCharts 回传 webview 渲染进聊天；
 *  - 带超时（默认 120s，最大 600s）与输出截断（默认 8000 字符），防止长输出撑爆上下文；
 *  - Python / Node / Bash 统一经 CommandRunner、权限策略、OS sandbox 与 AbortSignal 执行。
 */
export async function runPython(ctx: ToolContext, args: any): Promise<string> {
  const code = String(args.code ?? "");
  if (!code.trim()) return "⚠️ run_python 需要 code。";
  const timeoutSec = Math.min(Math.max(Number(args.timeout) || 120, 1), 600);
  const cwd = args.cwd
    ? resolveSafeInRoots(ctx.workspaceRoot, ctx.additionalWorkspaceRoots, String(args.cwd)).path
    : ctx.workspaceRoot;
  const tmpDir = path.join(ctx.workspaceRoot, ".agent", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });

  // 提前列出目录内已有 PNG，运行后比对"新增的图表"
  const beforePng = new Set(
    fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith(".png")) : []
  );

  const pyBin = process.platform === "win32" ? "python" : "python3";
  // 自动注入 matplotlib Agg 后端 + 友好的中文友好报错；保留用户原始代码
  const preamble = [
    "import sys, os",
    "try:",
    "    import matplotlib",
    "    matplotlib.use('Agg')",
    "except Exception:",
    "    pass",
  ].join("\n");
  const fullCode = `${preamble}\n${code}\n`;
  const scriptPath = path.join(tmpDir, `py_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.py`);
  fs.writeFileSync(scriptPath, fullCode, "utf8");

  const policy = execPolicyFromContext(ctx);
  const exec = commandExecPlan(policy);
  if (exec.plan.blocked) {
    try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
    return `⛔ ${exec.plan.blockedReason}`;
  }
  const result = await getCommandRunner().run({
    cwd,
    command: `${pyBin} ${scriptPath}`,
    argv: [pyBin, scriptPath],
    timeoutMs: timeoutSec * 1000,
    envWhitelist: ctx.envWhitelist,
    exec,
    network: policy.network,
    label: "run_python",
    signal: ctx.signal,
  });

  // 收集新增图表 PNG → base64
  const charts: Array<{ path: string; dataUrl: string; caption: string }> = [];
  try {
    for (const f of fs.readdirSync(tmpDir)) {
      if (!f.toLowerCase().endsWith(".png")) continue;
      if (beforePng.has(f)) continue;
      const fp = path.join(tmpDir, f);
      const b64 = fs.readFileSync(fp).toString("base64");
      charts.push({ path: fp, dataUrl: `data:image/png;base64,${b64}`, caption: f });
    }
  } catch {
    /* 忽略收集错误 */
  }
  // 清理临时脚本（图表保留，便于前端已渲染）
  try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }

  // 回传图表给 webview（渲染进聊天）
  if (charts.length && ctx.onPythonCharts) {
    try { ctx.onPythonCharts(charts); } catch { /* ignore */ }
  }

  const chartNote = charts.length
    ? `\n\n📊 已生成 ${charts.length} 张图表，已渲染进聊天（${charts.map((c) => c.caption).join(", ")}）。`
    : "";
  return `run_python 完成（${pyBin}）：${truncatePreview(result)}${chartNote}`;
}

/**
 * run_code：通用代码执行器（Code Mode）。在沙箱内执行代码片段，适合计算、数据转换、脚本验证等不落盘的轻量任务。
 *  - python → 复用 runPython 通道（matplotlib Agg + 图表自动渲染）
 *  - bash   → 走 runCommand 沙箱通道（OS 级隔离 / L2 危险命令拦截兜底）
 *  - javascript / typescript → 写 .mjs / .mts 用 node 执行；TS 优先用项目内 esbuild 同步擦除类型（快、无需网络），
 *    不可用时回退 Node 22.6+ 的 --experimental-strip-types
 *  - 带超时（默认 60s，最大 300s）与 8000 字符输出截断，防撑爆上下文
 */
export async function runCode(ctx: ToolContext, args: any): Promise<string> {
  const code = String(args.code ?? "");
  if (!code.trim()) return "⚠️ run_code 需要 code。";
  const language = String(args.language ?? "python").toLowerCase();
  const timeoutSec = Math.min(Math.max(Number(args.timeout) || 60, 1), 300);
  const base = ctx.worktreeRoot ?? ctx.workspaceRoot;
  const cwd = args.cwd
    ? (ctx.worktreeRoot
      ? resolveSafe(base, String(args.cwd))
      : resolveSafeInRoots(ctx.workspaceRoot, ctx.additionalWorkspaceRoots, String(args.cwd)).path)
    : base;

  // bash / sh / shell → 复用 run_command 沙箱通道
  if (language === "bash" || language === "sh" || language === "shell") {
    const policy = execPolicyFromContext(ctx);
    const exec = commandExecPlan(policy);
    if (exec.plan.blocked) {
      return `⛔ ${exec.plan.blockedReason}`;
    }
    // 参数超时上限 300s，与工具定义声明的守卫预算（300000ms）一致，二者并行生效
    const timeoutMs = Math.max(1000, Math.min((args.timeout ?? 60) * 1000, 300000));
    const osEngine = exec.osEngine;

    // Windows 无原生 bash：降级到 cmd/PowerShell，并对常见 bash 命令做简单转译
    let command = code;
    if (process.platform === "win32" && !osEngine) {
      command = code
        .replace(/\bsleep\s+(\d+)(?:\.\d+)?\b/g, "timeout /t $1 /nobreak")
        .replace(/\bls\b/g, "dir")
        .replace(/\bcat\b/g, "type");
      if (/&&|\|\|/.test(command)) {
        // 含 &&/|| 的链式命令：把代码写入临时 .ps1 脚本，用 -File 执行。
        // 攻击面：旧实现用 `powershell -Command "..."` 并仅转义双引号，模型代码中的
        // 反引号（`）与子表达式 $(...) 可逃逸引号边界执行任意命令。改为 -File 从文件读取，
        // 代码体不再进入命令行解析，杜绝命令注入。
        const psTmp = path.join(
          ctx.workspaceRoot,
          ".agent",
          "tmp",
          `bash_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}.ps1`
        );
        try {
          fs.mkdirSync(path.dirname(psTmp), { recursive: true });
          fs.writeFileSync(psTmp, command, "utf8");
          return await getCommandRunner().run({
            cwd,
            command: `powershell -NoProfile -ExecutionPolicy Bypass -File "${psTmp.replace(/"/g, "\"\"")}"`,
            argv: ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", psTmp],
            timeoutMs,
            envWhitelist: ctx.envWhitelist,
            exec,
            network: policy.network,
            label: "run_code(bash/win)",
            signal: ctx.signal,
          });
        } finally {
          try { fs.unlinkSync(psTmp); } catch { /* ignore */ }
        }
      }
    }
    return getCommandRunner().run({
      cwd,
      command,
      timeoutMs,
      envWhitelist: ctx.envWhitelist,
      exec,
      network: policy.network,
      label: "run_code(bash)",
      signal: ctx.signal,
    });
  }

  // python → 复用 runPython（图表自动渲染）
  if (language === "python" || language === "py") {
    return runPython(ctx, { code, timeout: timeoutSec, cwd: args.cwd });
  }

  // javascript / typescript → Node eval。使用 argv 直接传代码，避免 Windows shell quoting；
  // CommonJS require("./src/...") / ESM import 都相对 cwd 解析，而不是相对 .agent/tmp 临时文件。
  const isTs = language === "typescript" || language === "ts";
  const isJs = language === "javascript" || language === "js";
  if (!isTs && !isJs) {
    return `⚠️ run_code 不支持语言 "${language}"。支持：python / javascript / typescript / bash。`;
  }
  let runnable = code;
  const nodeArgs: string[] = [];
  if (isTs) {
    try {
      // 优先用项目内 esbuild 同步擦除类型（无需网络，快）
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const esbuild = require("esbuild");
      runnable = esbuild.transformSync(code, { loader: "ts", target: "node18" }).code;
    } catch {
      // 项目内无 esbuild（如运行时剥离依赖）→ 回退 Node 22.6+ 的 --experimental-strip-types
      nodeArgs.push("--experimental-strip-types");
    }
  }

  const requestedFormat = String(args.module_format ?? "auto").toLowerCase();
  const moduleFormat = requestedFormat === "commonjs" || requestedFormat === "module"
    ? requestedFormat
    : /^\s*(?:import|export)\s/m.test(runnable) ? "module" : "commonjs";
  nodeArgs.push(`--input-type=${moduleFormat}`, "-e", runnable);

  const policy = execPolicyFromContext(ctx);
  const exec = commandExecPlan(policy);
  if (exec.plan.blocked) return `⛔ ${exec.plan.blockedReason}`;
  const result = await getCommandRunner().run({
    cwd,
    command: `node --input-type=${moduleFormat} -e <run_code ${isTs ? "typescript" : "javascript"}>`,
    argv: ["node", ...nodeArgs],
    timeoutMs: timeoutSec * 1000,
    envWhitelist: ctx.envWhitelist,
    exec,
    network: policy.network,
    label: `run_code(${isTs ? "typescript" : "javascript"}/${moduleFormat})`,
    signal: ctx.signal,
  });

  return `run_code 完成（node · ${isTs ? "typescript" : "javascript"} · ${moduleFormat}）：${truncatePreview(result)}`;
}
