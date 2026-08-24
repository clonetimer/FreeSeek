// esbuild 打包脚本：同时构建扩展主进程与 Webview 前端。
let esbuild = null;
let esbuildLoadError = null;
try {
  esbuild = require("esbuild");
} catch (error) {
  esbuildLoadError = error;
}
const { resolve } = require("path");
const { existsSync, readFileSync } = require("fs");
const { spawnSync } = require("child_process");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");
const targetArg = process.argv.find((arg) => arg.startsWith("--build-target="));
const buildTarget = targetArg ? targetArg.slice("--build-target=".length) : "all";

// Node host bundles must preserve Node builtin imports instead of asking esbuild
// to resolve subpath builtins (for example node:readline/promises) as packages.
const NODE_HOST_EXTERNALS = ["vscode", "esbuild", "node:*"];

/** Ensure bundled Node CLI entrypoints contain exactly one shebang on line 1. */
function assertCliShebang(outfile) {
  const source = readFileSync(outfile, "utf8");
  const lines = source.split(/\r?\n/);
  if (lines[0] !== "#!/usr/bin/env node") {
    throw new Error(`${outfile}: CLI shebang must be the first line`);
  }
  const duplicate = lines.findIndex((line, index) => index > 0 && line.startsWith("#!"));
  if (duplicate >= 0) {
    throw new Error(`${outfile}: duplicate shebang on line ${duplicate + 1}`);
  }
}

function cliShebangGuard(outfile) {
  return {
    name: "freeseek-cli-shebang-guard",
    setup(build) {
      build.onEnd((result) => {
        if (!result.errors.length) assertCliShebang(outfile);
      });
    },
  };
}

function nativeEsbuildBinary() {
  const explicit = process.env.FREESEEK_ESBUILD_BIN || process.env.ESBUILD_BINARY_PATH;
  if (explicit && existsSync(explicit)) return explicit;
  const platform = process.platform === "win32" ? "win32" : process.platform;
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : process.arch;
  const executable = process.platform === "win32" ? "esbuild.exe" : "esbuild";
  const candidate = resolve(__dirname, "node_modules", "@esbuild", `${platform}-${arch}`, "bin", executable);
  return existsSync(candidate) ? candidate : null;
}

function buildWithCli(options) {
  if (watch) {
    throw new Error("esbuild JavaScript API is required for --watch; native CLI fallback is production/build-only");
  }
  const binary = nativeEsbuildBinary();
  if (!binary) {
    const detail = esbuildLoadError instanceof Error ? `: ${esbuildLoadError.message}` : "";
    throw new Error(`esbuild JavaScript API unavailable and no native binary was found${detail}`);
  }
  if (!Array.isArray(options.entryPoints) || options.entryPoints.length !== 1) {
    throw new Error("native esbuild CLI fallback supports exactly one entry point per build");
  }
  const args = [options.entryPoints[0], "--bundle", `--outfile=${options.outfile}`];
  if (options.format) args.push(`--format=${options.format}`);
  if (options.platform) args.push(`--platform=${options.platform}`);
  if (options.target) args.push(`--target=${options.target}`);
  if (options.sourcemap) args.push("--sourcemap");
  if (options.minify) args.push("--minify");
  if (options.treeShaking !== undefined) args.push(`--tree-shaking=${options.treeShaking ? "true" : "false"}`);
  if (options.logLevel) args.push(`--log-level=${options.logLevel}`);
  for (const external of options.external || []) args.push(`--external:${external}`);
  for (const [key, value] of Object.entries(options.define || {})) args.push(`--define:${key}=${value}`);
  for (const [extension, loader] of Object.entries(options.loader || {})) args.push(`--loader:${extension}=${loader}`);
  const result = spawnSync(binary, args, { cwd: __dirname, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`native esbuild CLI failed with exit ${result.status ?? "unknown"}`);
  if (options.outfile && options.entryPoints[0] !== resolve(__dirname, "src/extension.ts") && /(?:cli|acp-server)\.ts$/.test(options.entryPoints[0])) {
    assertCliShebang(options.outfile);
  }
}

async function runBuild(options) {
  if (esbuild) return esbuild.build(options);
  return buildWithCli(options);
}

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/extension.js"),
  // esbuild external：run_code 的 TS 类型擦除在运行时按需 require；开发模式可用，生产 vsix 缺失时自动回退 strip-types
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const headlessBuild = {
  entryPoints: [resolve(__dirname, "src/cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-headless.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: { __FREESEEK_CLI_ENTRY__: '"cli"' },
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-headless.js"))],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const acpBuild = {
  entryPoints: [resolve(__dirname, "src/acp-server.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-acp.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: { __FREESEEK_CLI_ENTRY__: '"acp"' },
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-acp.js"))],
  logLevel: "info",
};

/**
 * ACP sidecar（无自动运行入口的模块产物）：导出 runAcpCli，加载时不自动启动。
 * Web Console 以 `node -e require(entry).runAcpCli(...)` 方式拉起它，避免
 * `freeseek-acp.js`（带自动运行 define）被 require 时重复启动两个服务器。
 */
const acpSidecarBuild = {
  entryPoints: [resolve(__dirname, "src/acp-server.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-acp-sidecar.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webConsoleBuild = {
  entryPoints: [resolve(__dirname, "src/web-cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-web.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: { __FREESEEK_CLI_ENTRY__: '"web"' },
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-web.js"))],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const evalBuild = {
  entryPoints: [resolve(__dirname, "src/eval-cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-eval.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: { __FREESEEK_CLI_ENTRY__: '"eval"' },
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-eval.js"))],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const benchBuild = {
  entryPoints: [resolve(__dirname, "src/bench-cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-bench.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  define: { __FREESEEK_CLI_ENTRY__: '"bench"' },
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-bench.js"))],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const sdkBuild = {
  entryPoints: [resolve(__dirname, "src/sdk.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/sdk.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const sdkCliBuild = {
  entryPoints: [resolve(__dirname, "src/sdk-cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-sdk.js"),
  external: NODE_HOST_EXTERNALS,
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  plugins: [cliShebangGuard(resolve(__dirname, "dist/freeseek-sdk.js"))],
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewBuild = {
  entryPoints: [resolve(__dirname, "src/webview/main.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/webview.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  loader: { ".css": "text" },
  logLevel: "info",
};

/** Mermaid 懒加载渲染（独立 bundle，不进主 webview bundle，命中 ```mermaid 时按需加载） */
const mermaidBuild = {
  entryPoints: [resolve(__dirname, "src/webview/mermaid-loader.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/mermaid.js"),
  format: "iife",
  platform: "browser",
  target: "es2020",
  sourcemap: !production,
  minify: production,
  treeShaking: true,
  logLevel: "info",
};

const BUILD_TARGETS = {
  extension: extensionBuild,
  headless: headlessBuild,
  acp: acpBuild,
  acpSidecar: acpSidecarBuild,
  webConsole: webConsoleBuild,
  eval: evalBuild,
  bench: benchBuild,
  sdk: sdkBuild,
  sdkCli: sdkCliBuild,
  webview: webviewBuild,
  mermaid: mermaidBuild,
};

function selectedBuilds() {
  if (buildTarget === "all") return Object.entries(BUILD_TARGETS);
  const selected = BUILD_TARGETS[buildTarget];
  if (!selected) throw new Error(`Unknown build target: ${buildTarget}`);
  return [[buildTarget, selected]];
}

async function main() {
  const builds = selectedBuilds();
  if (watch) {
    if (!esbuild) {
      throw new Error("esbuild JavaScript API is required for --watch; install project dependencies before using watch mode");
    }
    const contexts = [];
    for (const [_name, options] of builds) contexts.push(await esbuild.context(options));
    for (const context of contexts) await context.watch();
    console.log(`watching ${builds.map(([name]) => name).join(", ")}...`);
  } else {
    for (const [_name, options] of builds) await runBuild(options);
    console.log(`build complete (${builds.map(([name]) => name).join(", ")})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
