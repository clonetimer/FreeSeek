// check:max-lines 720
/**
 * 受限命令执行器（Layer 4 安全边界 / 对标 Claude Code Seatbelt & Codex OS 沙箱）。
 *
 * 设计目标：把约束下沉到 **OS 内核级**，作为 Harness 权限层（L2 危险命令拦截）之下的
 * 第二道防线（纵深防御 / Defense in Depth）。即使模型绕过 Harness 用 `Bash` 跑
 * `cat ~/.ssh/id_rsa`，OS 沙箱仍在内核级拒绝越界读、拦截出网。
 *
 * 三档由 `freesek.sandboxMode` 控制：
 *   - off：原样执行（env 全量透传），仅依赖 L2 危险命令拦截；
 *   - readonly：完全禁止 run_command（最保守）；
 *   - sandbox：走 OS 级沙箱包装（macOS Seatbelt / Linux·WSL2 bubblewrap）+ 进程级 env 剥离兜底。
 *
 * OS 级引擎（对标 Claude Code / Codex 本地 CLI）：
 *   - macOS   → `sandbox-exec` + 动态生成 Seatbelt profile（内核 Mandatory Access Control）；
 *   - Linux/WSL2 → `bwrap`（bubblewrap）新建 mount/network 命名空间 + seccomp 思路的 cap-drop；
 *   - Windows → 无原生 OS 沙箱，降级为「进程级受限执行」（env 过滤 + cwd 锁 + 硬超时），
 *              并提示可借 Docker Desktop（`docker sandbox run` / `docker run --read-only`）获得容器级隔离。
 *
 * 网络出网（对标 Claude Code `network.allowedDomains` + Codex 默认禁网）：
 *   - sandboxNetwork.mode = "off"      → 完全禁网（bwrap --unshare-net / Seatbelt deny network*）；
 *   - sandboxNetwork.mode = "localhost"→ 请求仅本机网络；当前本地 OS 后端在无法证明 loopback-only 时 fail-closed 为禁网；
 *   - sandboxNetwork.mode = "allow"    → 放开网络（v0.8 不做域名代理，仅作便利档；域名白名单留待 v0.9 代理）。
 *
 * 可用性探测：引擎缺失时按 `freesek.sandboxFailIfUnavailable` 决定是「硬失败拦截」
 * （托管部署安全闸门）还是「软降级到进程级受限执行 + 告警」（本地开发默认）。
 */

import { execFile, execSync } from "child_process";
import { isDestructiveCommand } from "./dangerous";


export type SandboxMode = "off" | "readonly" | "sandbox";
export type SandboxNetworkMode = "off" | "localhost" | "allow";
export type OsEngine = "seatbelt" | "bwrap" | "none";

export interface SandboxNetworkConfig {
  /** 出网模式：off=完全禁网 / localhost=请求仅本机（当前本地后端可能 fail-closed 为禁网）/ allow=放开 */
  mode?: SandboxNetworkMode;
  /** 域名白名单（v0.8 未启用，v0.9 经代理实现；此处仅作占位声明） */
  allowedDomains?: string[];
  /** localhost 绑定意图（预留给受控代理/可验证 loopback 后端；当前 fail-closed 实现不依赖此字段） */
  allowLocalBinding?: boolean;
}

export interface SandboxPlan {
  mode: SandboxMode;
  /** 是否真正走 OS 级沙箱（engine 可用 且 mode==="sandbox"） */
  osSandboxed: boolean;
  engine: OsEngine;
  /** failIfUnavailable 且 engine 缺失时为真：命令应被安全网关硬拦截 */
  blocked: boolean;
  blockedReason?: string;
  /** 软降级（engine 缺失但 failIfUnavailable=false）时的提示 */
  warning?: string;
}

export interface RunCommandOpts {
  /** 实际工作目录（调用方已用 resolveSafe 锁定在 root 内） */
  cwd: string;
  /** 待执行命令（整条字符串） */
  command: string;
  /** 可选：结构化 argv。提供时不经过 shell 解析，适合 Python/Node/verify 等内部执行入口。 */
  argv?: string[];
  /** 硬超时（毫秒），超时即杀进程 */
  timeoutMs: number;
  /** sandbox 档：过滤环境变量（只留系统必需 + 白名单） */
  restricted?: boolean;
  /** 受限档下额外允许的 env 键 */
  envWhitelist?: string[];
  /** OS 沙箱引擎（由 planSandbox 决定）；提供时包裹执行，否则走进程级 */
  osEngine?: OsEngine;
  /** 网络出网配置（仅 osEngine 生效时起作用） */
  network?: SandboxNetworkConfig;
  /** 执行失败时携带的命令信息，用于友好提示 */
  label?: string;
  /** 写入 stdin 的输入（应对交互式确认，如 "y\nn\n"）。execFile 会在命令读 stdin 时注入。 */
  input?: string;
  /** 上层 Agent/job 的取消信号；abort 时 Node 会终止底层子进程。 */
  signal?: AbortSignal;
}

/**
 * 系统运行所必需的 env 键；`restricted` 档仍保留，否则命令（git/node/npm…）
 * 会因找不到 PATH 等而无法运行。这里刻意 **不** 包含任何凭据类变量
 * （SSH_AUTH_SOCK、AWS_SECRET_ACCESS_KEY、GITHUB_TOKEN 等），它们在受限档被剥离。
 */
const SYSTEM_ENV = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "SystemDrive",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "USERPROFILE",
  "USERNAME",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_IDENTIFIER",
  "NUMBER_OF_PROCESSORS",
  "PROMPT",
  "PSModulePath",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramData",
  "LOCALAPPDATA",
  "APPDATA",
  "TZ",
];

/** OS 沙箱下仍要显式拒绝读取的凭据目录（即使 profile 允许了全局读，也在这里封死）。 */
const DENY_READ_DIRS = [".ssh", ".aws", ".config", ".gnupg", ".netrc", ".kube", ".npmrc"];

/**
 * 命令级凭据读拦截（进程级降级档，尤其 Windows 无 OS 沙箱时）：
 * OS 沙箱（Seatbelt / bwrap）能在内核级拒绝凭据目录读，但进程级执行没有该能力，
 * 因此这里对 restricted 档的显式凭据路径读取做命令级兜底拦截。
 */
function containsCredentialAccess(cmd: string): boolean {
  const c = cmd.toLowerCase();
  const credPatterns = [
    /\.ssh[\\/]/,
    /\.aws[\\/]/,
    /\.gnupg[\\/]/,
    /\.netrc/,
    /\.kube[\\/]config/,
    /id_rsa/,
    /id_ed25519/,
    /id_ecdsa/,
    /aws_credentials/,
    /github_token/,
    /\.npmrc/,
  ];
  return credPatterns.some((re) => re.test(c));
}



/**
 * 探测当前平台可用的 OS 沙箱引擎。
 *  - macOS：检查 `sandbox-exec` 是否存在（系统自带）；
 *  - Linux/WSL2：检查 `bwrap`（bubblewrap）是否安装；
 *  - Windows：无原生引擎，返回 none（提示走 Docker）。
 */
export function detectOsSandbox(): { engine: OsEngine; available: boolean; reason?: string } {
  if (process.platform === "darwin") {
    try {
      execSync("command -v sandbox-exec", { stdio: "ignore" });
      return { engine: "seatbelt", available: true };
    } catch {
      return { engine: "seatbelt", available: false, reason: "sandbox-exec 缺失（macOS 应自带，罕见）" };
    }
  }
  if (process.platform === "linux") {
    const isWsl = safeIsWsl();
    try {
      execSync("command -v bwrap", { stdio: "ignore" });
      return { engine: "bwrap", available: true };
    } catch {
      return {
        engine: "bwrap",
        available: false,
        reason: isWsl
          ? "bwrap 缺失：WSL2 下执行 `sudo apt-get install bubblewrap socat`"
          : "bwrap 缺失：执行 `sudo apt-get install bubblewrap socat`（或改用容器）",
      };
    }
  }
  return {
    engine: "none",
    available: false,
    reason: "Windows 无原生 OS 沙箱；可借 Docker Desktop（docker sandbox run）获得容器级隔离",
  };
}

/** 轻量 WSL 探测（避免硬依赖 is-wsl，且保持 Windows 下不报错）。 */
function safeIsWsl(): boolean {
  try {
    const ver = execSync("cat /proc/version 2>/dev/null", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .toLowerCase();
    return ver.includes("microsoft") || ver.includes("wsl");
  } catch {
    return false;
  }
}

/**
 * 解析本次执行的沙箱方案：决定要不要走 OS 沙箱、是否应被硬拦截。
 * 纯函数、低开销，可在 agent 循环（preToolUse 跳过判定）与工具执行两处复用。
 */
export function planSandbox(mode: SandboxMode, failIfUnavailable?: boolean): SandboxPlan {
  if (mode !== "sandbox") {
    return { mode, osSandboxed: false, engine: "none", blocked: false };
  }
  const det = detectOsSandbox();
  if (!det.available) {
    if (failIfUnavailable) {
      return {
        mode,
        osSandboxed: false,
        engine: det.engine,
        blocked: true,
        blockedReason:
          `⛔ OS 沙箱不可用（${det.reason}），且 sandboxFailIfUnavailable=true：` +
          `命令被安全网关拦截。请先安装对应引擎，或在可信环境中放宽该开关。`,
      };
    }
    return {
      mode,
      osSandboxed: false,
      engine: det.engine,
      blocked: false,
      warning:
        `⚠️ OS 沙箱不可用（${det.reason}）。本次降级为「进程级受限执行」（env 过滤 + 硬超时），` +
        `未提供 OS 级文件/网络隔离；请勿在此档下执行不可全信的命令。`,
    };
  }
  return { mode, osSandboxed: true, engine: det.engine, blocked: false };
}

/**
 * 执行策略层（对标 Codex core/execpolicy：把「执行策略」从内核抽成可审计的独立配置层）。
 *
 * 这里只收敛「执行」本身相关开关（sandbox 档位 / 网络出网 / 是否允许 shell / 引擎缺失策略）。
 * 权限规则（allow/deny）与文件内容静态扫描归属 hooks 安全层，不混入执行策略（职责边界）。
 * 调用方从 VS Code settings 取出字段后交给 resolveExecPolicy / execPolicyFromContext，
 * 得到一份「不可变、已填默认、可审计」的策略；命令执行前统一消费，而非各处读 settings。
 *
 * sandbox.ts 保持零 vscode 依赖：本函数接收「已取出的配置片段」，不直接读 settings。
 */
export interface ExecPolicy {
  /** 沙箱档位（off / readonly / sandbox）。 */
  sandboxMode: SandboxMode;
  /** engine 缺失且为 true 时硬拦截（托管部署安全闸门）；false 则软降级。 */
  sandboxFailIfUnavailable: boolean;
  /** 网络出网配置（仅走 OS 沙箱时生效）。 */
  network: SandboxNetworkConfig;
  /** 是否允许执行 shell 命令（默认 true；false 则 run_command 被拦）。 */
  allowShell: boolean;
}

/** 解析并收口执行策略：填默认值、保证结构体完整，返回可审计的不可变策略。 */
export function resolveExecPolicy(cfg: {
  sandboxMode: SandboxMode;
  sandboxFailIfUnavailable?: boolean;
  network?: SandboxNetworkConfig;
  allowShell?: boolean;
}): ExecPolicy {
  return {
    sandboxMode: cfg.sandboxMode,
    sandboxFailIfUnavailable: cfg.sandboxFailIfUnavailable ?? false,
    network: {
      mode: cfg.network?.mode ?? "off",
      allowedDomains: cfg.network?.allowedDomains ?? [],
      allowLocalBinding: cfg.network?.allowLocalBinding ?? true,
    },
    allowShell: cfg.allowShell ?? true,
  };
}

/**
 * 从执行上下文（ToolContext 的执行相关片段）归一化出 ExecPolicy。
 * 签名只依赖结构化字段，保持 sandbox.ts 零 vscode / 零 tools 依赖（避免循环导入）。
 */
export function execPolicyFromContext(cfg: {
  sandboxMode?: SandboxMode;
  sandboxFailIfUnavailable?: boolean;
  sandboxNetwork?: SandboxNetworkConfig;
  allowShell?: boolean;
}): ExecPolicy {
  return resolveExecPolicy({
    sandboxMode: cfg.sandboxMode ?? 'off',
    sandboxFailIfUnavailable: cfg.sandboxFailIfUnavailable,
    network: cfg.sandboxNetwork,
    allowShell: cfg.allowShell,
  });
}

/**
 * 从 ExecPolicy 一次性推导命令执行所需派生量：沙箱计划 / OS 引擎 / 受限标志。
 * 工具层只消费 policy + 本函数，不再各自组合 planSandbox / osEngine / restricted。
 */
export function commandExecPlan(policy: ExecPolicy): {
  plan: SandboxPlan;
  osEngine: OsEngine | undefined;
  restricted: boolean;
} {
  const plan = planSandbox(policy.sandboxMode, policy.sandboxFailIfUnavailable);
  return {
    plan,
    osEngine: plan.osSandboxed ? plan.engine : undefined,
    restricted: policy.sandboxMode === 'sandbox',
  };
}

/** 构建受限 env：只保留系统必需 + 用户白名单，其余（含凭据）全部剥离。 */
function buildRestrictedEnv(whitelist?: string[]): NodeJS.ProcessEnv {
  const allow = new Set<string>([...SYSTEM_ENV, ...(whitelist ?? [])]);
  const env: NodeJS.ProcessEnv = {};
  for (const k of Object.keys(process.env)) {
    if (allow.has(k)) env[k] = process.env[k];
  }
  return env;
}

/**
 * 生成 macOS Seatbelt profile（动态、按 cwd 与 network 配置）。
 * 规则顺序遵循 Apple 规范：先 broad allow，再用 deny 收口敏感路径（deny 优先于 allow）。
 */
function buildSeatbeltProfile(cwd: string, net: SandboxNetworkConfig): string {
  const home = process.env.HOME || process.env.USERPROFILE || "~";
  const denyReads = DENY_READ_DIRS.map(
    (d) => `(deny file-read* (subpath "${home}/${d}"))`
  ).join("\n  ");
  let network = "";
  if (net.mode === "off") {
    network = "(deny network*)\n";
  } else if (net.mode === "localhost") {
    // 在没有受控代理/可验证 Seatbelt loopback 规则前 fail-closed：宁可暂时禁网，
    // 也不能把“localhost”误实现成可访问公网。
    network = "(deny network*)\n";
  } else {
    network = "(allow network*)\n";
  }
  return [
    "(version 1)",
    "(deny default)",
    "(allow process-exec)",
    "(allow process-fork)",
    "(allow signal (target self))",
    "(allow file-read* (subpath \"/\"))",
    `  ${denyReads}`,
    `(allow file-write* (subpath "${cwd}") (subpath "/tmp") (subpath "/private/tmp"))`,
    "(deny file-write*)",
    network,
  ].join("\n");
}

/** 生成 Linux/WSL2 bubblewrap 参数（mount/network 命名空间隔离）；目标可为 shell 命令或结构化 argv。 */
function buildBwrapPrefix(cwd: string, net: SandboxNetworkConfig): string[] {
  const args: string[] = [
    "--ro-bind",
    "/",
    "/",
    "--bind",
    cwd,
    cwd,
    "--tmpfs",
    "/tmp",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--cap-drop",
    "ALL",
    "--new-session",
  ];
  // off / localhost 都进入独立 network namespace，确保不能访问外网。
  // localhost 档在部分发行版中 loopback 默认未启用，会表现为「比声明更严格」而非泄漏外网；
  // 在引入受控网络代理前，安全优先于可用性。
  if (net.mode === "off" || net.mode === "localhost") {
    args.push("--unshare-net");
  }
  return args;
}

/** 按 OS 引擎构造包装后的 {bin, args}；命令整体作为 /bin/sh -c 的单一参数传入，避免二次 shell 解析。 */
function buildOsWrapper(
  engine: OsEngine,
  cwd: string,
  command: string,
  net: SandboxNetworkConfig,
  argv?: string[]
): { bin: string; args: string[] } {
  const target = argv?.length ? argv : ["/bin/sh", "-c", command];
  if (engine === "seatbelt") {
    const profile = buildSeatbeltProfile(cwd, net);
    return { bin: "sandbox-exec", args: ["-p", profile, "--", ...target] };
  }
  // bwrap
  return { bin: "bwrap", args: [...buildBwrapPrefix(cwd, net), ...target] };
}

async function execCapture(
  bin: string,
  args: string[],
  opts: RunCommandOpts,
  env: NodeJS.ProcessEnv
): Promise<string> {
  return new Promise((resolve) => {
    const finish = (e: any, stdoutRaw: any = "", stderrRaw: any = "") => {
      const stdout = stdoutRaw ? String(stdoutRaw) : "";
      const stderr = stderrRaw ? String(stderrRaw) : "";
      if (!e) {
        resolve(`exit 0\n--- stdout ---\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ""}`);
        return;
      }
      const code = e?.code ?? e?.exitCode;
      const killed = e?.killed ? "（已被终止）" : "";
      const out = stdout ? `\n--- stdout ---\n${stdout}` : "";
      const err = stderr ? `\n--- stderr ---\n${stderr}` : "";
      if (e?.name === "AbortError" || code === "ABORT_ERR") {
        resolve(`⛔ 命令已取消${killed}。${out}${err}`);
        return;
      }
      if (code === "ETIMEDOUT" || e?.signal === "SIGTERM") {
        resolve(`⛔ 命令超时（>${Math.round(opts.timeoutMs / 1000)}s）${killed}。如需更久，调大 freesek.commandTimeout。${out}${err}`);
        return;
      }
      resolve(`命令执行失败（code=${code ?? "?"}）${killed}。${out}${err}`);
    };

    try {
      const child = execFile(bin, args, {
        cwd: opts.cwd,
        timeout: opts.timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        windowsHide: true,
        env,
        ...(opts.signal ? { signal: opts.signal } : {}),
      }, finish);
      // execFile 的 options 没有 stdin `input` 字段；必须显式写入 child.stdin。
      if (typeof opts.input === "string" && child.stdin) child.stdin.end(opts.input);
    } catch (e: any) {
      finish(e);
    }
  });
}

/**
 * 执行一条命令。统一返回字符串（兼容 executeTool 的契约），执行失败也返回
 * 可读错误而非抛异常（由上层 maybeOffload 决定是否落盘）。
 *
 * 分支：
 *  - osEngine 提供且非 none → 走 OS 级包装（Seatbelt / bwrap）；
 *  - 否则 → 进程级执行（restricted 时过滤 env，off 时透传）。
 */
export async function runCommand(opts: RunCommandOpts): Promise<string> {
  const cmd = String(opts.command).trim();
  if (!cmd) return "run_command 失败：命令为空。";

  if (opts.osEngine && opts.osEngine !== "none") {
    const w = buildOsWrapper(opts.osEngine, opts.cwd, cmd, opts.network ?? {}, opts.argv);
    const env =
      opts.restricted !== false ? buildRestrictedEnv(opts.envWhitelist) : process.env;
    const tag = `[OS 沙箱: ${opts.osEngine} / 网络=${opts.network?.mode ?? "off"}]\n`;
    const out = await execCapture(w.bin, w.args, opts, env);
    return tag + out;
  }

  // ── 进程级执行（off 档或 OS 引擎缺失降级）──
  // 进程级没有 OS 内核隔离，restricted 档对显式凭据读做命令级兜底拦截；
  // off 档（用户明确原样执行）至少拦住灾难性高危命令。
  if (opts.restricted && containsCredentialAccess(cmd)) {
    return (
      "⛔ 进程级受限执行：已阻止读取凭据文件（.ssh/.aws/.gnupg/.netrc/.kube/.npmrc 等）。\n" +
      "说明：当前平台无 OS 级沙箱（如 Windows 无 Seatbelt/bwrap），无法内核级隔离，" +
      "故在命令层兜底拒绝凭据读取。如需执行，请改用可信环境或将 freesek.sandboxMode 调为 off（自行承担风险）。"
    );
  }
  if (!opts.restricted && isDestructiveCommand(cmd)) {
    return (
      "⛔ 高危命令被安全网关拦截（rm -rf /、git push --force 等）。\n" +
      "说明：off 档下仍默认拦灾难性操作；如确有必要，请在命令前显式确认或调整 freesek.sandboxMode/allowShell。"
    );
  }
  let bin: string;
  let args: string[];
  if (opts.argv?.length) {
    [bin, ...args] = opts.argv;
  } else if (process.platform === "win32") {
    bin = process.env.ComSpec || "cmd.exe";
    args = ["/d", "/s", "/c", cmd];
  } else {
    bin = "/bin/sh";
    args = ["-c", cmd];
  }
  const env = opts.restricted ? buildRestrictedEnv(opts.envWhitelist) : process.env;
  return execCapture(bin, args, opts, env);
}

// ════════════════════════════════════════════════════════════════════════════
// 缺口2：声明式命令策略语言（Declarative ExecPolicy DSL）
// ──────────────────────────────────────────────────────────────────────────────
// 对标 codex 的 execpolicy：用「声明式规则集」替代散落的正则 allow/deny 数组，
// 支持按 cmd 字面量 / 正则 / effect 类别 / OS / 网络意图组合判定，并能表达
// allow / deny / ask(交互审批) / sandbox(强制 OS 沙箱) / readonly(禁执行) 五档结果。
//
// 这是一层「纯函数、可审计、可单测」的策略评估器：不依赖 vscode，也不碰具体
// 命令执行链路，编译后返回一个 (ctx) => PolicyDecision 的判定函数，由 ToolRuntime
// / RunCommand 在 preToolUse 阶段调用。
// ════════════════════════════════════════════════════════════════════════════

/** 策略判定结果档位。 */
export type PolicyTier = "allow" | "deny" | "ask" | "sandbox" | "readonly";

/** 命令 effect 类别（与危险/网络判定解耦，供规则匹配）。 */
export type PolicyEffect = "read" | "write" | "net" | "destructive" | "neutral";

/** 规则匹配的 when 子句（所有给定字段都必须命中；省略的字段表示不约束该维度）。 */
export interface PolicyWhen {
  /** 命令字面量精确匹配（如 "git status"）。 */
  cmd?: string;
  /** 命令正则（字符串形式，运行时编译为 RegExp）。匹配整条待执行命令串。 */
  regex?: string;
  /** effect 类别命中其一即匹配（如 ["destructive"]）。 */
  effect?: PolicyEffect[];
  /** OS 平台命中其一即匹配（process.platform 取值：win32/darwin/linux）。 */
  os?: NodeJS.Platform[];
  /** 网络意图命中其一即匹配。 */
  network?: SandboxNetworkMode[];
}

/** 单条策略规则（对标 codex execpolicy 的 rule 项）。 */
export interface PolicyRule {
  /** 匹配条件；为空 {} 表示命中一切（常作兜底规则）。 */
  when: PolicyWhen;
  /** 命中后的处理档位。 */
  tier: PolicyTier;
  /** 可读原因（出现在拦截/审批提示里，便于审计与解释）。 */
  reason?: string;
}

/** 声明式策略文档（可由 freesek.execPolicyFile 指向的 JSON 提供）。 */
export interface ExecPolicyDocument {
  version: 1;
  /** 默认档位（无规则命中时采用）。强烈建议显式声明，缺失时 fail-closed 为 "ask"。 */
  default?: PolicyTier;
  /** 规则按数组顺序求值：第一条全部命中的规则胜出（首规则优先）。 */
  rules?: PolicyRule[];
}

/** 一次策略判定的输入上下文。 */
export interface PolicyContext {
  command: string;
  /** 推断出的 effect 类别；调用方可用 detectCommandEffect 辅助生成。 */
  effect: PolicyEffect;
  network: SandboxNetworkMode;
}

/** 编译后的判定结果。 */
export interface PolicyDecision {
  tier: PolicyTier;
  /** 命中规则的原因（无则回退到 default 原因）。 */
  reason?: string;
  /** 命中的规则下标（用于审计日志）；-1 表示 default。 */
  ruleIndex: number;
}

function classifyEffectSimple(cmd: string): PolicyEffect {
  const c = cmd.toLowerCase();
  if (/(^|\s)(rm\s+-rf|rm\s+-r\s+-f|mkfs|dd\s+if=|format|shutdown|reboot|git\s+push\s+(--force|-f))(\s|$)/.test(c)) {
    return "destructive";
  }
  if (/(^|\s)(curl|wget|ssh|scp|rsync|git\s+(clone|fetch|pull|push)|npm\s+(i|install|publish)|pip\s+install|pnpm|yarn|telnet|nc\b|ncat)(\s|$)/.test(c)) {
    return "net";
  }
  if (/(^|\s)(write|edit|touch|mkdir|cp|mv|git\s+(commit|add|checkout|branch|merge|rebase))(\s|$)/.test(c)) {
    return "write";
  }
  if (/(^|\s)(cat|head|tail|less|more|grep|rg|fd|ls|read|git\s+(status|log|diff|show|branch))(\s|$)/.test(c)) {
    return "read";
  }
  return "neutral";
}

/** 辅助：从命令串推断 effect 类别（供调用方在构建 PolicyContext 时使用）。 */
export function detectCommandEffect(command: string): PolicyEffect {
  return classifyEffectSimple(command);
}

function whenMatches(when: PolicyWhen, ctx: PolicyContext): boolean {
  if (when.cmd !== undefined && ctx.command.trim() !== when.cmd.trim()) return false;
  if (when.regex !== undefined) {
    try {
      if (!new RegExp(when.regex).test(ctx.command)) return false;
    } catch {
      // 非法正则视为不匹配（不阻断其他规则），但留痕由编译期校验负责。
      return false;
    }
  }
  if (when.effect?.length && !when.effect.includes(ctx.effect)) return false;
  if (when.os?.length && !when.os.includes(process.platform)) return false;
  if (when.network?.length && !when.network.includes(ctx.network)) return false;
  return true;
}

/**
 * 编译声明式策略文档为可执行的判定函数。
 * - 编译期做基本校验（正则可编译、default 缺失警告），返回 fail-closed 判定器；
 * - 运行期首规则优先：第一条 whenMatches 为真的规则胜出；无命中用 default。
 */
export function compileExecPolicy(doc: ExecPolicyDocument): (ctx: PolicyContext) => PolicyDecision {
  const rules = doc.rules ?? [];
  // 编译期预编译正则，避免运行期重复编译。
  const compiled = rules.map((r, i) => {
    let re: RegExp | undefined;
    if (r.when.regex) {
      try {
        re = new RegExp(r.when.regex);
      } catch (e) {
        throw new Error(`ExecPolicy 规则 #${i} 正则非法：${r.when.regex} -> ${(e as Error).message}`);
      }
    }
    return { rule: r, index: i, re };
  });
  const fallback: PolicyTier = doc.default ?? "ask";
  return (ctx: PolicyContext): PolicyDecision => {
    for (const { rule, index, re } of compiled) {
      const w = rule.when;
      if (w.cmd !== undefined && ctx.command.trim() !== w.cmd.trim()) continue;
      if (re && !re.test(ctx.command)) continue;
      if (w.effect?.length && !w.effect.includes(ctx.effect)) continue;
      if (w.os?.length && !w.os.includes(process.platform)) continue;
      if (w.network?.length && !w.network.includes(ctx.network)) continue;
      return { tier: rule.tier, reason: rule.reason, ruleIndex: index };
    }
    return {
      tier: fallback,
      reason: doc.default ? undefined : "未命中任何规则，按 fail-closed 默认档 'ask' 处理",
      ruleIndex: -1,
    };
  };
}

/** 把策略文档从磁盘加载（当前支持 JSON；YAML 由上层转换后传对象）。 */
export function loadExecPolicyDocument(raw: unknown): ExecPolicyDocument {
  if (!raw || typeof raw !== "object" || (raw as any).version !== 1) {
    throw new Error("ExecPolicy 文档非法：需含 version:1");
  }
  const d = raw as ExecPolicyDocument;
  if (d.rules) {
    for (const r of d.rules) {
      if (r.when.regex) new RegExp(r.when.regex); // 触发校验
    }
  }
  return d;
}

/**
 * 把声明式策略决策并入现有 ExecPolicy：当决策为 sandbox 档时强制 sandboxMode=sandbox，
 * deny/readonly 时统一通过 blocked 表达，ask 留给 ToolRuntime 走交互审批。
 * 返回「已修正」的 ExecPolicy 与可选硬拦截原因，供 RunCommand 在 preToolUse 阶段消费。
 */
export function applyPolicyDecision(
  base: ExecPolicy,
  decision: PolicyDecision
): { policy: ExecPolicy; blocked?: string } {
  switch (decision.tier) {
    case "deny":
      return {
        policy: base,
        blocked: `⛔ 执行策略拒绝该命令${decision.reason ? `（${decision.reason}）` : ""}。`,
      };
    case "readonly":
      return {
        policy: { ...base, sandboxMode: "readonly", allowShell: false },
        blocked: `⛔ 执行策略将该命令限为 readonly（禁止执行）${decision.reason ? `（${decision.reason}）` : ""}。`,
      };
    case "sandbox":
      return {
        policy: { ...base, sandboxMode: "sandbox", allowShell: base.allowShell },
        blocked: undefined,
      };
    case "allow":
      // allow 档下即便 base 为 readonly 也放行（声明策略优先级高于静态档位）。
      return { policy: { ...base, sandboxMode: "off", allowShell: true }, blocked: undefined };
    case "ask":
    default:
      return { policy: base, blocked: undefined };
  }
}
