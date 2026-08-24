/**
 * FreeSeek SDK（缺口5）：面向第三方的官方 TS 入口
 * ───────────────────────────────────────────────────────────────────────────
 * 对标 codex / dsh 的官方 SDK：把 FreeSeek 的「内核能力」整理为一组稳定的、与
 * VS Code 扩展宿主解耦的 API，供 CI / 脚本 / 嵌入式应用直接 import 或经 freeseek-sdk CLI 调用。
 *
 * 导出面：
 *   - 运行时：runAgent / createToolRuntime / createToolRegistry / applyPolicyDecision
 *   - 工具：内置工具定义（TOOL_DEFINITIONS）/ ToolContext 类型
 *   - 沙箱：本地执行 + 远程/云沙箱 provider（docker/ssh/e2b）+ createRemoteCommandRunner
 *   - 策略：声明式 ExecPolicy DSL（compileExecPolicy / loadExecPolicyDocument）
 *   - 协议：ACP server（startAcpServerCli）/ ACP client 连接（desktop acp-client）
 *
 * 注意：本文件只做「再导出 + 轻量包装」，且对含 VS Code 宿主代码的模块（acp-server 等）
 * 一律延迟 require，确保纯 Node 环境下 import sdk 不触碰 vscode。
 */
import { runAgent } from "./agent";
import { ToolRegistry, type ToolRegistry as IToolRegistry } from "./tool-registry";
import { ToolRuntime, type ToolRuntime as IToolRuntime } from "./tool-runtime";
import { TOOL_DEFINITIONS, type ToolContext } from "./tools";
import type { ToolDefinition } from "./provider";
import {
  createRemoteCommandRunner,
  createLocalDockerRemoteSandboxTransport,
  createSshRemoteSandboxTransport,
  createE2BRemoteSandboxTransport,
  type RemoteSandboxTransport,
} from "./remote-sandbox";
import {
  compileExecPolicy,
  loadExecPolicyDocument,
  applyPolicyDecision,
  type ExecPolicyDocument,
  type PolicyDecision,
  type PolicyContext,
} from "./sandbox";
import type { CommandRunner } from "./seam";

export interface FreeSeekSdk {
  /** 运行一次 Agent 回合（非阻塞，返回 await 即可）。 */
  runAgent: typeof runAgent;
  /** 工具注册表：从工具定义构造，提供 getByQualifier / execute。 */
  createToolRegistry: (defs: ToolDefinition[]) => IToolRegistry;
  /** 工具运行时：负责 preToolUse 审批、沙箱参数、权限回调编排（需传入 registry）。 */
  createToolRuntime: (ctx: ToolContext, registry: IToolRegistry) => IToolRuntime;
  /** 内置工具定义（read/run_command/glob/grep/edit/write 等）。 */
  toolDefinitions: ToolDefinition[];
  /** 本地 vs 远程沙箱 runner 构造器。 */
  sandboxes: {
    createRemoteCommandRunner: typeof createRemoteCommandRunner;
    docker: (o: { container: string; docker?: string }) => RemoteSandboxTransport;
    ssh: (o: { host: string; ssh?: string; sshArgs?: string[] }) => RemoteSandboxTransport;
    e2b: (o: { sandboxId: string; apiKey: string; baseUrl?: string }) => RemoteSandboxTransport;
  };
  /** 声明式执行策略 DSL。 */
  policy: {
    compile: typeof compileExecPolicy;
    load: typeof loadExecPolicyDocument;
    apply: typeof applyPolicyDecision;
  };
  /** ACP 协议栈（agentic coding protocol）：服务端 + 客户端。 */
  acp: {
    /** 启动 ACP server（stdio JSON-RPC）。含 VS Code 宿主代码，延迟装载。 */
    startServerCli: (argv: string[], io?: { stdout: (s: string) => void; stderr: (s: string) => void }) => Promise<number>;
  };
}

/** 构造 FreeSeek SDK 实例。 */
export function createFreeSeekSdk(): FreeSeekSdk {
  return {
    runAgent,
    createToolRegistry: (defs) => ToolRegistry.fromDefinitions(defs),
    createToolRuntime: (ctx, registry) => new ToolRuntime(ctx, registry),
    toolDefinitions: TOOL_DEFINITIONS,
    sandboxes: {
      createRemoteCommandRunner,
      docker: createLocalDockerRemoteSandboxTransport,
      ssh: createSshRemoteSandboxTransport,
      e2b: createE2BRemoteSandboxTransport,
    },
    policy: {
      compile: compileExecPolicy,
      load: loadExecPolicyDocument,
      apply: applyPolicyDecision,
    },
    acp: {
      startServerCli: (argv, io) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { startAcpServerCli } = require("./acp-server");
        return startAcpServerCli(argv, io as any);
      },
    },
  };
}

// 类型再导出（供 SDK 消费者做静态类型检查）。
export type {
  ToolContext,
  CommandRunner,
  ToolDefinition,
  ExecPolicyDocument,
  PolicyDecision,
  PolicyContext,
  IToolRegistry as ToolRegistryType,
  IToolRuntime as ToolRuntimeType,
  RemoteSandboxTransport,
};

/** 默认 SDK 实例（便捷：import { freeseek } from "freeseek"）。 */
export const freeseek: FreeSeekSdk = createFreeSeekSdk();
export default freeseek;
