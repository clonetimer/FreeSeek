/**
 * 免费 DeepSeek 逆向服务（deepseek-free-api）管理。
 * 从 extension.ts 拆分出的独立能力模块：
 * startFreeServer / isFreeServerRunning / autoStartFreeServerIfNeeded。
 * 借鉴 deepseek-harness 的 capability 分包思路——独立能力独立模块。
 */
import * as vscode from "vscode";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";
import { getActiveProvider, getActiveToolMode } from "./providers";

/** 以 Docker 或本地 Node 方式启动免费服务；silent=true 时跳过交互直接选 Node 方式。 */
async function startFreeServer(context: vscode.ExtensionContext, silent = false) {
  const cfg = vscode.workspace.getConfiguration("freesek");
  const customPath = (cfg.get<string>("freeApiLocalPath") || "").trim();
  const serverDir = customPath || path.join(context.extensionPath, "deepseek-free-api");
  const pick = silent
    ? { value: "node" }
    : await vscode.window.showQuickPick(
        [
          { label: "Docker 方式（推荐，需已装并启动 Docker）", value: "docker" },
          { label: "本地 Node 方式（用内置/本地源码，无需 Git）", value: "node" },
          { label: "仅查看配置说明（打开本地 README）", value: "docs" },
        ],
        { placeHolder: "选择启动免费 DeepSeek 服务的方式（Esc 可取消）" }
      );
  if (!pick) {
    return;
  }
  if (pick.value === "docker") {
    const term = vscode.window.createTerminal({ name: "FreeSeek 免费服务" });
    term.show();
    term.sendText(
      "docker run -it -d --name deepseek-free-api -p 8000:8000 -e TZ=Asia/Shanghai vinlic/deepseek-free-api:latest"
    );
    if (!silent) {
      vscode.window.showInformationMessage(
        "已尝试启动容器。首次使用请在容器日志里按提示用浏览器登录 DeepSeek 获取 userToken（详见 README）。默认访问地址 http://127.0.0.1:8000/v1"
      );
    }
  } else if (pick.value === "node") {
    const isWin = process.platform === "win32";
    const npmPrefix = `npm --prefix "${serverDir}"`;
    const scriptPath = path.join(
      os.tmpdir(),
      isWin ? "freeseek-start.cmd" : "freeseek-start.sh"
    );
    if (isWin) {
      const script =
        `@echo off\r\n` +
        `set SERVER_PORT=8000\r\n` +
        `cd /d "${serverDir}"\r\n` +
        `echo [FreeSeek] 释放 8000 端口（如已被占用）...\r\n` +
        `for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":8000"') do taskkill /PID %%p /F >nul 2>&1\r\n` +
        `echo [FreeSeek] 正在安装依赖（dist 已内置，无需构建）...\r\n` +
        `${npmPrefix} install --cache "${serverDir}\\.npmcache" && (\r\n` +
        `  echo [FreeSeek] 依赖安装完成，正在启动服务...\r\n` +
        `  ${npmPrefix} start\r\n` +
        `) || (\r\n` +
        `  echo [FreeSeek] 依赖安装失败，服务未启动。 & exit /b 1\r\n` +
        `)\r\n`;
      fs.writeFileSync(scriptPath, script, "utf8");
    } else {
      const script =
        `#!/usr/bin/env bash\n` +
        `set -e\n` +
        `export SERVER_PORT=8000\n` +
        `cd "${serverDir}"\n` +
        `lsof -ti:8000 | xargs -r kill -9 2>/dev/null || true\n` +
        `${npmPrefix} install --cache "${serverDir}/.npmcache"\n` +
        `${npmPrefix} start\n`;
      fs.writeFileSync(scriptPath, script, "utf8");
      fs.chmodSync(scriptPath, 0o755);
    }
    const term = vscode.window.createTerminal({ name: "FreeSeek 免费服务" });
    if (!silent) term.show();
    term.sendText(isWin ? `cmd /c "${scriptPath}"` : `sh "${scriptPath}"`);
    if (!silent) {
      vscode.window.showInformationMessage(
        `已在「${serverDir}」生成启动脚本并发送运行命令（兼容 PowerShell/cmd）。该 Web 兼容适配为实验功能；请通过 FreeSeek Provider 设置界面保存 userToken（SecretStorage），或在启动服务时设置环境变量 DEEP_SEEK_CHAT_AUTHORIZATION=<userToken>。`
      );
    }
  } else if (pick.value === "docs") {
    const readmeUri = vscode.Uri.file(path.join(serverDir, "README.md"));
    vscode.env.openExternal(readmeUri);
  }
}

/** 检测免费服务是否在运行（快速端口探测）。 */
async function isFreeServerRunning(baseUrl: string): Promise<boolean> {
  try {
    const url = `${baseUrl.replace(/\/+$/, "")}/models`;
    const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** 自动启动免费服务（扩展激活时调用，静默后台执行）。 */
async function autoStartFreeServerIfNeeded(context: vscode.ExtensionContext): Promise<void> {
  const cfg = vscode.workspace.getConfiguration("freesek");
  const autoStart = cfg.get<boolean>("autoStartFreeServer", true);
  if (!autoStart) return;
  // 仅当当前激活的提供商是 ReAct 免费模式（逆向服务）时才需要本地免费服务；
  // 若用户在用 DeepSeek 官方/其它云 API（native 模式），无需启动，避免拖慢扩展启动。
  const active = getActiveProvider();
  const activeToolMode = active ? getActiveToolMode() : "";
  if (activeToolMode !== "react") return;
  const baseUrl = cfg.get<string>("freeBaseUrl", "http://127.0.0.1:8000/v1");
  if (await isFreeServerRunning(baseUrl)) return;
  // 服务未运行，静默后台启动 Node 服务
  await startFreeServer(context, true);
}

export { startFreeServer, autoStartFreeServerIfNeeded };
