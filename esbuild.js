// esbuild 打包脚本：同时构建扩展主进程与 Webview 前端。
const esbuild = require("esbuild");
const { resolve } = require("path");
const { readFileSync } = require("fs");

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

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

/** @type {import('esbuild').BuildOptions} */
const extensionBuild = {
  entryPoints: [resolve(__dirname, "src/extension.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/extension.js"),
  // esbuild external：run_code 的 TS 类型擦除在运行时按需 require；开发模式可用，生产 vsix 缺失时自动回退 strip-types
  external: ["vscode", "esbuild"],
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
  external: ["vscode", "esbuild"],
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
const evalBuild = {
  entryPoints: [resolve(__dirname, "src/eval-cli.ts")],
  bundle: true,
  outfile: resolve(__dirname, "dist/freeseek-eval.js"),
  external: ["vscode", "esbuild"],
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
  external: ["vscode", "esbuild"],
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

async function main() {
  if (watch) {
    const ctx1 = await esbuild.context(extensionBuild);
    const ctx2 = await esbuild.context(headlessBuild);
    const ctx3 = await esbuild.context(evalBuild);
    const ctx4 = await esbuild.context(benchBuild);
    const ctx5 = await esbuild.context(webviewBuild);
    const ctx6 = await esbuild.context(mermaidBuild);
    await ctx1.watch();
    await ctx2.watch();
    await ctx3.watch();
    await ctx4.watch();
    await ctx5.watch();
    await ctx6.watch();
    console.log("watching...");
  } else {
    await esbuild.build(extensionBuild);
    await esbuild.build(headlessBuild);
    await esbuild.build(evalBuild);
    await esbuild.build(benchBuild);
    await esbuild.build(webviewBuild);
    await esbuild.build(mermaidBuild);
    console.log("build complete");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
