/**
 * 扩展入口：activate / deactivate（从 extension.ts 拆出）。
 * 仅做命令注册与一次性初始化；ChatViewProvider 定义仍在 extension.ts。
 */
import * as vscode from "vscode";
import * as path from "node:path";
import { ChatViewProvider } from "./extension";
import { registerHttpConnector } from "./connectors/http";
import { registerPaperSeekConnector } from "./connectors/paper_seek";
import { disposeConnectors } from "./connectors";
import { setUserRolePresets } from "./rolePresets";
import { mcpManager, McpServerConfig } from "./mcp";
import { autoStartFreeServerIfNeeded, startFreeServer } from "./freeserver";
import { installKit } from "./kits";
import { Scheduler, ScheduledTask, ScheduleSpec } from "./scheduler";
import { initializeProviderSecrets } from "./provider-secrets";
import { FileExtensionHost } from "./kernel/extensions/package-host";
import { loadExtensionSandboxPolicyFile } from "./kernel/extensions/sandbox-policy";

/** 扩展激活入口：注册 webview provider、内置连接器、MCP server 与全部 freesek.* 命令。 */
export async function activate(context: vscode.ExtensionContext) {
  // 凭据必须先从普通 settings 迁入 SecretStorage，再创建 Provider/自动连接服务，
  // 避免激活早期读取到旧的明文配置。
  await initializeProviderSecrets(context);
  const configuredExtensionDirs = vscode.workspace.getConfiguration("freesek").get<string[]>("extensionDirs", []) || [];
  const extensionDirs = configuredExtensionDirs.filter((dir: string) => path.isAbsolute(dir));
  if (extensionDirs.length !== configuredExtensionDirs.length) {
    void vscode.window.showWarningMessage("FreeSeek：General HMR extensionDirs 只接受显式绝对 trust root；已忽略相对路径。");
  }
  const configuredSandboxPolicy = vscode.workspace.getConfiguration("freesek").get<string>("extensionSandboxPolicyFile", "").trim();
  const sandboxPolicy = configuredSandboxPolicy
    ? path.isAbsolute(configuredSandboxPolicy)
      ? loadExtensionSandboxPolicyFile(configuredSandboxPolicy)
      : (() => { throw new Error("FreeSeek：freesek.extensionSandboxPolicyFile 必须是绝对路径"); })()
    : undefined;
  const extensionHost = extensionDirs.length ? new FileExtensionHost({
    roots: extensionDirs,
    stateDir: path.join(context.globalStorageUri.fsPath, "extensions"),
    runtime: { onAudit: (event) => console.info(`[FreeSeek HMR:${event.kind}]`, event.extensionId ?? event.leaseId ?? "runtime") },
    sandboxPolicy,
  }) : undefined;
  if (extensionHost) {
    await extensionHost.start();
    context.subscriptions.push({ dispose: () => { void extensionHost.dispose(); } });
  }
  const provider = new ChatViewProvider(context, extensionHost?.runtime);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  // Layer 4：注册内置连接器（连接器插件机制；第三方可在 activate 前 registerConnector 追加）
  registerHttpConnector();
  registerPaperSeekConnector();
  // Layer 4：注入用户自定义 Agent 预设（freesek.agentPresets，对齐 CodeBuddy 自定义 Agent）。
  // 支持可选 model/provider 字段绑定模型（多模型分工）。
  setUserRolePresets(
    vscode.workspace.getConfiguration("freesek").get<Record<string, { body: string; tools?: string[]; model?: string; provider?: string }>>("agentPresets", {}) || {}
  );
  // Layer 4：激活时按配置连接外部 MCP server（best-effort，失败不影响内置工具）
  void mcpManager.connectFromConfig(() =>
    (vscode.workspace.getConfiguration("freesek").get<McpServerConfig[]>("mcpServers", []) || [])
  );
  // 自动启动免费服务（如果当前 provider 是免费服务且服务未运行）
  void autoStartFreeServerIfNeeded(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.openChat", () => {
      vscode.commands.executeCommand("workbench.view.extension.freesek");
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.startFreeServer", () => startFreeServer(context))
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.newChat", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.newChat();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.openHistory", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.openHistory();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.switchModel", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.switchModel();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.addProvider", () => {
      // 统一走 webview 内弹窗表单（对齐 CodeBuddy），而非 vscode 顶部原生输入框
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.openAddModelModal();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.editProviders", () => provider.editProviders())
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.manageMCP", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.manageMCP();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.manageExtensions", async () => {
      if (!extensionHost) {
        void vscode.window.showInformationMessage("FreeSeek：未配置 freesek.extensionDirs；General HMR 不会自动扫描工作区。");
        return;
      }
      const snapshot = extensionHost.management.snapshot();
      const pick = await vscode.window.showQuickPick([
        { label: "$(refresh) Reconcile all", description: snapshot.trustRoots.join(" · "), id: "__reconcile__" },
        ...snapshot.extensions.map((row) => ({ label: `${row.enabled ? "$(extensions)" : "$(circle-slash)"} ${row.id}`, description: `${row.health} · ${row.runtime.sandbox ? `sandbox:${row.runtime.sandbox.state}` : "in-process"} · ${row.packageVersion ?? row.runtime.activeVersion ?? "unknown"}`, detail: row.runtime.lastError ?? row.packageDirs.join(" · "), id: row.id })),
      ], { title: "FreeSeek General HMR Extensions", placeHolder: "Inspect or manage configured extensions" });
      if (!pick) return;
      if (pick.id === "__reconcile__") { await extensionHost.management.reconcile(); void vscode.window.showInformationMessage("FreeSeek：Extension reconcile 完成。"); return; }
      const row = extensionHost.management.status(pick.id);
      const action = await vscode.window.showQuickPick([
        { label: "Reload", value: "reload" },
        { label: row.enabled ? "Disable (retire; keep package bytes)" : "Enable", value: row.enabled ? "disable" : "enable" },
        { label: "Show recent audit", value: "audit" },
      ], { title: `${row.id} · ${row.health}` });
      if (!action) return;
      if (action.value === "reload") await extensionHost.management.reload(row.id);
      else if (action.value === "disable") await extensionHost.management.configure(row.id, { enabled: false });
      else if (action.value === "enable") await extensionHost.management.configure(row.id, { enabled: true });
      else {
        const events = extensionHost.management.audit({ extensionId: row.id, limit: 50 });
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(events, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: true });
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.forkSession", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.forkSession();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.openCommands", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.openCommands();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.renameSession", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.renameSession();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.clearConversation", () => {
      provider.newChat();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.resumeSession", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      void provider.resumeSession();
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.openSessionLog", () => {
      vscode.commands.executeCommand("freesek.chatView.focus");
      provider.openSessionLog();
    })
  );

  // ── 定时任务（对标 QwenWork 定时任务：本地调度，到点触发 provider 执行）──
  let persistSchedules = () => {};
  const scheduler = new Scheduler({
    onRun: (task) => {
      void vscode.window.showInformationMessage(`FreeSeek 定时任务触发：${task.name}`);
      provider.submitUserMessage(task.prompt);
    },
    onStateChange: () => persistSchedules(),
  });
  scheduler.load(context.globalState.get<ScheduledTask[]>("freesek.schedules") || []);
  persistSchedules = () => void context.globalState.update("freesek.schedules", scheduler.toJSON());
  // load() 可能完成旧数据迁移（补 createdAt/nextRunAt），先持久化再启动，避免启动 tick 使用旧状态。
  persistSchedules();
  scheduler.start();
  context.subscriptions.push({ dispose: () => scheduler.stop() });

  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.installKit", async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root) {
        void vscode.window.showWarningMessage("FreeSeek：请先打开一个工作区文件夹，再安装专家套件。");
        return;
      }
      const picked = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "安装套件",
        title: "选择专家套件目录（含 plugin.json）",
      });
      if (!picked || !picked[0]) return;
      const r = installKit(picked[0].fsPath, root);
      void vscode.window.showInformationMessage(
        r ? `FreeSeek：${r.summary}` : "FreeSeek：安装失败，请确认目录内含有效 plugin.json。"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.addSchedule", async () => {
      const name = await vscode.window.showInputBox({ prompt: "定时任务名称", placeHolder: "如：每日站会摘要" });
      if (!name) return;
      const prompt = await vscode.window.showInputBox({
        prompt: "任务指令（到点后发送给 Agent 的 Prompt）",
        placeHolder: "如：汇总今日工作并生成简报",
      });
      if (!prompt) return;
      const kindPick = await vscode.window.showQuickPick(
        [
          { label: "间隔运行", detail: "每 N 分钟触发一次" },
          { label: "每天固定时刻", detail: "每天 HH:mm 触发" },
        ],
        { title: "选择计划类型" }
      );
      if (!kindPick) return;
      let schedule: ScheduleSpec;
      if (kindPick.label === "间隔运行") {
        const mins = await vscode.window.showInputBox({
          prompt: "间隔分钟数",
          value: "60",
          validateInput: (v) => (/^\d+$/.test(v) && Number(v) >= 1 ? "" : "请输入 >=1 的整数分钟"),
        });
        if (!mins) return;
        schedule = { kind: "interval", everyMs: Number(mins) * 60000 };
      } else {
        const t = await vscode.window.showInputBox({
          prompt: "每天触发时刻 HH:mm",
          placeHolder: "09:00",
          validateInput: (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? "" : "格式 HH:mm（00:00-23:59）"),
        });
        if (!t) return;
        const [h, m] = t.split(":").map(Number);
        schedule = { kind: "daily", hour: h, minute: m };
      }
      const task = scheduler.add(name, prompt, schedule);
      persistSchedules();
      void vscode.window.showInformationMessage(`FreeSeek：已添加定时任务「${task.name}」。`);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.manageHookifyRules", () => provider.manageHookifyRules())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.manageKits", () => provider.manageKits())
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("freesek.manageSchedules", async () => {
      const tasks = scheduler.list();
      if (!tasks.length) {
        void vscode.window.showInformationMessage("FreeSeek：还没有定时任务，用「添加定时任务」创建。");
        return;
      }
      const pick = await vscode.window.showQuickPick(
        tasks.map((t) => ({
          label: `${t.enabled ? "" : "[停用] "}${t.name}`,
          description:
            t.schedule.kind === "interval"
              ? `每 ${t.schedule.everyMs / 60000} 分钟`
              : `每天 ${String(t.schedule.hour).padStart(2, "0")}:${String(t.schedule.minute).padStart(2, "0")}`,
          detail: t.id,
        })),
        { title: "管理定时任务" }
      );
      if (!pick) return;
      const task = scheduler.get(pick.detail);
      if (!task) return;
      const act = await vscode.window.showQuickPick(
        [
          { label: "立即运行", detail: "现在触发一次" },
          { label: task.enabled ? "停用" : "启用", detail: "切换启用状态" },
          { label: "删除", detail: "移除该任务（不可恢复）" },
        ],
        { title: `任务 ${task.name}` }
      );
      if (!act) return;
      if (act.label === "立即运行") scheduler.runNow(task.id);
      else if (act.label === "启用" || act.label === "停用") scheduler.setEnabled(task.id, !task.enabled);
      else if (act.label === "删除") scheduler.remove(task.id);
      persistSchedules();
    })
  );
}

/** 扩展停用钩子：释放连接器资源。 */
export function deactivate() {
  disposeConnectors(); // 释放连接器资源
}
