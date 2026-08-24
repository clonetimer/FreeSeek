#!/usr/bin/env node
/**
 * freeseek-sdk CLI（缺口5 的命令行面）
 * ───────────────────────────────────────────────────────────────────────────
 * 官方 SDK 的命令行入口，对标 codex/dsh 的 CLI 分发能力。
 *   freeseek-sdk run   --prompt "..." [--cwd dir] [--mode coder|plan|ask] [--sandbox off|remote:docker@c]
 *   freeseek-sdk acp   [--serve] [--port N] [--host 127.0.0.1] [--token t]
 *   freeseek-sdk version
 * 底层复用 SDK（src/sdk.ts）与 headless 运行时，无 VS Code 依赖。
 */
import { runHeadless } from "./headless";
import { createFreeSeekSdk } from "./sdk";

function parse(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq !== -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  const sdk = createFreeSeekSdk();
  const opts = parse(rest);

  if (!sub || sub === "version" || sub === "--version" || sub === "-v") {
    // 通过 package.json 读取版本，避免循环依赖。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require("../package.json");
    process.stdout.write(`freeseek-sdk ${pkg.version}\n`);
    return;
  }

  if (sub === "run") {
    const prompt = String(opts.prompt ?? opts.p ?? "");
    if (!prompt) {
      process.stderr.write("freeseek-sdk run 需要 --prompt \"你的任务\"\n");
      process.exit(2);
    }
    // runHeadless 期望 argv 形如 ["--prompt", ...]，不含进程名/子命令前缀。
    const args = [
      "--prompt", prompt,
      ...(opts.cwd ? ["--workspace", String(opts.cwd)] : []),
      ...(opts.mode ? ["--mode", String(opts.mode)] : []),
      ...(opts.sandbox ? ["--sandbox", String(opts.sandbox)] : []),
      ...(opts.tui ? ["--tui"] : []),
      ...(opts.yes ? ["--yes"] : []),
      ...(opts["allow-shell"] ? ["--allow-shell"] : []),
    ];
    await runHeadless(args);
    return;
  }

  if (sub === "acp") {
    // 复用 ACP server 启动入口（stdio JSON-RPC）；其余 argv 直接透传给底层解析器。
    const code = await sdk.acp.startServerCli(process.argv.slice(3));
    process.exit(code);
    return;
  }

  process.stderr.write(`未知子命令：${sub}\n用法：freeseek-sdk <run|acp|version>\n`);
  process.exit(2);
}

main().catch((e) => {
  process.stderr.write(`freeseek-sdk 错误：${(e as Error).message}\n`);
  process.exit(1);
});
