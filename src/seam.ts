/**
 * 能力 seam（对标 deepseek-harness 的 capability seam：Service Definition / Provider / Consumer）。
 *
 * 一项可替换能力 = 声明接口的 Service Definition + 实现它的 Service Provider + 使用它的 Consumer。
 * 替换 Provider 即可改变整个产品行为，而 Consumer 无感——这正是 dsh 文档所说「把进程提供方指向
 * 远程沙箱，就把 Bash/PTY/LSP 一并搬走」的来源：能力边界是接口，实现可替换。
 *
 * FreeSeek 第一个正式 seam：Command Execution（命令执行）。
 *   - Definition: CommandRunner 接口
 *   - Provider:   LocalCommandRunner（默认，包装 sandbox.runCommand 的多层沙箱执行）
 *   - Consumer:   tools.ts run_command / tools/exec_code.ts run_code（经 getCommandRunner 消费）
 *
 * 未来可替换 Provider：远程/容器执行、模拟执行（dry-run）、审计包装器等——
 * 替换后 run_command / run_code 自动切换，消费方零改动。
 */
import { commandExecPlan, runCommand } from "./sandbox";
import type { SandboxNetworkConfig } from "./sandbox";

/** 命令执行计划（由 ExecPolicy 派生的沙箱方案 / OS 引擎 / 受限标志）。 */
export type CommandExecPlan = ReturnType<typeof commandExecPlan>;

/** Service Definition：命令执行能力。 */
export interface CommandRunner {
  /** 执行一条命令，返回统一文本结果（成功/失败/超时/拦截原因，与 runCommand 契约一致）。 */
  run(input: {
    cwd: string;
    command: string;
    timeoutMs: number;
    envWhitelist?: string[];
    input?: string;
    label?: string;
    exec: CommandExecPlan;
    network: SandboxNetworkConfig;
    /** 结构化 argv（内部执行入口优先使用，避免 shell 二次解析）。 */
    argv?: string[];
    /** Agent/job 取消信号。 */
    signal?: AbortSignal;
  }): Promise<string>;
}

/** Service Provider（默认）：本地多层沙箱执行（off 进程级 / sandbox OS 级，由 ExecPolicy 决定）。 */
export const LocalCommandRunner: CommandRunner = {
  async run(input) {
    return runCommand({
      cwd: input.cwd,
      command: input.command,
      timeoutMs: input.timeoutMs,
      restricted: input.exec.restricted,
      envWhitelist: input.envWhitelist,
      osEngine: input.exec.osEngine,
      network: input.network,
      label: input.label,
      ...(input.argv?.length ? { argv: input.argv } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.input ? { input: input.input } : {}),
    });
  },
};

/** seam 注册表：当前执行提供方（默认本地；第三方/未来实现可替换）。 */
let commandRunner: CommandRunner = LocalCommandRunner;

export function getCommandRunner(): CommandRunner {
  return commandRunner;
}

/** 替换执行提供方（如远程/容器执行、dry-run）。传 null 恢复默认本地实现。 */
export function setCommandRunner(r: CommandRunner | null): void {
  commandRunner = r ?? LocalCommandRunner;
}

export function resetCommandRunner(): void {
  commandRunner = LocalCommandRunner;
}