// check:max-lines 2800 (已拆 freeserver/storage/webview-html/prompts/activate/agent-utils/rolePresets；v0.17.11 权限收敛+侧边栏入口+manageHookifyRules+manageKits 增行；待拆 providerUI / handleUser 后继续减小)
import * as vscode from "vscode";
import type { ExtensionRuntime } from "./kernel/extensions/runtime";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { ChatMessage, reflectConversation } from "./provider";
import { runAgent, AgentCallbacks, clearSubAgentRegistry } from "./agent";
import { trimUnfinishedTurn } from "./agent-utils";
import { listRolePresets } from "./rolePresets";
import { listInstalledThemes } from "./plugin";
import {
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_PROTECTION,
  REACT_PROTOCOL,
  NATIVE_TOOL_GUIDANCE,
  WORKFLOW_GUIDANCE,
  VERIFY_GUIDANCE,
  CONTEXT_COMPRESSION_GUIDANCE,
  PLAN_MODE_GUIDANCE,
  ASK_MODE_GUIDANCE,
  CODER_MODE_GUIDANCE,
  PendingEdit,
  buildModelOptions,
  isChitChat,
  summarizeTaskText,
} from "./prompts";
import { reflectAndSuggest, sessionStartHook, preCompactHook, userPromptSubmitHook } from "./hooks";

import { mcpManager, McpServerConfig } from "./mcp";
import { connectorSummary } from "./connectors";
import { getAllToolDefinitions, AskRequest, clearFileSnapshots, AgentMode, TodoState } from "./tools";
import { loadCommands, getCommand, resolveCommand } from "./commands";
// 注意：TOOL_DEFINITIONS 已由 getAllToolDefinitions() 统一合并（含 MCP 工具），此处不再单独引用。
import { loadRules, loadLastCompactState } from "./rules";
import {
  currentTimeBlock,
  refreshPromptTime,
  assembleBoundedFragmentsWithManifest,
  type ContextualFragment,
} from "./promptFragments";
import { SkillManager, defaultUserSkillsDir, distillSkillFromSession, type DistilledSkillInfo } from "./skills";
import { loadGoalState, renderGoalView } from "./goal";
import { loadMemorySection, extractDurableMemory, countMemories, clearProjectMemory } from "./memory";
import { tieredCompact, usageRatio, conversationTokens } from "./context";
import { importJsonl } from "./importer";
import {
  getActiveLabel,
  getActiveToolMode,
  setActiveSelection,
  buildSwitchItems,
  getActiveSelection,
  ProviderConfig,
  ProviderFormat,
  ModelCapabilities,
  AuthType,
  interpolateSecret,
} from "./providers";
import { storeProviderSecret, deleteProviderSecret } from "./provider-secrets";
import { commandExecPlan, resolveExecPolicy } from "./sandbox";
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_OFFICIAL_BASE_URL, DEEPSEEK_PRO_MODEL } from "./deepseek";
import {
  ensureEventLog,
  appendEvent,
  readSessionEvents,
  projectSessionTitle,
  deleteSessionEventLog,
} from "./eventlog";
import { buildWebviewHtml } from "./webview/html";
import { makeId, SessionStorage } from "./storage";
import {
  listHookifyRules,
  createHookifyRule,
  toggleHookifyRule,
  deleteHookifyRule,
  validateHookifyPattern,
  type HookifyEvent,
  type HookifyAction,
} from "./hookify";
import { listInstalledKits, uninstallKit, type KitRecord } from "./kits";







export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "freesek.chatView";
  private conversation: ChatMessage[] = [];
  private abort: AbortController | null = null;
  private currentSessionId: string = makeId();
  private view: vscode.WebviewView | null = null;
  private _skillMgr: SkillManager | null = null;
  /** 对话模式运行时状态（plan/ask/craft/coder，默认读配置，可由前端切换）。
   *  craft=制作（完整能力，可执行命令）；coder=编码（专职需求理解+代码生成，权限等同 craft）；
   *  plan=规划（只读+出方案）；ask=问答（纯只读问答）。 */
  private agentMode: AgentMode = "coder";
  /** 可执行模式：craft（制作）与 coder（编码）拥有写文件 / 执行命令的完整能力。 */
  private get isExecMode(): boolean {
    return this.agentMode === "craft" || this.agentMode === "coder";
  }
  /** 权限弹窗待决请求表：key=请求 id，value=resolver（含超时定时器）。 */
  private pendingPermissions = new Map<
    string,
    { resolve: (v: { allow: boolean; persist?: "allow" | "deny" }) => void; timer?: NodeJS.Timeout }
  >();
  /** ask_user 交互卡待决请求表：key=请求 id，value=resolver（含超时定时器）。 */
  private pendingAsks = new Map<string, { resolve: (v: string) => void; timer?: NodeJS.Timeout }>();
  /** 待决文件编辑表（对话内 diff 卡「接受/回滚」用），切换/新建会话时清空。 */
  private pendingEdits = new Map<string, PendingEdit>();
  /** 后台会话缓冲：用户切到其他会话时，切走会话的后台 Agent 仍在运行，其消息暂存于此，避免污染当前视图与落盘。 */
  private backgroundSessions = new Map<string, ChatMessage[]>();
  /** 后台会话各自独立的 abort（供将来「停止某个后台会话」用；当前仅记录，不自动中断）。 */
  private backgroundAborts = new Map<string, AbortController>();
  /** 等待队列：Agent 正在回复/执行时，用户继续输入的消息暂存于此（FIFO）。
   *  对齐 CodeBuddy「对话执行时把新输入加入等待序列」——回复结束后自动作为下一条消息发送。
   *  仅缓存纯文本（图片场景罕见，排队消息不带图）。 */
  private pendingUserQueue: string[] = [];
  /** 队列中来自定时任务/外部投递的消息集合（这些消息前端没渲染过，消费时需补渲染）。 */
  private injectedPending = new Set<string>();
  /** 是否正在跑一轮 Agent（handleUser 执行中）。用于区分新到的 user 消息：运行中→入队，空闲→立即处理。 */
  private running = false;
  /** 当前会话运行中涉及的文件 + diff 统计（供「文件列表」内嵌面板渲染）。key = 会话 id。 */
  private runFiles = new Map<
    string,
    Map<string, { added: number; removed: number; kind: string; ids: string[]; reads: number }>
  >();
  /** 会话历史持久化（路径/索引/队列写/迁移），从本类拆分出的独立能力模块。 */
  private storage: SessionStorage;

  constructor(private readonly context: vscode.ExtensionContext, private readonly extensionRuntime?: ExtensionRuntime) {
    this.storage = new SessionStorage(context);
    // 启动时恢复上次活动的会话（落盘历史），使整窗重载后对话不丢失
    const idx = this.storage.loadIndex();
    if (idx.current) {
      const conv = this.storage.loadSessionInto(idx.current, this.backgroundSessions);
      if (conv && conv.length > 0) {
        this.conversation = conv;
        this.currentSessionId = idx.current;
      }
    }
    this.agentMode = this.readAgentMode();
  }

  /** 读取对话模式：优先 freesek.mode（plan/ask/craft/coder，默认 coder），旧配置 freesek.planMode=true 时回退为 plan。 */
  private readAgentMode(): AgentMode {
    const cfg = vscode.workspace.getConfiguration("freesek");
    const m = cfg.get<string>("mode", "");
    if (m === "plan" || m === "ask" || m === "craft" || m === "coder") return m;
    if (cfg.get<boolean>("planMode", false)) return "plan";
    return "coder";
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "dist")],
    };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage(async (msg) => {
      switch (msg.type) {
        case "ready":
          // 前端（重新）加载完成：下发当前模型标签与模型下拉数据，并回灌已有对话（避免整窗重载后历史丢失）
          view.webview.postMessage({ type: "model_info", label: getActiveLabel() });
          view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
          view.webview.postMessage({ type: "agent_mode", mode: this.agentMode });
          const sbCfg = vscode.workspace.getConfiguration("freesek");
          const sbMode = sbCfg.get<"off" | "readonly" | "sandbox">("sandboxMode", "off");
          const sbPlan = commandExecPlan(resolveExecPolicy({ sandboxMode: sbMode, sandboxFailIfUnavailable: sbCfg.get<boolean>("sandboxFailIfUnavailable", false) })).plan;
          view.webview.postMessage({
            type: "sandbox_mode",
            mode: sbMode,
            osEngine: sbPlan.engine,
            osAvailable: sbPlan.osSandboxed || sbMode !== "sandbox",
          });
          // 下发当前设置项，供 webview「设置」面板初始化（对标 Codex/Claude Code 内嵌设置）
          {
            const cfgReady = vscode.workspace.getConfiguration("freesek");
            view.webview.postMessage({
              type: "settings",
              settings: {
                allowShell: cfgReady.get<boolean>("allowShell", false),
                allowNetwork: cfgReady.get<boolean>("allowNetwork", true),
                agentMode: this.agentMode,
                confirmFileWrites: cfgReady.get<boolean>("confirmFileWrites", false),
                autoFormat: cfgReady.get<boolean>("autoFormat", true),
                sandboxMode: cfgReady.get<string>("sandboxMode", "off"),
                contextBudget: cfgReady.get<number>("contextBudget", 32000),
                contextPlanner: cfgReady.get<"off" | "v1" | "v1.1" | "v1.2">("contextPlanner", "off"),
                contextPlannerBudget: cfgReady.get<number>("contextPlannerBudget", 3500),
                soundStart: cfgReady.get<boolean>("soundStart", true),
                soundDone: cfgReady.get<boolean>("soundDone", true),
                importAutoRead: cfgReady.get<boolean>("importAutoRead", true),
                theme: cfgReady.get<string>("theme", "default"),
              },
              skills: this.skillManager(this.workspaceRoot())
                .listAll()
                .map((s) => ({
                  name: s.name,
                  description: s.description,
                  triggers: s.triggers,
                  status: s.status,
                  builtin: !!s.builtin,
                })),
              pluginThemes: listInstalledThemes(this.workspaceRoot()),
            });
          }
          view.webview.postMessage({ type: "mcp_status", text: mcpManager.statusSummary() });
          this.pushMcpServers(view.webview);
          // 连接握手可能稍慢，2s 后再同步一次已发现的工具
          setTimeout(() => {
            view.webview.postMessage({ type: "mcp_status", text: mcpManager.statusSummary() });
            this.pushMcpServers(view.webview);
          }, 2000);
          if (this.conversation.length > 0) {
            view.webview.postMessage({
              type: "restore",
              messages: this.conversation,
              sessionId: this.currentSessionId,
            });
          }
          // 下发会话列表与当前会话标题，供 webview 左侧抽屉渲染
          const idxS = this.storage.loadIndex();
          view.webview.postMessage({
            type: "sessions",
            sessions: idxS.sessions.slice().sort((a, b) => b.updatedAt - a.updatedAt),
          });
          const curMeta = idxS.sessions.find((s) => s.id === this.currentSessionId);
          view.webview.postMessage({
            type: "session_title",
            title: curMeta?.title || "新对话",
            sessionId: this.currentSessionId,
          });
          // 下发当前目标（goal 状态机持久化于 .agent/.goal.json），供顶部「当前目标」面板渲染
          const initGoal = loadGoalState(this.workspaceRoot());
          if (initGoal.objective) {
            view.webview.postMessage({
              type: "goal",
              view: {
                objective: initGoal.objective,
                phase: initGoal.phase,
                roundsStarted: initGoal.roundsStarted,
                maxRounds: initGoal.maxRounds,
                blockedReason: initGoal.blockedReason,
              },
              sessionId: this.currentSessionId,
            });
          }
          this.pushRecentSessions(view.webview);
          // 消费定时任务/外部投递在面板未就绪时入队的消息
          if (this.pendingUserQueue.length > 0 && !this.running) {
            const queued = this.pendingUserQueue.shift()!;
            view.webview.postMessage({ type: "queue_state", pending: this.pendingUserQueue.length });
            if (this.injectedPending.delete(queued)) {
              view.webview.postMessage({ type: "user_injected", text: queued });
            }
            await this.handleUser(view.webview, queued);
          }
          break;
        case "user":
          // 对齐 CodeBuddy「等待队列」：Agent 正在回复/执行中时，新输入不丢、不入正在跑的会话，
          // 而是进入 pendingUserQueue，本轮结束后再作为下一条 user 消息自动发送。
          if (this.running) {
            this.pendingUserQueue.push(msg.text ?? "");
            view.webview.postMessage({
              type: "queue_state",
              pending: this.pendingUserQueue.length,
            });
          } else {
            await this.handleUser(view.webview, msg.text, msg.images);
          }
          break;
        case "edit_user_message":
          // 原位置编辑：截断到该条 user 消息并用新文本替换，删除其后的回复后重新发送
          await this.handleUser(view.webview, msg.text, undefined, msg.index);
          break;
        case "stop":
          this.abort?.abort();
          break;
        case "newChat":
          this.newChat(view.webview);
          break;
        case "history":
          await this.openHistory(view.webview);
          break;
        case "import_conversation":
          await this.importConversation(view.webview);
          break;
        case "switchModel":
          await this.switchModel();
          break;
        case "setMode": {
          const m = String(msg.mode || "");
          if (m === "plan" || m === "ask" || m === "craft" || m === "coder") this.setAgentMode(view.webview, m);
          break;
        }
        case "fork":
          this.forkSession(view.webview);
          break;
        case "openCommands":
          this.openCommands(view.webview);
          break;
        case "rename":
          this.renameSession(view.webview);
          break;
        case "get_sessions":
          view.webview.postMessage({
            type: "sessions",
            sessions: this.activeSessions(),
          });
          break;
        case "switch_session":
          this.switchSessionById(view.webview, String(msg.id));
          break;
        case "delete_session":
          this.deleteSessionById(String(msg.id));
          view.webview.postMessage({
            type: "sessions",
            sessions: this.activeSessions(),
          });
          break;
        case "rename_session":
          this.renameSessionById(String(msg.id), String(msg.title || ""));
          view.webview.postMessage({
            type: "sessions",
            sessions: this.activeSessions(),
          });
          break;
        case "archive_session":
          this.setSessionArchived(String(msg.id), true);
          view.webview.postMessage({
            type: "sessions",
            sessions: this.activeSessions(),
          });
          break;
        case "unarchive_session":
          this.setSessionArchived(String(msg.id), false);
          view.webview.postMessage({
            type: "sessions",
            sessions: this.activeSessions(),
          });
          break;
        case "list_archived":
          view.webview.postMessage({
            type: "archived_sessions",
            sessions: this.archivedSessions(),
          });
          break;
        case "permission_response":
          {
            const p = this.pendingPermissions.get(msg.id);
            if (!p) break;
            this.pendingPermissions.delete(msg.id);
            if (p.timer) clearTimeout(p.timer);
            const decision = String(msg.decision || "deny");
            if (decision === "allow_always" || decision === "deny_always") {
              const tool = String(msg.tool || "");
              const rule = `^${tool} `;
              const cfg = vscode.workspace.getConfiguration("freesek");
              const key = decision === "allow_always" ? "allowRules" : "denyRules";
              const list = (cfg.get<string[]>(key, []) || []).slice();
              if (!list.includes(rule)) list.push(rule);
              void cfg.update(key, list, vscode.ConfigurationTarget.Global);
              p.resolve({ allow: decision === "allow_always", persist: decision === "allow_always" ? "allow" : "deny" });
            } else {
              p.resolve({ allow: decision === "allow" });
            }
          }
          break;
        case "ask_choice":
          {
            // webview 内 ask_user 交互卡的作答：解析对应请求（id 匹配），返回给 agent 工具循环。
            const p = this.pendingAsks.get(msg.id);
            if (!p) break;
            this.pendingAsks.delete(msg.id);
            if (p.timer) clearTimeout(p.timer);
            p.resolve(String(msg.value ?? ""));
          }
          break;
        case "get_model_options":
          view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
          break;
        case "set_model":
          // 模型下拉选择：写入全局 activeModel，刷新 UI；Auto（智能选择）用 __auto__ 标记
          {
            const auto = String(msg.providerId || "") === "__auto__";
            setActiveSelection(
              auto
                ? { providerId: "__auto__", modelId: "__auto__" }
                : { providerId: String(msg.providerId || ""), modelId: String(msg.modelId || "") }
            );
            view.webview.postMessage({ type: "model_info", label: getActiveLabel() });
            view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
            vscode.window.showInformationMessage(auto ? "已切换到：Auto（智能选择）" : `已切换到：${String(msg.modelId)}（${String(msg.providerId)}）`);
          }
          break;
        case "open_provider_add":
          // 统一走 webview 内弹窗（前端 open_add_model 打开弹窗表单）
          view.webview.postMessage({ type: "open_add_model" });
          break;
        case "fetch_models":
          // 添加模型弹窗里「获取模型」：调用服务商 OpenAI 兼容接口实时拉取模型列表。
          // 候选路径与超时细节见 probeModels（与 test_connection 共用一套探测逻辑）。
          {
            const base = String(msg.baseUrl || "").trim().replace(/\/+$/, "");
            const reqId = String(msg.reqId || "");
            if (!base) {
              view.webview.postMessage({ type: "fetch_models_result", reqId, error: "Base URL 为空。" });
              break;
            }
            const r = await this.storage.probeModels(base, String(msg.apiKey || ""), "list");
            view.webview.postMessage({
              type: "fetch_models_result",
              reqId,
              ...(r.models
                ? { models: r.models }
                : { error: `拉取失败：${r.error || "未知错误"}` }),
            });
          }
          break;
        case "test_connection":
          // 「测试连接」：用 Base URL + API Key 探测接口可达性（GET /models），不消耗对话额度。
          // 区分：200/有效 JSON = 接口与 Key 均正常；401 = 路径正确但 Key 无效；404 = 路径错误。
          {
            const base = String(msg.baseUrl || "").trim().replace(/\/+$/, "");
            const reqId = String(msg.reqId || "");
            if (!base) {
              view.webview.postMessage({ type: "fetch_models_result", reqId, error: "Base URL 为空。" });
              break;
            }
            const r = await this.storage.probeModels(base, String(msg.apiKey || ""), "test");
            view.webview.postMessage({
              type: "fetch_models_result",
              reqId,
              ...(r.models
                ? { models: r.models }
                : { error: r.error || "接口不可达：所有候选路径均失败。请确认 Base URL 与网络。" }),
            });
          }
          break;
        case "delete_model":
          // 删除某提供商下的单个模型（便捷 UI：模型下拉项上的 × 按钮）
          {
            const providerId = String(msg.providerId || "");
            const modelId = String(msg.modelId || "");
            if (!providerId || !modelId) break;
            const cfg = vscode.workspace.getConfiguration("freesek");
            const list = (cfg.get<ProviderConfig[]>("providers", []) || []).slice();
            const idx = list.findIndex((p) => p.id === providerId);
            if (idx < 0) break;
            const before = list[idx].models.length;
            const nextModels = (list[idx].models || []).filter((m) => m.id !== modelId);
            if (nextModels.length === before) break; // 没变化
            list[idx] = { ...list[idx], models: nextModels };
            await cfg.update("providers", list, vscode.ConfigurationTarget.Global);
            // 若删除的是当前激活模型，回退到该 provider 的第一个剩余模型
            const sel = getActiveSelection();
            if (sel && sel.providerId === providerId && sel.modelId === modelId) {
              if (nextModels[0]?.id) setActiveSelection({ providerId, modelId: nextModels[0].id });
              else {
                // provider 已无模型：若还有其它 provider 则切过去
                const others = list.filter((p) => p.id !== providerId && (p.models || []).length);
                if (others[0]?.models[0]) {
                  setActiveSelection({ providerId: others[0].id, modelId: others[0].models[0].id });
                } else {
                  setActiveSelection({ providerId: "", modelId: "" });
                }
              }
            }
            view.webview.postMessage({ type: "model_info", label: getActiveLabel() });
            view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
          }
          break;
        case "delete_provider":
          // 删除整个提供商（便捷 UI：模型下拉分组上的删除按钮）
          {
            const providerId = String(msg.providerId || "");
            if (!providerId) break;
            const cfg = vscode.workspace.getConfiguration("freesek");
            const list = (cfg.get<ProviderConfig[]>("providers", []) || []).slice();
            const next = list.filter((p) => p.id !== providerId);
            if (next.length === list.length) break;
            await cfg.update("providers", next, vscode.ConfigurationTarget.Global);
            await deleteProviderSecret(this.context, providerId);
            // 若删除的是当前激活 provider，切到第一个剩余 provider 的首个模型
            const sel = getActiveSelection();
            if (sel && sel.providerId === providerId) {
              if (next[0]?.models[0]) setActiveSelection({ providerId: next[0].id, modelId: next[0].models[0].id });
              else setActiveSelection({ providerId: "", modelId: "" });
            }
            view.webview.postMessage({ type: "model_info", label: getActiveLabel() });
            view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
          }
          break;
        case "save_provider":
          // webview 内「添加提供商」弹窗表单提交：写入 freesek.providers
          {
            const name = String(msg.name || "").trim();
            const baseUrl = String(msg.baseUrl || "").trim().replace(/\/+$/, "");
            if (!name || !baseUrl) {
              view.webview.postMessage({ type: "context_status", text: "⚠ 提供商名称或 Base URL 为空。" });
              break;
            }
            const apiKey = String(msg.apiKey || "");
            const toolMode = msg.toolMode === "react" ? "react" : "native";
            const format: ProviderFormat = ["openai", "responses", "claude", "gemini"].includes(String(msg.format)) ? msg.format as ProviderFormat : "openai";
            const authType: AuthType = ["none", "bearer", "x-api-key", "x-goog-api-key"].includes(String(msg.authType)) ? msg.authType as AuthType : "bearer";
            const autoDiscover = !!msg.autoDiscover;
            const contextWindowRaw = String(msg.contextWindow || "").trim();
            const contextWindow = contextWindowRaw && /^\d+$/.test(contextWindowRaw) ? parseInt(contextWindowRaw, 10) : undefined;
            const models: Array<{ id: string; name?: string }> = String(msg.models || "")
              .split(/[,，\n]/)
              .map((s: string) => s.trim())
              .filter(Boolean)
              .map((s: string) => {
                const i = s.indexOf(":");
                return i > 0 ? { id: s.slice(0, i).trim(), name: s.slice(i + 1).trim() } : { id: s };
              });
            const id = "p-" + Date.now().toString(36);
            const secureApiKey = await storeProviderSecret(this.context, id, apiKey);
            const cfg = vscode.workspace.getConfiguration("freesek");
            const list = (cfg.get<ProviderConfig[]>("providers", []) || []).slice();
            const capabilities = msg.capabilities && typeof msg.capabilities === "object" && !Array.isArray(msg.capabilities)
              ? msg.capabilities as ModelCapabilities
              : undefined;
            list.push({
              id, name, baseUrl, apiKey: secureApiKey, toolMode,
              models,
              format,
              authType,
              ...(capabilities ? { capabilities } : {}),
              ...(format === "responses" && msg.storeResponses === true ? { storeResponses: true } : {}),
              ...(autoDiscover ? { autoDiscoverModels: true } : {}),
              ...(contextWindow ? { contextWindow } : {}),
            });
            await cfg.update("providers", list, vscode.ConfigurationTarget.Global);
            if (models[0]?.id) setActiveSelection({ providerId: id, modelId: models[0].id });
            view.webview.postMessage({ type: "model_info", label: getActiveLabel() });
            view.webview.postMessage({ type: "model_options", ...buildModelOptions() });
            view.webview.postMessage({ type: "context_status", text: `✅ 已添加提供商「${name}」并设为当前模型。` });
          }
          break;
        case "open_provider_doc": {
          // 打开扩展自身 README，避免跳到无关项目的占位链接。
          const readme = vscode.Uri.joinPath(this.context.extensionUri, "README.md");
          await vscode.commands.executeCommand("markdown.showPreview", readme);
          break;
        }
        case "open_provider_edit":
          await this.editProviders();
          break;
        case "schedules":
          // 侧边栏「定时任务」：直接打开添加流程（高频入口）；管理/运行/停用/删除仍可用命令面板 manageSchedules。
          // addSchedule/manageSchedules 实现在 activate.ts，这里转发命令，避免重复逻辑。
          await vscode.commands.executeCommand("freesek.addSchedule");
          break;
        case "manage_schedules":
          // 工具下拉菜单的「管理定时任务」：列出已建任务并支持运行/启用/删除
          await vscode.commands.executeCommand("freesek.manageSchedules");
          break;
        case "install_kit":
          await vscode.commands.executeCommand("freesek.installKit");
          break;
        case "manage_kits":
          // 工具下拉菜单/侧边栏「管理已装套件」：列出已安装套件并支持卸载
          await this.manageKits();
          break;
        case "start_free_server":
          await vscode.commands.executeCommand("freesek.startFreeServer");
          break;
        case "edit_providers":
          await this.editProviders();
          break;
        case "open_session_log":
          vscode.commands.executeCommand("freesek.chatView.focus");
          this.openSessionLog();
          break;
        case "hookify":
          // 侧边栏「规则」入口：Hookify 规则管理（列出/新建/编辑/启停/删除），复用命令
          await vscode.commands.executeCommand("freesek.manageHookifyRules");
          break;
        case "open_link":
          // webview 内点击外部链接 → 用系统浏览器打开（仅放行 http/https）
          {
            const u = String(msg.url || "");
            if (u.startsWith("http://") || u.startsWith("https://")) {
              vscode.env.openExternal(vscode.Uri.parse(u));
            }
          }
          break;
        case "add_context":
          // 把当前活动编辑器的文件 / 选区作为上下文提供给对话（对标 Claude Code 文件上下文）
          {
            const ed = vscode.window.activeTextEditor;
            if (!ed) {
              view.webview.postMessage({ type: "context_added", error: "当前没有打开的代码文件，无法附加上下文。" });
              break;
            }
            const doc = ed.document;
            const file = doc.uri.fsPath;
            const language = doc.languageId;
            const sel = ed.selection;
            let selection: { text: string; start: number; end: number } | undefined;
            if (!sel.isEmpty) {
              selection = { text: doc.getText(sel), start: sel.start.line + 1, end: sel.end.line + 1 };
            }
            view.webview.postMessage({ type: "context_added", file, language, selection });
          }
          break;
        case "diff_accept":
          // 用户接受该次编辑：仅从待决表移除（文件已是 applied 内容，无需额外操作）
          this.pendingEdits.delete(String(msg.id || ""));
          view.webview.postMessage({ type: "diff_state", id: String(msg.id || ""), state: "accepted" });
          break;
        case "diff_revert":
          this.revertPendingEdit(view.webview, String(msg.id || ""));
          break;
        case "open_file":
          // 点击 diff 卡的行号 / 文件名 → 在编辑器中打开并定位行（对标 Codex 对话内 diff 跳转）
          {
            const fp = String(msg.file || "");
            const line = Number(msg.line || 1) || 1;
            if (!fp) break;
            try {
              const uri = vscode.Uri.file(fp);
              const doc = await vscode.workspace.openTextDocument(uri);
              const ed = await vscode.window.showTextDocument(doc, { preview: false, preserveFocus: false });
              const pos = new vscode.Position(Math.max(0, line - 1), 0);
              ed.selection = new vscode.Selection(pos, pos);
              ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            } catch (e: any) {
              view.webview.postMessage({ type: "context_status", text: "⚠ 无法打开文件：" + fp });
            }
          }
          break;
        case "update_setting":
          // webview「设置」面板回写配置（仅放行白名单键，写入用户级 settings）
          {
            const key = String(msg.key || "");
            const allowed = ["allowShell", "allowNetwork", "agentMode", "confirmFileWrites", "autoFormat", "sandboxMode", "contextBudget", "contextPlanner", "contextPlannerBudget", "soundStart", "soundDone", "importAutoRead", "theme"];
            if (!allowed.includes(key)) break;
            const cfg = vscode.workspace.getConfiguration("freesek");
            let v = msg.value;
            if (key === "contextBudget") v = parseInt(String(v), 10) || 32000; // 兜底对齐配置默认 32000
            if (key === "contextPlannerBudget") v = Math.min(12000, Math.max(256, parseInt(String(v), 10) || 3500));
            if (key === "contextPlanner" && !["off", "v1", "v1.1", "v1.2"].includes(String(v))) v = "off";
            if (key === "theme") {
              const t = String(v || "default");
              const builtin = ["default", "genshin", "wuthering", "academic", "industrial"];
              const pluginOk = listInstalledThemes(this.workspaceRoot()).some((p) => p.name === t);
              if (!builtin.includes(t) && !pluginOk) break;
              v = t;
              await cfg.update(key, t, vscode.ConfigurationTarget.Global);
              view.webview.postMessage({ type: "theme", theme: t });
              view.webview.postMessage({ type: "context_status", text: `已切换主题：${t}` });
              break;
            }
            if (key === "agentMode") {
              const m = String(v || "");
              if (m === "plan" || m === "ask" || m === "craft" || m === "coder") this.setAgentMode(view.webview, m);
              break;
            }
            await cfg.update(key, v, vscode.ConfigurationTarget.Global);
            if (key === "sandboxMode") {
              const sbCfg2 = vscode.workspace.getConfiguration("freesek");
              const sbMode2 = sbCfg2.get<"off" | "readonly" | "sandbox">("sandboxMode", "off");
              const sbExec2 = commandExecPlan(resolveExecPolicy({ sandboxMode: sbMode2, sandboxFailIfUnavailable: sbCfg2.get<boolean>("sandboxFailIfUnavailable", false) }));
              view.webview.postMessage({
                type: "sandbox_mode",
                mode: sbMode2,
                osEngine: sbExec2.osEngine,
                osAvailable: true,
              });
            }
            view.webview.postMessage({ type: "context_status", text: `已更新设置：${key}` });
          }
          break;
        // ── 技能进化闭环：审计 / 激活 / 停用 / 删除 / 去重 ──
        case "list_skills": {
          const skills = this.skillManager(this.workspaceRoot()).listAll().map((s) => ({
            name: s.name,
            description: s.description,
            triggers: s.triggers,
            status: s.status,
            builtin: !!s.builtin,
          }));
          view.webview.postMessage({ type: "skills_list", skills });
          break;
        }
        case "activate_skill": {
          const r = this.skillManager(this.workspaceRoot()).setStatus(String(msg.name || ""), "active");
          view.webview.postMessage({ type: "context_status", text: r.message });
          this.pushSkillList(view.webview);
          break;
        }
        case "deactivate_skill": {
          const r = this.skillManager(this.workspaceRoot()).setStatus(String(msg.name || ""), "pending");
          view.webview.postMessage({ type: "context_status", text: r.message });
          this.pushSkillList(view.webview);
          break;
        }
        case "delete_skill": {
          const r = this.skillManager(this.workspaceRoot()).delete(String(msg.name || ""));
          view.webview.postMessage({ type: "context_status", text: r.message });
          this.pushSkillList(view.webview);
          break;
        }
        case "dedupe_skills": {
          const r = this.skillManager(this.workspaceRoot()).dedupe();
          if (r.removed.length) {
            view.webview.postMessage({
              type: "context_status",
              text: `🧹 技能去重完成：合并 ${r.removed.length} 条重复技能（${r.removed.join("、")} → 保留 ${[...new Set(r.kept)].join("、")}）`,
            });
          } else {
            view.webview.postMessage({ type: "context_status", text: "🧹 技能去重：未发现高相似重复技能。" });
          }
          this.pushSkillList(view.webview);
          break;
        }
        // ── MCP 管理：查询 / 重连 ──
        case "list_mcp": {
          this.pushMcpServers(view.webview);
          break;
        }
        case "reconnect_mcp": {
          view.webview.postMessage({ type: "context_status", text: "正在重新连接 MCP server…" });
          void mcpManager
            .reconnect(this.getMcpConfig())
            .then(() => {
              view.webview.postMessage({ type: "mcp_status", text: mcpManager.statusSummary() });
              this.pushMcpServers(view.webview);
              view.webview.postMessage({ type: "context_status", text: mcpManager.statusSummary() });
            });
          break;
        }
        case "attach_file":
          // @ 提及文件：读取文件内容注入对话（对标 Claude Code @file 直接把内容带给模型）
          {
            const fp = String(msg.file || "");
            if (!fp) {
              view.webview.postMessage({ type: "file_attached", error: "文件路径为空。" });
              break;
            }
            try {
              const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
              const abs = path.isAbsolute(fp) ? fp : path.join(root, fp);
              const rel = path.relative(root, abs);
              if (rel.startsWith("..") && !path.isAbsolute(fp)) {
                view.webview.postMessage({ type: "file_attached", error: "路径越界，禁止读取工作区外文件。" });
                break;
              }
              const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(abs));
              const content = doc.getText();
              // 超大文件避免撑爆上下文：只附前 300 行并提示
              const lines = content.split("\n");
              const truncated = lines.length > 300;
              const body = truncated ? lines.slice(0, 300).join("\n") : content;
              view.webview.postMessage({
                type: "file_attached",
                file: rel.startsWith("..") ? abs : rel,
                language: doc.languageId,
                content: body,
                truncated,
                totalLines: lines.length,
              });
            } catch (e: any) {
              view.webview.postMessage({ type: "file_attached", error: `无法读取文件：${e?.message ?? String(e)}` });
            }
          }
          break;
        case "list_files":
          {
            const q = String(msg.query || "").toLowerCase();
            try {
              const uris = await vscode.workspace.findFiles(
                "**/*",
                "**/node_modules/**|**/.git/**|**/dist/**|**/out/**|**/.vscode/**|**/build/**",
                500
              );
              const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || "";
              let files = uris
                .map((u) => (root ? path.relative(root, u.fsPath) : u.fsPath))
                .filter((f) => !f.startsWith("..") && !path.isAbsolute(f));
              if (q) files = files.filter((f) => f.toLowerCase().includes(q));
              files.sort();
              files = files.slice(0, 80);
              view.webview.postMessage({ type: "file_list", files });
            } catch {
              view.webview.postMessage({ type: "file_list", files: [] });
            }
          }
          break;
        case "export_chat":
          {
            const fmt = String(msg.format || "md").toLowerCase();
            const messages = Array.isArray(msg.messages) ? msg.messages : [];
            const stamp = new Date().toLocaleString("zh-CN");
            let content = "";
            let defaultName = "freesek-chat";
            let filters: { [name: string]: string[] };
            if (fmt === "json") {
              content = JSON.stringify({ exportedAt: new Date().toISOString(), messageCount: messages.length, messages }, null, 2);
              defaultName += ".json";
              filters = { JSON: ["json"] };
            } else {
              const lines: string[] = ["# FreeSeek 对话导出", "", `> 导出时间：${stamp} · 共 ${messages.length} 条消息`, ""];
              for (const m of messages as Array<{ role?: string; content?: string }>) {
                const role = m.role === "user" ? "👤 用户" : m.role === "assistant" ? "🐋 FreeSeek" : "📎 系统";
                lines.push(`## ${role}`, "", (m.content || "").trim(), "");
              }
              content = lines.join("\n");
              defaultName += ".md";
              filters = { Markdown: ["md"] };
            }
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || (process.env.HOME || process.env.USERPROFILE || ".");
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(root, defaultName)),
              filters,
            });
            if (!uri) {
              view.webview.postMessage({ type: "context_status", text: "已取消导出。" });
              break;
            }
            await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
            view.webview.postMessage({ type: "context_status", text: `已导出对话到 ${uri.fsPath}` });
          }
          break;
        case "import_chat":
          // 历史对话 JSON 导入（对齐 CodeBuddy：备份/迁移/分享对话记录）
          {
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || (process.env.HOME || process.env.USERPROFILE || ".");
            const uri = await vscode.window.showOpenDialog({
              title: "选择要导入的 FreeSeek 对话 JSON",
              defaultUri: vscode.Uri.file(root),
              filters: { JSON: ["json"] },
            });
            if (!uri || uri.length === 0) break;
            try {
              const raw = await vscode.workspace.fs.readFile(uri[0]);
              const j = JSON.parse(Buffer.from(raw).toString("utf8"));
              const msgs: Array<{ role?: string; content?: string; images?: string[] }> = Array.isArray(j)
                ? j
                : Array.isArray(j.messages)
                  ? j.messages
                  : [];
              const valid = msgs.filter(
                (m) =>
                  typeof m === "object" &&
                  (m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "tool") &&
                  typeof m.content === "string"
              );
              if (!valid.length) {
                view.webview.postMessage({ type: "context_status", text: "⚠️ 该文件不是有效的 FreeSeek 对话 JSON（缺少 messages）。" });
                break;
              }
              // 载入为全新会话
              this.conversation = valid.map((m) => ({
                role: m.role as ChatMessage["role"],
                content: m.content ?? "",
                ...(m.images?.length ? { images: m.images } : {}),
              }));
              this.currentSessionId = makeId();
              this.pendingEdits.clear();
              this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
              view.webview.postMessage({
                type: "restore",
                messages: this.conversation,
                sessionId: this.currentSessionId,
              });
              view.webview.postMessage({
                type: "session_title",
                title: "导入的对话",
                sessionId: this.currentSessionId,
              });
              view.webview.postMessage({ type: "context_status", text: `✅ 已导入 ${valid.length} 条消息（${uri[0].fsPath}）` });
              vscode.commands.executeCommand("freesek.chatView.focus");
            } catch (e: any) {
              view.webview.postMessage({ type: "context_status", text: `⚠️ 导入失败：${e?.message ?? String(e)}` });
            }
          }
          break;
        case "summarize_chat":
          // /summarize：生成当前对话的结构化摘要（对齐 CodeBuddy 1.2.9 显式汇总指令）
          {
            const conv = this.conversation;
            const recent = conv
              .filter((m) => m.role !== "system")
              .slice(-30)
              .map((m) => `[${m.role}] ${String(m.content ?? "").slice(0, 400)}`)
              .join("\n");
            if (!recent.trim()) {
              view.webview.postMessage({ type: "context_status", text: "暂无对话内容可汇总。" });
              break;
            }
            view.webview.postMessage({ type: "context_status", text: "正在生成对话摘要…" });
            try {
              const summary = await reflectConversation(
                `请把以下编程助手对话历史生成一份结构化中文摘要（若历史以代码为主，务必保留文件路径与符号名）：\n\n${recent}`
              );
              view.webview.postMessage({
                type: "assistant_message",
                text: summary?.trim() || "未能生成摘要（模型未返回内容）。",
              });
            } catch (e: any) {
              view.webview.postMessage({
                type: "context_status",
                text: `摘要生成失败：${e?.message ?? String(e)}`,
              });
            }
          }
          break;
        case "compact":
          {
            const root = this.workspaceRoot();
            const convOnly = this.conversation.filter((m) => m.role !== "system");
            if (convOnly.length <= 12 + 16) {
              view.webview.postMessage({ type: "context_status", text: "对话还很短，暂无需压缩。" });
              break;
            }
            // PreCompact Hook：先钉住任务目标（跨压缩持久）
            const pre = await preCompactHook(this.conversation, root);
            if (pre) view.webview.postMessage({ type: "context_status", text: pre });
            view.webview.postMessage({ type: "context_status", text: "正在分层压缩历史并抽取持久记忆…" });
            this.conversation = await tieredCompact(
              this.conversation,
              (t) => view.webview.postMessage({ type: "context_status", text: t }),
              12,
              16,
              async (oldText) => {
                // 压缩前抽取持久事实写入记忆（有损→无损）
                const r = await extractDurableMemory(oldText, root, this.storage.userMemoryPath());
                if (r.count > 0) {
                  view.webview.postMessage({
                    type: "context_status",
                    text: `🧠 已从压缩历史抽取 ${r.count} 条持久记忆`,
                  });
                }
              }
            );
            // 刷新系统提示词，使新抽取的记忆立即注入（loadMemorySection 会读记忆文件）
            if (this.conversation[0]?.role === "system") {
              this.conversation[0].content = this.buildSystemPrompt(root);
            }
            view.webview.postMessage({ type: "restore", messages: this.conversation });
            const budget = vscode.workspace
              .getConfiguration("freesek")
              .get<number>("contextBudget", 32000);
            view.webview.postMessage({
              type: "observability",
              turns: 0,
              tokens: conversationTokens(this.conversation),
              ratio: usageRatio(this.conversation, budget),
              cost: 0,
              memoryCount: countMemories(root, this.storage.userMemoryPath()),
            });
            view.webview.postMessage({
              type: "context_status",
              text: "✅ 已分层压缩上下文（非截断），并固化持久记忆。",
            });
            this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
          }
          break;
        case "memory_view":
          {
            const root = this.workspaceRoot();
            const dir = path.join(root, ".agent", "memory");
            const userMd = path.join(this.storage.userMemoryPath(), "USER.md");
            let target = "";
            try {
              if (fs.existsSync(dir)) {
                const files = fs
                  .readdirSync(dir)
                  .filter((f) => f.endsWith(".md"))
                  .sort();
                if (files.length) target = path.join(dir, files[files.length - 1]);
              }
            } catch {
              /* 忽略 */
            }
            if (!target && fs.existsSync(userMd)) target = userMd;
            if (target) {
              await vscode.window.showTextDocument(vscode.Uri.file(target));
              view.webview.postMessage({
                type: "context_status",
                text: "已打开持久记忆文件，可手动编辑。",
              });
            } else {
              view.webview.postMessage({
                type: "context_status",
                text: "暂无持久记忆。对话中可让 Agent 用 remember 工具，或压缩时会自动抽取。",
              });
            }
          }
          break;
        case "clear_memory":
          {
            const root = this.workspaceRoot();
            const removed = clearProjectMemory(root);
            const msg2 = removed > 0
              ? `已清空项目持久记忆（删除 ${removed} 个记忆文件）。压缩前不会再注入这些条目。`
              : "项目记忆目录为空，无需清空。";
            view.webview.postMessage({ type: "context_status", text: msg2 });
          }
          break;
      }
    });
  }

  /**
   * 回滚一次待决编辑（对话内 diff 卡「↩ 回滚」）：
   * 仅当磁盘内容仍等于该次编辑后的内容（未被后续修改覆盖）时执行，
   * 恢复为编辑前内容；create 型编辑则删除该新建文件。
   */
  private revertPendingEdit(webview: vscode.Webview, id: string) {
    const rec = this.pendingEdits.get(id);
    if (!rec) {
      webview.postMessage({ type: "diff_state", id, state: "gone" });
      return;
    }
    try {
      const cur = fs.existsSync(rec.path) ? fs.readFileSync(rec.path, "utf8") : "";
      if (cur !== rec.applied) {
        webview.postMessage({
          type: "diff_state",
          id,
          state: "failed",
          note: "该文件在本次修改后又发生了改动，为避免覆盖后续修改，已取消自动回滚。",
        });
        return;
      }
      if (rec.kind === "create") {
        fs.unlinkSync(rec.path);
      } else {
        fs.writeFileSync(rec.path, rec.original, "utf8");
      }
      this.pendingEdits.delete(id);
      this.refreshOpenDocument(rec.path);
      webview.postMessage({
        type: "diff_state",
        id,
        state: "reverted",
        note: rec.kind === "create" ? "已删除新建的文件" : "已恢复为修改前内容",
      });
    } catch (e: any) {
      webview.postMessage({
        type: "diff_state",
        id,
        state: "failed",
        note: `回滚失败：${e?.message ?? String(e)}`,
      });
    }
  }

  /** 若回滚/接受涉及的文件正被编辑器打开且无未保存改动，重载其磁盘内容。 */
  private refreshOpenDocument(fp: string) {
    const uri = vscode.Uri.file(fp);
    const ed = vscode.window.visibleTextEditors.find((e) => e.document.uri.fsPath === fp);
    if (ed && !ed.document.isDirty) {
      void vscode.commands
        .executeCommand("workbench.action.files.revert", uri)
        .then(() => {}, () => {});
    }
  }

  private async handleUser(webview: vscode.Webview, text: string, images?: string[], editIndex?: number) {
    this.running = true;
    const root = this.workspaceRoot();
    // run 一开始就绑定 session 日志：buildSystemPrompt / hook / 后台任务都不得依赖可变的 UI 当前会话。
    const runSessionId = this.currentSessionId;
    const runEventLog = ensureEventLog(this.storage.historyDir(), runSessionId);
    // 通用防线：上一次若在工具执行中途被停止/出错，可能残留「无配对的 tool 消息」或
    // 「携带 tool_calls 但无结果的 assistant 消息」，回滚掉这段未完成回合，保证下次
    // 请求满足 tool 消息前必须有 tool_calls 的协议约束（否则 400）。
    this.conversation = trimUnfinishedTurn(this.conversation);
    // 轻量刷新系统提示词中的「当前时间」片段（长会话中模型保持时间感知，无需重建整段 prompt）
    if (this.conversation.length && this.conversation[0].role === "system") {
      this.conversation[0].content = refreshPromptTime(this.conversation[0].content);
    }
    if (editIndex !== undefined) {
      // —— 原位置编辑：截断到该条 user 消息，替换文本并删除其后的所有回复 ——
      const idx = Number(editIndex);
      const target = this.conversation[idx];
      if (!target || target.role !== "user" || !text.trim()) {
        webview.postMessage({ type: "error", message: "编辑失败：找不到要修改的消息，或内容为空。" });
        return;
      }
      this.conversation = this.conversation.slice(0, idx);
      const edited: ChatMessage = { role: "user", content: text };
      if (images && images.length > 0) edited.images = images;
      this.conversation.push(edited);
      // 通知前端重绘为截断后的历史，并保持运行态（editing=true），随后流式回复继续追加
      webview.postMessage({
        type: "restore",
        messages: this.conversation,
        sessionId: this.currentSessionId,
        editing: true,
      });
    } else {
      if (!this.conversation.length) {
        this.conversation.push({ role: "system", content: this.buildSystemPrompt(root) });
        // SessionStart Hook：会话起点自动加载项目约定，状态栏提示已加载哪些
        const note = await sessionStartHook(root);
        if (note) webview.postMessage({ type: "context_status", text: note });
      }
      // UserPromptSubmit Hook：hookify prompt 事件规则（warn/block 提示回灌用户）
      const hooked = await userPromptSubmitHook(text, root);
      let effectiveText = hooked.text;
      if (hooked.note) {
        webview.postMessage({ type: "context_status", text: hooked.note });
        if (hooked.note.startsWith("⛔")) {
          // prompt 级 block：不进入模型，直接返回
          webview.postMessage({
            type: "done",
            sessionId: this.currentSessionId,
            streaming: false,
            content: "",
            abort: false,
            reason: "hookify-prompt-block",
          });
          return;
        }
      }
      const userMsg: ChatMessage = { role: "user", content: effectiveText };
      if (images && images.length > 0) userMsg.images = images;
      this.conversation.push(userMsg);
    }
    // 事件源日志记录真正进入模型历史的 user message（hook 改写后的文本）；
    // 图片通过 SessionEventLog 的 SHA-256 content store 去重持久化，可用于 crash recovery/replay。
    const modelUser = this.conversation[this.conversation.length - 1];
    if (modelUser?.role === "user") {
      projectSessionTitle(summarizeTaskText(String(modelUser.content ?? ""), 80), runSessionId);
      const logged = runEventLog.persistMessage(modelUser);
      runEventLog.append("user/message", { ...logged, edited: editIndex !== undefined }, "main");
    }
    // 重置本次回合的文件统计（供文件列表面板渲染）
    this.runFiles.set(runSessionId, new Map());

    // 本次请求的 abort controller（局部引用，避免后续 newChat/新请求替换 this.abort 后竞态误判）
    const runAbort = new AbortController();
    this.abort = runAbort;
    // 记录本会话的后台 abort（切走继续执行时仍可通过它停止该后台会话）
    this.backgroundAborts.set(runSessionId, runAbort);

    // 确保 MCP 已连接（best-effort，首次同步/恢复后触发）
    void mcpManager.connectFromConfig(() =>
      (vscode.workspace.getConfiguration("freesek").get<McpServerConfig[]>("mcpServers", []) || [])
    );

    const cfg0 = vscode.workspace.getConfiguration("freesek");
    const sandboxNetwork = cfg0.get<any>("sandboxNetwork", {});
    const sandboxFailIfUnavailable = cfg0.get<boolean>("sandboxFailIfUnavailable", false);
    // 软降级提示：sandbox 档但 OS 引擎缺失（如 Windows 无原生沙箱）→ 仅本次会话提示一次
    if (cfg0.get<string>("sandboxMode", "off") === "sandbox") {
      const sp = commandExecPlan(resolveExecPolicy({ sandboxMode: "sandbox", sandboxFailIfUnavailable })).plan;
      if (!sp.osSandboxed && !sp.blocked && sp.warning) {
        vscode.window.showWarningMessage("FreeSeek 沙箱：" + sp.warning);
      }
    }
    const cb: AgentCallbacks = {
      onAssistantText: (d) =>
        webview.postMessage({ type: "assistant_delta", text: d, sessionId: runSessionId }),
      onReasoning: (d) =>
        webview.postMessage({ type: "reasoning_delta", text: d, sessionId: runSessionId }),
      onToolStart: (call) =>
        webview.postMessage({
          type: "tool_start",
          name: call.function.name,
          args: call.function.arguments,
          sessionId: runSessionId,
        }),
      onToolResult: (call, result) =>
        webview.postMessage({
          type: "tool_result",
          name: call.function.name,
          result,
          sessionId: runSessionId,
        }),
      onStep: (_step, t) => webview.postMessage({ type: "step", text: t, sessionId: runSessionId }),
      onStripToolCall: () => webview.postMessage({ type: "strip_toolcall", sessionId: runSessionId }),
      onContextStatus: (t) =>
        webview.postMessage({ type: "context_status", text: t, sessionId: runSessionId }),
      onTodos: (items) => webview.postMessage({ type: "todos", items, sessionId: runSessionId }),
      onGoal: (view) => webview.postMessage({ type: "goal", view, sessionId: runSessionId }),
      onSubAgentStart: (name, task) =>
        webview.postMessage({ type: "subagent_start", name, task, sessionId: runSessionId }),
      onSubAgentTool: (name, args) =>
        webview.postMessage({ type: "subagent_tool", name, args, sessionId: runSessionId }),
      onSubAgentResult: (name, result) =>
        webview.postMessage({ type: "subagent_result", name, result, sessionId: runSessionId }),
      onSubAgentEnd: (report) =>
        webview.postMessage({ type: "subagent_end", report, sessionId: runSessionId }),
      onObservability: (s) =>
        webview.postMessage({
          type: "observability",
          turns: s.turns,
          tokens: s.tokens,
          ratio: s.ratio,
          cost: s.cost,
          memoryCount: countMemories(root, this.storage.userMemoryPath()),
          sessionId: runSessionId,
        }),
      onNotification: (n) =>
        webview.postMessage({
          type: "task_notification",
          title: n.title,
          body: n.body,
          sessionId: runSessionId,
        }),
      // ToolRuntime 决定“是否需要审批”；扩展层只负责呈现 UI 并回传用户选择。
      // 这样新增工具时只改 tool-runtime-spec.ts，不再维护第二份工具名风险表。
      onPermissionRequest: async (toolName: string, input: any) =>
        this.requestPermission(webview, toolName, input),
      signal: runAbort.signal,
    };

    // 快速问答模式（chit-chat fast path）：用户消息为简短问候/闲聊且会话刚起步时，
    // 不携带 13+ 工具定义、并精简系统提示词——本地小模型（LM Studio 8K 无 prefix cache）
    // 为一句"你好"也要 prefill 近万 token 是"简答也卡顿"的直接原因。
    const chitChat =
      isChitChat(text) &&
      this.conversation.filter((m) => m.role !== "system").length <= 2;
    let runMsgs = this.conversation;
    let runTools = getAllToolDefinitions();
    if (chitChat) {
      runMsgs = this.conversation.map((m) => ({ ...m }));
      if (runMsgs.length && runMsgs[0].role === "system") {
        runMsgs[0].content = this.buildChitChatPrompt(root);
      }
      runTools = [];
    }

    // 任务清单自动种子：模型若不主动调用 todo_write（实际很常见），任务列表面板不应空白。
    // 从用户消息派生一个「进行中」任务并立即推送到前端；模型后续调用 todo_write 会用自己规划整体替换。
    const seedTask = chitChat ? "" : summarizeTaskText(text);
    const todoAutoSeeded = seedTask !== "";
    const todoState: TodoState = {
      items: todoAutoSeeded ? [{ content: seedTask, status: "in_progress" }] : [],
    };
    if (todoAutoSeeded) {
      webview.postMessage({ type: "todos", items: todoState.items, sessionId: runSessionId });
    }

    // 文件列表面板：从 runMap 汇总广播给前端（onFileDiff / onFileRead 共用）
    const pushRunFiles = () => {
      const runMap = this.runFiles.get(runSessionId) || new Map();
      const files = Array.from(runMap.entries()).map(([file, v]) => ({
        file,
        added: v.added,
        removed: v.removed,
        kind: v.kind,
        ids: v.ids,
        reads: v.reads,
      }));
      webview.postMessage({ type: "files", files, sessionId: runSessionId });
    };

    try {
      const result = await runAgent(
        runMsgs,
        runTools,
        {
          workspaceRoot: root,
          runtime: {
            maxSteps: cfg0.get<number>("maxSteps", 25),
            contextBudget: cfg0.get<number>("contextBudget", 32000),
            contextPlanner: cfg0.get<"off" | "v1" | "v1.1" | "v1.2">("contextPlanner", "off"),
            contextPlannerBudget: cfg0.get<number>("contextPlannerBudget", 3500),
            maxWallClockMs: cfg0.get<number>("maxWallClockMs", 10 * 60 * 1000),
            autoCheckpoint: cfg0.get<boolean>("autoCheckpoint", true),
            offloadThreshold: cfg0.get<number>("offloadThreshold", 50000),
            autoFormat: cfg0.get<boolean>("autoFormat", true),
          },
          allowShell: cfg0.get<boolean>("allowShell", false),
          confirmFileWrites: cfg0.get<boolean>("confirmFileWrites", false),
          allowNetwork: cfg0.get<boolean>("allowNetwork", true),
          askUser: async (req: AskRequest) => {
            // 结构化问答（对齐 Claude Code Interactive Questions）：
            // 前台会话 → 在 webview 聊天区内渲染交互卡（选项按钮 / 自由文本输入），
            // 让提问直接出现在对话流里，而不是弹原生 QuickPick。
            if (runSessionId === this.currentSessionId) {
              try {
                return await this.askUserInWebview(webview, req, runAbort.signal);
              } catch {
                // webview 不可用（面板已关闭/重置）→ 退回原生输入，避免 agent 循环悬挂
              }
            }
            // 后台会话（用户已切走）或 webview 不可用 → 原生 QuickPick / InputBox 兜底
            return this.askUserNative(req);
          },
          skillManager: this.skillManager(root),
          promoteSkill: (name) => {
            // 技能自动激活（验证门控）：模型用 pending 技能完成真实任务并通过 verify 后激活
            const r = this.skillManager(root).setStatus(name, "active");
            if (r.ok) {
              this.pushSkillList(webview);
              webview.postMessage({ type: "context_status", text: `✅ 技能已通过验证并激活：${name}` });
            }
            return r.message;
          },
          requestMCPApproval: async (toolName, desc) => {
            // MCP 工具独立审批（对齐 CodeBuddy）：首次调用弹窗，用户选择允许/允许本次/拒绝
            const pick = await vscode.window.showQuickPick(
              [
                { label: "允许（本次会话内始终允许）", detail: toolName },
                { label: "允许本次", detail: "仅允许这一次调用" },
                { label: "拒绝", detail: "本次会话内拒绝该工具" },
              ],
              {
                title: `🔌 是否允许调用外部 MCP 工具？`,
                placeHolder: toolName + (desc ? `\n参数: ${desc.slice(0, 200)}` : ""),
                ignoreFocusOut: true,
              }
            );
            if (!pick) return "";
            if (pick.label.startsWith("允许本次")) return "once";
            if (pick.label.startsWith("拒绝")) return "";
            return "allow";
          },
          confirmCommand: async (name, desc) => {
            // 指令审核：Agent 执行自定义 Slash 命令前弹窗确认（命令可能含危险操作）
            const choice = await vscode.window.showWarningMessage(
              `Agent 请求执行 Slash 命令「/${name}」\n\n${desc || "执行该自定义命令。"}`,
              { modal: false },
              "允许执行",
              "拒绝"
            );
            return choice === "允许执行";
          },
          todoState,
          goalState: loadGoalState(root), // 目标状态机：跨会话持久，恢复会话自动续行
          canSpawn: true,
          userMemoryPath: this.storage.userMemoryPath(),
          planMode: this.agentMode === "plan",
          agentMode: this.agentMode,
          sandboxMode: cfg0.get<"off" | "readonly" | "sandbox">("sandboxMode", "off"),
          commandTimeout: cfg0.get<number>("commandTimeout", 120000),
          sandboxNetwork,
          sandboxFailIfUnavailable,
          allowRules: cfg0.get<string[]>("allowRules", []),
          denyRules: cfg0.get<string[]>("denyRules", []),
          allowCommandHooks: cfg0.get<boolean>("allowCommandHooks", false),
          offloadDir: path.join(this.storage.historyDir(), "offload"),
          checkpointDir: path.join(this.context.globalStorageUri.fsPath, "checkpoints"),
          signal: runAbort.signal,
          eventLog: runEventLog,
          eventActor: "main",
          extensionRuntime: this.extensionRuntime,
          // 文件修改痕迹（diff）：write_file/edit_file 执行后向 webview 推送 unified diff，
          // 供前端渲染「修改痕迹」卡片（红绿对照 + +N -M 统计 + 接受/回滚），不直接进模型上下文。
          onFileDiff: (info) => {
            // delete 无回滚语义（回收站可恢复），不登记 pendingEdits，仅进文件列表面板
            if (info.kind !== "delete") {
              this.pendingEdits.set(info.id, {
                id: info.id,
                path: info.path,
                kind: info.kind,
                original: info.original,
                applied: info.applied,
              });
            }
            // 累加当前回合的文件统计（供文件列表面板）；key 用展示路径（模型传入的原样参数）
            const runMap = this.runFiles.get(runSessionId) || new Map();
            const key = info.file || info.path;
            const ex = runMap.get(key);
            if (ex) {
              ex.added += info.added;
              ex.removed += info.removed;
              ex.kind = info.kind;
              ex.ids.push(info.id);
            } else {
              runMap.set(key, {
                added: info.added,
                removed: info.removed,
                kind: info.kind,
                ids: [info.id],
                reads: 0,
              });
            }
            this.runFiles.set(runSessionId, runMap);
            webview.postMessage({ type: "file_diff", ...info, sessionId: runSessionId });
            // 推送汇总（每次 diff 都广播一份，供文件列表面板实时更新）
            pushRunFiles();
          },
          // 读取痕迹：read_file 成功读取后累计（kind=read，reads=N 次），文件列表面板实时可见
          onFileRead: (file, path) => {
            const runMap = this.runFiles.get(runSessionId) || new Map();
            const key = file || path;
            const ex = runMap.get(key);
            if (ex) {
              ex.reads += 1;
              // 已读又被修改：保留修改的 kind，不降级为 read
            } else {
              runMap.set(key, { added: 0, removed: 0, kind: "read", ids: [], reads: 1 });
            }
            this.runFiles.set(runSessionId, runMap);
            pushRunFiles();
          },
          // run_python 生成的图表（matplotlib 等）回传 webview 渲染进聊天
          onPythonCharts: (charts) => {
            if (charts && charts.length) {
              webview.postMessage({ type: "python_chart", charts, sessionId: runSessionId });
            }
          },
          // browser 工具截图回传 webview 渲染进聊天（复用图表渲染通路）
          onBrowserShot: (shots) => {
            if (shots && shots.length) {
              webview.postMessage({ type: "python_chart", charts: shots, sessionId: runSessionId });
            }
          },
        },
        cb
      );
      // 快速问答用的是精简 system：回合结束后恢复完整系统提示词，供后续正常任务使用
      // （不要污染持久会话——否则下一轮会丢失工具协议/工作流等关键指引）。
      if (chitChat && result.length && result[0].role === "system") {
        result[0].content = this.buildSystemPrompt(root);
      }
      // 会话归属判断：任务期间用户可能已切到其他会话查看。
      // 若仍在本会话 → 正常回灌到当前视图并落盘；若已切走 → 后台缓冲 + 按原会话落盘，不污染当前视图。
      const isStillCurrent = runSessionId === this.currentSessionId;
      if (isStillCurrent) {
        this.conversation = result;
        webview.postMessage({ type: "done", text: "完成。" });
        this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
      } else {
        this.backgroundSessions.set(runSessionId, result);
        this.backgroundAborts.delete(runSessionId);
        this.storage.saveSessionTo(runSessionId, result, this.currentSessionId);
        // 通知前端：后台会话已完成（前端仅刷新会话列表，不把它渲染进当前视图）
        webview.postMessage({ type: "background_done", sessionId: runSessionId });
      }
      // 回合结束自动收尾任务清单：仅当模型全程未接管 todo（内容仍是自动种子）时，
      // 把「进行中」标记为「已完成」，避免任务列表面板停留在进行中状态。
      if (todoAutoSeeded) {
        const untouched =
          todoState.items.length === 1 &&
          todoState.items[0].content === seedTask &&
          todoState.items[0].status === "in_progress";
        if (untouched) {
          todoState.items = [{ content: seedTask, status: "completed" }];
          webview.postMessage({ type: "todos", items: todoState.items, sessionId: runSessionId });
        }
      }
      // Layer 2 OnStop 钩子：会话结束后反思并建议规则/技能（best-effort，不阻塞 UI）
      void this.reflectAfterSession(webview, root);
    } catch (e: any) {
      // 用户主动停止：不发错误气泡，仅提示已停止（部分未完成内容不落盘）
      // 用 runAbort 判断：即使 newChat 后 this.abort 已被替换，本请求仍正确判定为 stopped
      if (runAbort.signal.aborted) {
        const isStillCurrent = runSessionId === this.currentSessionId;
        webview.postMessage({ type: "stopped", sessionId: runSessionId });
        if (isStillCurrent) {
          // 回滚本回合未完成的部分（在工具执行中途停止会残留无配对的 tool 消息），
          // 避免下一次请求因消息序列非法而 400。
          this.conversation = trimUnfinishedTurn(this.conversation);
          this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
        } else {
          this.backgroundSessions.delete(runSessionId);
          this.backgroundAborts.delete(runSessionId);
        }
      } else {
        // 异常结束同样回滚，防止损坏的历史污染下一次请求
        if (runSessionId === this.currentSessionId) {
          this.conversation = trimUnfinishedTurn(this.conversation);
        }
        webview.postMessage({ type: "error", message: e?.message ?? String(e), sessionId: runSessionId });
      }
    } finally {
      this.backgroundAborts.delete(runSessionId);
      // 保留 runFiles 直到 newChat/切会话时再清，给前端留时间渲染最终态
      this.running = false;
      // 等待队列消费：本轮结束若仍有排队输入，自动作为下一条 user 消息继续（对齐 CodeBuddy 等待序列）。
      if (this.pendingUserQueue.length > 0) {
        const next = this.pendingUserQueue.shift()!;
        webview.postMessage({ type: "queue_state", pending: this.pendingUserQueue.length });
        // 外部投递的消息前端未渲染过，消费时补渲染（用户手敲的已在本地显示，勿双显）
        if (this.injectedPending.delete(next)) {
          webview.postMessage({ type: "user_injected", text: next });
        }
        await this.handleUser(webview, next);
      }
    }
  }

  /** 定时任务/外部投递的用户消息入口：空闲直接执行，运行中或面板未就绪则入队。 */
  submitUserMessage(text: string): void {
    const t = (text || "").trim();
    if (!t) return;
    if (this.running || !this.view) {
      this.pendingUserQueue.push(t);
      this.injectedPending.add(t);
      this.view?.webview.postMessage({ type: "queue_state", pending: this.pendingUserQueue.length });
      return;
    }
    // 前端未经过输入框，通知 webview 渲染这条注入的用户消息
    this.view.webview.postMessage({ type: "user_injected", text: t });
    void this.handleUser(this.view.webview, t);
  }

  newChat(webview?: vscode.Webview) {
    const target = webview ?? this.view?.webview;
    // 若当前会话仍有后台任务在跑，快照其对话到缓冲，使后台任务持续累加、切回时读最新。
    if (this.backgroundAborts.has(this.currentSessionId) && this.conversation.length) {
      this.backgroundSessions.set(this.currentSessionId, this.conversation.map((m) => ({ ...m })));
    }
    // 旧会话已在每轮结束后落盘；此处仅重置内存并开始新会话
    this.conversation = [];
    clearSubAgentRegistry(); // 清空命名子智能体团队，避免新会话寻址到旧上下文
    clearFileSnapshots(); // 清空文件指纹，避免跨会话误报冲突
    this.pendingEdits.clear(); // 新会话不再持有旧 diff 卡的回滚依据
    this.pendingUserQueue = []; // 清空等待队列，避免跨会话把排队输入喂错会话
    this.injectedPending.clear();
    target?.postMessage({ type: "queue_state", pending: 0 });
    this.currentSessionId = makeId();
    // 事件源日志：新会话立即开新 events-{id}.jsonl 并记录 session_start
    ensureEventLog(this.storage.historyDir(), this.currentSessionId);
    this.abort?.abort();
    target?.postMessage({ type: "newChat", sessionId: this.currentSessionId });
    // 目标面板：goal 为项目级状态机，跨会话持久，新建会话后仍应展示（前端 newChat 会清空面板）
    const newGoal = loadGoalState(this.workspaceRoot());
    if (newGoal.objective) {
      target?.postMessage({
        type: "goal",
        view: {
          objective: newGoal.objective,
          phase: newGoal.phase,
          roundsStarted: newGoal.roundsStarted,
          maxRounds: newGoal.maxRounds,
          blockedReason: newGoal.blockedReason,
        },
        sessionId: this.currentSessionId,
      });
    }
  }

  /** 事件源日志回放：打开当前会话的 events-{id}.jsonl（append-only JSONL，含 user/assistant/tool/compact/subagent 全轨迹）。 */
  openSessionLog() {
    const id = this.currentSessionId;
    const fp = path.join(this.storage.historyDir(), `events-${id}.jsonl`);
    if (!fs.existsSync(fp)) {
      vscode.window.showInformationMessage("当前会话暂无事件日志（新建会话或发送消息后自动生成）。");
      return;
    }
    const events = readSessionEvents(this.storage.historyDir(), id);
    void vscode.window.showTextDocument(vscode.Uri.file(fp), { preview: true });
    vscode.window.showInformationMessage(`📜 已打开事件日志：${events.length} 条事件（会话 ${id.slice(0, 8)}…）`);
  }

  /** 对话模式切换（plan/ask/craft/coder）：更新运行时状态、持久化配置、重建系统提示词并通知前端。 */
  setAgentMode(webview?: vscode.Webview, mode?: AgentMode) {
    const target = webview ?? this.view?.webview;
    const next: AgentMode =
      mode ?? (this.isExecMode ? "plan" : "craft");
    this.agentMode = next;
    vscode.workspace
      .getConfiguration("freesek")
      .update("mode", next, vscode.ConfigurationTarget.Global);
    // 若当前会话已有系统提示词，重建并替换，使本模式立即影响后续回合
    if (this.conversation.length && this.conversation[0].role === "system") {
      this.conversation[0].content = this.buildSystemPrompt(this.workspaceRoot());
    }
    target?.postMessage({ type: "agent_mode", mode: next });
    const labels: Record<AgentMode, string> = { plan: "规划", ask: "问答", craft: "制作", coder: "编码" };
    const descs: Record<AgentMode, string> = {
      plan: "只读调研 + 出方案，禁止写文件 / 执行命令",
      ask: "纯问答，只用只读工具查信息，不写不改不执行",
      craft: "完整能力，可写文件 / 执行命令",
      coder: "专职需求理解 + 代码生成，权限等同 Craft（可写文件 / 执行命令）",
    };
    vscode.window.showInformationMessage(`已切换到「${labels[next]}」模式：${descs[next]}`);
  }

  /** 分叉当前对话为新分支（复制全部历史到新 id），便于并行探索不同方案（对标 Claude Code /fork）。 */
  forkSession(webview?: vscode.Webview) {
    const target = webview ?? this.view?.webview;
    if (this.conversation.length === 0) {
      vscode.window.showInformationMessage("当前没有可分叉的对话。");
      return;
    }
    // 深拷贝当前对话（保留 system 提示词与全部历史），切换到新分支 id
    this.conversation = this.conversation.map((m) => ({ ...m }));
    clearSubAgentRegistry(); // 分叉后旧命名子智能体不再有效，清空团队注册表
    this.pendingEdits.clear(); // 分叉后旧 diff 卡不再出现在新分支
    this.currentSessionId = makeId();
    this.abort?.abort();
    this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
    target?.postMessage({ type: "restore", messages: this.conversation, sessionId: this.currentSessionId });
    target?.postMessage({
      type: "context_status",
      text: "🍴 已分叉出新的对话分支，可并行尝试不同方案。",
    });
    vscode.window.showInformationMessage("已分叉当前对话为新分支。");
  }

  /** 重命名当前会话（更新 globalStorage 索引中的标题，历史列表即时生效）。 */
  async renameSession(webview?: vscode.Webview) {
    const target = webview ?? this.view?.webview;
    if (!this.currentSessionId) {
      vscode.window.showInformationMessage("当前没有可重命名的会话。");
      return;
    }
    // 若会话尚未落盘（尚无任何消息），先按默认标题创建索引项
    let idx = this.storage.loadIndex();
    let meta = idx.sessions.find((s) => s.id === this.currentSessionId);
    if (!meta) {
      this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
      idx = this.storage.loadIndex();
      meta = idx.sessions.find((s) => s.id === this.currentSessionId);
    }
    if (!meta) {
      vscode.window.showInformationMessage("当前会话尚无可保存内容，无法重命名。");
      return;
    }
    const newTitle = await vscode.window.showInputBox({
      title: "重命名会话",
      prompt: "输入新的会话标题（回车确认，Esc 取消）",
      value: meta.title,
      ignoreFocusOut: true,
    });
    if (!newTitle || !newTitle.trim()) return;
    const sessionId = this.currentSessionId;
    this.storage.mutateIndex((idx2) => {
      const m = idx2.sessions.find((s) => s.id === sessionId);
      if (!m) return;
      m.title = newTitle.trim();
      m.updatedAt = Date.now();
    });
    target?.postMessage({ type: "context_status", text: `✏️ 会话已重命名为「${newTitle.trim()}」` });
    vscode.window.showInformationMessage(`会话已重命名为「${newTitle.trim()}」`);
  }

  /** 向 webview 弹出权限请求，等待用户决策（允许 / 总是允许 / 拒绝 / 总是拒绝）。超时（10 分钟）自动拒绝。 */
  private requestPermission(
    webview: vscode.Webview,
    toolName: string,
    input: any
  ): Promise<{ allow: boolean; persist?: "allow" | "deny" }> {
    const id = "perm-" + Math.random().toString(36).slice(2, 8);
    let summary = "";
    try {
      if (toolName === "run_command") {
        const raw = (input as any)?.command ?? (Array.isArray((input as any)?.argv) ? (input as any).argv.join(" ") : "");
        summary = String(raw);
      }
      else if (toolName === "write_file" || toolName === "edit_file")
        summary = String((input as any)?.path ?? "");
      else summary = JSON.stringify(input ?? "").slice(0, 200);
    } catch {
      summary = "";
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(id);
        webview.postMessage({ type: "permission_timeout", id });
        resolve({ allow: false });
      }, 10 * 60 * 1000);
      this.pendingPermissions.set(id, { resolve, timer });
      webview.postMessage({ type: "permission_request", id, tool: toolName, summary });
    });
  }

  /** ask_user 原生兜底：有 options 用 QuickPick，否则 InputBox 自由文本。 */
  private async askUserNative(req: AskRequest): Promise<string> {
    if (req.options && req.options.length) {
      const items: vscode.QuickPickItem[] = req.options.map((o) => ({
        label: o.label,
        description: o.description,
      }));
      if (req.multiSelect) {
        const picked = await vscode.window.showQuickPick(items, {
          title: "FreeSeek 询问",
          placeHolder: req.question,
          canPickMany: true,
          ignoreFocusOut: true,
        });
        return picked ? picked.map((p) => p.label).join(", ") : "";
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: "FreeSeek 询问",
        placeHolder: req.question,
        ignoreFocusOut: true,
      });
      return picked?.label ?? "";
    }
    return (await vscode.window.showInputBox({ title: "FreeSeek 询问", prompt: req.question })) ?? "";
  }

  /**
   * 在 webview 聊天区内渲染 ask_user 交互卡（对齐 Claude Code Interactive Questions：
   * 选项按钮 / 自由文本输入），等待用户选择后返回答案给 agent 工具循环。
   * 超时（10 分钟）、用户点「停止」或会话被中止时以空串返回，避免工具循环悬挂。
   */
  private askUserInWebview(
    webview: vscode.Webview,
    req: AskRequest,
    signal: AbortSignal
  ): Promise<string> {
    const id = "ask-" + Math.random().toString(36).slice(2, 8);
    return new Promise((resolve) => {
      let settled = false;
      const settle = (v: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        this.pendingAsks.delete(id);
        resolve(v);
      };
      const onAbort = () => settle("");
      const timer = setTimeout(() => {
        try {
          webview.postMessage({ type: "ask_timeout", id });
        } catch {
          /* webview 已销毁，忽略 */
        }
        settle("");
      }, 10 * 60 * 1000);
      this.pendingAsks.set(id, { resolve: (v) => settle(v), timer });
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        webview.postMessage({
          type: "ask_user",
          id,
          question: req.question,
          options: req.options ?? [],
          multiSelect: !!req.multiSelect,
          sessionId: this.currentSessionId,
        });
      } catch {
        // 面板已关闭：立即以空串结束（调用方会退回原生输入）
        settle("");
      }
    });
  }

  /** Slash 自定义命令调色板：列出项目 .agent/commands/ 下的命令，选中后以展开 prompt 注入对话。 */
  async openCommands(webview?: vscode.Webview) {
    const root = this.workspaceRoot();
    const target = webview ?? this.view?.webview;
    const cmds = loadCommands(root);
    if (!cmds.length) {
      vscode.window.showInformationMessage(
        "暂无 Slash 命令：在项目 .agent/commands/ 下放置 <name>.md 即可创建（正文可含 $ARGUMENTS）。"
      );
      return;
    }
    const items = cmds.map((c) => ({
      label: `/${c.name}`,
      description: c.description,
      name: c.name,
    }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "选择一个 Slash 命令执行（Esc 取消）",
    });
    if (!pick) return;
    let argText = "";
    if (getCommand(root, pick.name)?.body.includes("$ARGUMENTS")) {
      const a = await vscode.window.showInputBox({
        title: `/${pick.name} 参数`,
        prompt: "输入传给命令的参数（可选，回车跳过）",
        ignoreFocusOut: true,
      });
      argText = a ?? "";
    }
    const resolved = resolveCommand(root, pick.name, argText);
    if (!resolved) return;
    if (target) await this.handleUser(target, resolved.prompt);
  }

  /** Layer 2 OnStop 钩子：会话结束后的轻量反思 + 技能沉淀（异步、best-effort）。 */
  private async reflectAfterSession(webview: vscode.Webview, root: string) {
    try {
      const note = await reflectAndSuggest(this.conversation, root);
      if (note) webview.postMessage({ type: "context_status", text: note });
    } catch {
      /* 反思失败不影响主流程 */
    }
    // 技能进化闭环：从会话沉淀可复用技能（pending 待审核，验证门控 + 人类在环）
    try {
      const cfg = vscode.workspace.getConfiguration("freesek");
      if (cfg.get<boolean>("autoDistillSkills", true)) {
        const distilled = await distillSkillFromSession(this.conversation, defaultUserSkillsDir());
        if (distilled) {
          if (typeof distilled === "string") {
            webview.postMessage({ type: "context_status", text: distilled });
          } else {
            webview.postMessage({
              type: "skill_distilled",
              skill: distilled as DistilledSkillInfo,
            });
          }
        }
      }
    } catch {
      /* 技能沉淀失败不影响主流程 */
    }
  }

  async openHistory(webview?: vscode.Webview) {
    const target = webview ?? this.view?.webview;
    const idx = this.storage.loadIndex();
    if (idx.sessions.length === 0) {
      vscode.window.showInformationMessage("还没有任何历史对话记录。");
      return;
    }
    // 可选：按提问内容搜索（对齐 CodeBuddy 历史对话按提问内容搜索）
    const q = await vscode.window.showInputBox({
      placeHolder: "搜索历史对话（输入提问/关键词后回车；直接回车查看全部）",
      ignoreFocusOut: true,
    });
    const kw = (q ?? "").trim().toLowerCase();
    let matched = idx.sessions.filter((s) => !s.archived);
    if (kw) {
      matched = matched.filter((s) => {
        const title = (s.title || "").toLowerCase();
        const preview = (s.preview || "").toLowerCase();
        return title.includes(kw) || preview.includes(kw);
      });
      if (matched.length === 0) {
        vscode.window.showInformationMessage(`未找到包含「${q}」的历史对话。`);
        return;
      }
    }
    const items = matched
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((s) => ({
        label: s.title || "（无标题）",
        description: `${new Date(s.updatedAt).toLocaleString()} · ${s.count} 条`,
        detail: s.preview,
        id: s.id,
      }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: kw ? `「${q}」的搜索结果（Esc 取消）` : "选择要恢复的历史对话（Esc 取消）",
    });
    if (!pick) return;
    const conv = this.storage.loadSessionInto(pick.id, this.backgroundSessions);
    if (!conv) {
      vscode.window.showErrorMessage("该历史对话读取失败，可能已被删除。");
      return;
    }
    this.conversation = conv;
    this.currentSessionId = pick.id;
    this.pendingEdits.clear(); // 恢复历史会话，旧 diff 卡撤销依据失效
    this.storage.saveCurrentSession(this.conversation, this.currentSessionId); // 更新 current 指针
    target?.postMessage({ type: "restore", messages: this.conversation, sessionId: this.currentSessionId });
    vscode.commands.executeCommand("freesek.chatView.focus");
  }

  /**
   * 导入 Codex / Claude Code 对话文件并继续对话：
   * 让用户选择 .jsonl 文件 → 解析为 ChatMessage[] → 作为新会话落盘并恢复到当前视图。
   */
  private async importConversation(webview: vscode.Webview) {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "导入对话",
      title: "选择要导入的会话文件（Codex / Claude Code 的 .jsonl 日志）",
      filters: { "会话日志": ["jsonl", "json"], "所有文件": ["*"] },
    });
    if (!picked || picked.length === 0) return;
    const uri = picked[0];
    let content: string;
    try {
      content = fs.readFileSync(uri.fsPath, "utf8");
    } catch {
      vscode.window.showErrorMessage("读取文件失败：" + uri.fsPath);
      return;
    }
    const res = importJsonl(content);
    if (res.messages.length === 0) {
      vscode.window.showErrorMessage(
        "未从该文件解析出任何消息。请确认是 Codex / Claude Code 的 JSONL 会话日志。"
      );
      return;
    }
    // 丢弃外来 system 提示词，续聊时用 FreeSeek 自己的（在 handleUser 时注入）
    const clean = res.messages.filter((m) => m.role !== "system");
    if (clean.length === 0) {
      vscode.window.showErrorMessage("导入内容仅含系统提示词，无可恢复的对话消息。");
      return;
    }
    // 作为新会话落盘
    const id = makeId();
    this.currentSessionId = id;
    this.conversation = clean;
    this.pendingEdits.clear();
    this.storage.saveCurrentSession(this.conversation, this.currentSessionId);
    const srcName = res.source === "codex" ? "Codex" : res.source === "claude" ? "Claude Code" : "未知来源";
    webview.postMessage({ type: "restore", messages: clean, sessionId: id });
    webview.postMessage({
      type: "context_status",
      text: `📥 已导入 ${srcName} 对话（${res.converted} 条消息${res.skipped ? `，跳过 ${res.skipped} 行无法识别` : ""}）。`,
    });
    this.pushRecentSessions(webview);
    vscode.commands.executeCommand("freesek.chatView.focus");

    // 导入后自动通读：让 Agent 过一遍工作区关键文件并生成状态摘要，便于无缝继续对话（可开关）
    const autoRead = vscode.workspace
      .getConfiguration("freesek")
      .get<boolean>("importAutoRead", true);
    if (autoRead) {
      await this.handleUser(
        webview,
        "我刚导入了一段来自 Codex / Claude Code 的历史对话（见上方导入内容）。" +
          "在继续之前，请你先快速通读当前工作区：读取项目说明文件（如 CLAUDE.md / AGENTS.md / README.md）、" +
          "了解目录结构，并抽查历史对话中提到的关键文件。" +
          "然后给我一段 3-5 句的工作区当前状态摘要，说明你对项目结构和进度的理解，" +
          "并提示我接下来可以从哪里继续。"
      );
    }
  }

  /** 从侧边栏切换会话：加载指定 id 的对话并回灌前端（对标 Codex/Claude Code 历史会话切换）。 */
  private switchSessionById(webview: vscode.Webview, id: string) {
    // 切走前：若当前会话仍有一个后台任务在运行，先把当前对话快照存入缓冲，
    // 这样该后台任务若中途回写（或结束时）能基于此快照持续累加，切回时读到最新。
    if (this.backgroundAborts.has(this.currentSessionId) && this.conversation.length) {
      this.backgroundSessions.set(this.currentSessionId, this.conversation.map((m) => ({ ...m })));
    }
    const conv = this.storage.loadSessionInto(id, this.backgroundSessions);
    if (!conv) {
      vscode.window.showErrorMessage("该历史对话读取失败，可能已被删除。");
      return;
    }
    this.conversation = conv;
    this.currentSessionId = id;
    this.pendingEdits.clear(); // 历史会话的 diff 卡不在重绘范围内，清空撤销依据
    this.storage.saveCurrentSession(this.conversation, this.currentSessionId); // 更新 current 指针
    const meta = this.storage.loadIndex().sessions.find((s) => s.id === id);
    webview.postMessage({ type: "restore", messages: this.conversation, sessionId: id });
    webview.postMessage({
      type: "session_title",
      title: meta?.title || "新对话",
      sessionId: id,
    });
    this.pushRecentSessions(webview);
    vscode.commands.executeCommand("freesek.chatView.focus");
  }

  /**
   * 恢复历史会话（命令面板入口，对齐 Codex/Claude Code 的会话恢复语义）。
   * 列出全部非归档会话，用户选择（或显式传入 id）后恢复并回灌前端。
   * 实现为公开方法，由 activate 中注册的 freesek.resumeSession 命令调用。
   */
  public async resumeSession(idArg?: string): Promise<void> {
    const sessions = this.activeSessions();
    if (sessions.length === 0) {
      vscode.window.showInformationMessage("没有可恢复的历史会话。");
      return;
    }
    let id = idArg;
    if (!id) {
      const picked = await vscode.window.showQuickPick(
        sessions.map((s) => ({
          label: s.title || "未命名对话",
          description: new Date(s.updatedAt).toLocaleString(),
          id: s.id,
        })),
        { placeHolder: "选择要恢复的会话" }
      );
      id = picked?.id;
    }
    if (!id) return;
    // view 未就绪时先聚焦侧边栏，再轮询等 resolveWebviewView 初始化后恢复（有限次，避免时序赌注）
    if (!this.view) {
      vscode.commands.executeCommand("freesek.chatView.focus");
      const maxTries = 20; // 每 100ms 一次，最多 2s
      const attempt = (n: number): void => {
        if (this.view) {
          this.switchSessionById(this.view.webview, id);
          return;
        }
        if (n < maxTries) setTimeout(() => attempt(n + 1), 100);
        else vscode.window.showErrorMessage("聊天视图未就绪，无法恢复会话。");
      };
      attempt(0);
      return;
    }
    this.switchSessionById(this.view.webview, id);
  }

  /** 从侧边栏删除会话：删除落盘文件与索引项；若删的是当前会话则重置内存。 */
  private deleteSessionById(id: string) {
    // 删除必须先终止仍在该会话运行的后台 Agent，并关闭其 captured event sink；否则旧任务
    // 可能在文件删除后继续 append，从而把“已删除会话”的审计数据重新创建出来。
    this.backgroundAborts.get(id)?.abort(new Error("会话已删除"));
    this.backgroundAborts.delete(id);
    this.backgroundSessions.delete(id);
    deleteSessionEventLog(this.storage.historyDir(), id);
    try {
      fs.unlinkSync(this.storage.sessionPath(id));
    } catch {
      /* 文件可能不存在 */
    }
    try {
      fs.unlinkSync(this.storage.transcriptPath(id));
    } catch {
      /* 同上 */
    }
    this.storage.mutateIndex((idx) => {
      idx.sessions = idx.sessions.filter((s) => s.id !== id);
      if (idx.current === id) idx.current = null;
    });
    if (this.currentSessionId === id) {
      this.conversation = [];
      this.currentSessionId = makeId();
    }
  }

  /** 从侧边栏按 id 重命名会话（静默更新索引，不弹原生输入框）。 */
  private renameSessionById(id: string, title: string) {
    if (!title.trim()) return;
    const nextTitle = title.trim();
    this.storage.mutateIndex((idx) => {
      const m = idx.sessions.find((s) => s.id === id);
      if (!m) return;
      m.title = nextTitle;
      m.updatedAt = Date.now();
    });
    if (this.currentSessionId === id) {
      this.view?.webview.postMessage({ type: "session_title", title: nextTitle, sessionId: id });
    }
  }

  /** 归档 / 取消归档会话（归档后从主列表移入归档，可恢复/删除）。 */
  private setSessionArchived(id: string, archived: boolean) {
    this.storage.mutateIndex((idx) => {
      const m = idx.sessions.find((s) => s.id === id);
      if (!m) return;
      m.archived = archived;
      m.updatedAt = Date.now();
    });
  }

  /** 非归档会话列表（按更新时间倒序）。 */
  private activeSessions() {
    return this.storage.loadIndex().sessions
      .filter((s) => !s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 归档会话列表（按归档时间倒序）。 */
  private archivedSessions() {
    return this.storage.loadIndex().sessions
      .filter((s) => s.archived)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ---------------- 多提供商 / 多模型管理（参照 cc-switch） ----------------

  /** 切换当前模型：弹出跨所有 provider 的模型列表，可选「添加/编辑提供商」。 */
  async switchModel() {
    // 先刷新 autoDiscover 的本地 provider 模型（LM Studio/Ollama），确保列表含全部已加载模型
    try {
      const { getProviders, refreshDiscoveredModels } = await import("./providers");
      for (const p of getProviders()) {
        if (p.autoDiscoverModels) await refreshDiscoveredModels(p);
      }
    } catch {
      /* 发现失败不阻塞 */
    }
    const items: any[] = buildSwitchItems();
    items.push({ label: "$(add) 添加新提供商…", alwaysShow: true, action: "add" });
    items.push({ label: "$(gear) 在设置中编辑 providers…", alwaysShow: true, action: "edit" });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "选择要使用的模型，或添加/编辑提供商（Esc 取消）",
    });
    if (!pick) return;
    if (pick.action === "add") {
      // 统一走 webview 内弹窗（对齐 CodeBuddy），不再用 vscode 顶部原生输入框
      vscode.commands.executeCommand("freesek.chatView.focus");
      this.openAddModelModal();
      return;
    }
    if (pick.action === "edit") {
      await this.editProviders();
      return;
    }
    setActiveSelection({ providerId: pick.providerId, modelId: pick.modelId });
    this.view?.webview.postMessage({ type: "model_info", label: getActiveLabel() });
    this.view?.webview.postMessage({ type: "model_options", ...buildModelOptions() });
    vscode.window.showInformationMessage(`已切换到：${pick.modelId}（${pick.providerId}）`);
  }

  /** 向导式添加一个提供商（可含多个模型）。参照 CodeBuddy：先选预设服务商，再填 Key，保存后可测试连通。 */
  async addProvider() {
    // 第一步：快速选择常见服务商预设（自动填充 baseUrl/格式/认证/模型），也可选「手动填写」
    const presets: Array<{
      id: string; name: string; baseUrl: string; format: ProviderFormat; authType: AuthType;
      models: Array<{ id: string; name?: string }>; envKey?: string; autoDiscover?: boolean; capabilities?: ModelCapabilities;
    }> = [
      { id: "deepseek", name: "DeepSeek", baseUrl: DEEPSEEK_OFFICIAL_BASE_URL, format: "openai", authType: "bearer", models: [{ id: DEEPSEEK_DEFAULT_MODEL }, { id: DEEPSEEK_PRO_MODEL }], envKey: "DEEPSEEK_API_KEY" },
      { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai", authType: "bearer", models: [{ id: "openrouter/auto" }], envKey: "OPENROUTER_API_KEY" },
      { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", format: "openai", authType: "bearer", models: [{ id: "Qwen/Qwen2.5-72B-Instruct" }], envKey: "SILICONFLOW_API_KEY" },
      { id: "moonshot", name: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", format: "openai", authType: "bearer", models: [{ id: "kimi-k2-instruct" }], envKey: "MOONSHOT_API_KEY" },
      { id: "qwen", name: "阿里通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", format: "openai", authType: "bearer", models: [{ id: "qwen-plus" }], envKey: "DASHSCOPE_API_KEY" },
      { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", format: "openai", authType: "bearer", models: [{ id: "glm-4-plus" }], envKey: "ZHIPU_API_KEY" },
      { id: "tencent-hunyuan", name: "腾讯云混元", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", format: "openai", authType: "bearer", models: [{ id: "hunyuan-turbo" }, { id: "hunyuan-pro" }], envKey: "TENCENT_HUNYUAN_API_KEY" },
      { id: "openai", name: "OpenAI (Responses API)", baseUrl: "https://api.openai.com/v1", format: "responses", authType: "bearer", models: [{ id: "gpt-6.1-sol" }], envKey: "OPENAI_API_KEY", capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, contextWindow: 1_050_000, maxOutputTokens: 128_000, inputModalities: ["text", "image"], outputModalities: ["text"] } },
      { id: "openai-chat", name: "OpenAI (Chat Completions)", baseUrl: "https://api.openai.com/v1", format: "openai", authType: "bearer", models: [{ id: "gpt-6.1-sol" }], envKey: "OPENAI_API_KEY", capabilities: { tools: true, vision: true, reasoning: true, structuredOutput: true, contextWindow: 1_050_000, maxOutputTokens: 128_000, inputModalities: ["text", "image"], outputModalities: ["text"] } },
      { id: "ollama", name: "Ollama 本地", baseUrl: "http://127.0.0.1:11434/v1", format: "openai", authType: "none", models: [], autoDiscover: true },
      { id: "lmstudio", name: "LM Studio 本地", baseUrl: "http://127.0.0.1:1234/v1", format: "openai", authType: "none", models: [], autoDiscover: true },
    ];
    const presetPick = await vscode.window.showQuickPick(
      [
        ...presets.map((p) => ({ label: p.name, description: p.baseUrl, detail: p.models[0]?.id || (p.autoDiscover ? "自动发现模型" : ""), value: p })),
        { label: "自定义 / 其它服务商", description: "手动填写 Base URL / 协议格式", value: null },
      ],
      { placeHolder: "选择服务商预设（参照 CodeBuddy，保存后可测试连通）", ignoreFocusOut: true }
    );
    if (!presetPick) return;
    const preset = presetPick.value;

    let name: string;
    let baseUrl: string;
    let fmt: ProviderFormat = "openai";
    let authType: AuthType = "bearer";
    let presetModels: Array<{ id: string; name?: string }>;
    let autoDiscover = false;

    if (preset) {
      name = preset.name;
      baseUrl = preset.baseUrl;
      fmt = preset.format ?? "openai";
      authType = preset.authType ?? "bearer";
      presetModels = preset.models;
      autoDiscover = !!preset.autoDiscover;
    } else {
      name = (await vscode.window.showInputBox({
        title: "提供商名称",
        prompt: "如：OpenRouter / 硅基流动 / 我的本地服务",
        placeHolder: "My Provider",
        ignoreFocusOut: true,
      })) || "";
      if (!name) return;

      baseUrl = (await vscode.window.showInputBox({
        title: "Base URL",
        prompt: "OpenAI 兼容 Base URL，如 https://api.deepseek.com、https://openrouter.ai/api/v1",
        placeHolder: "https://.../v1",
        ignoreFocusOut: true,
      })) || "";
      if (!baseUrl) return;
      presetModels = [];
    }

    // API Key：预设时预填对应的 ${env:...} 引用（参照 CodeBuddy 选好 Provider 后只需填 Key）
    const apiKey = await vscode.window.showInputBox({
      title: "API Key（可选）",
      prompt: "可填明文，或 ${env:MY_KEY} 引用环境变量。留空则不带鉴权头。",
      value: preset?.envKey ? `\${env:${preset.envKey}}` : undefined,
      password: true,
      ignoreFocusOut: true,
    });

    // 协议格式：预设已定则跳过；仅「自定义」时让用户选择（决定请求体/认证头/流解析）
    if (!preset) {
      const format = await vscode.window.showQuickPick(
        [
          {
            label: "OpenAI 兼容 (chat/completions)",
            description: "覆盖 DeepSeek/通义/Kimi/智谱/OneAPI/中转等绝大多数服务",
            value: "openai",
          },
          {
            label: "OpenAI Responses API (/responses)",
            description: "OpenAI 原生 Responses 协议：typed output、reasoning 与原生 function calling",
            value: "responses",
          },
          {
            label: "Claude 格式 (v1/messages)",
            description: "Anthropic 官方或兼容 Claude 协议的中转，x-api-key 认证",
            value: "claude",
          },
          {
            label: "Gemini 格式 (generateContent)",
            description: "Google Gemini，x-goog-api-key 认证",
            value: "gemini",
          },
        ],
        { placeHolder: "选择协议格式", ignoreFocusOut: true }
      );
      if (!format) return;
      fmt = format.value as ProviderFormat;
    }

    const isClaude = fmt === "claude";
    const isGemini = fmt === "gemini";
    const isResponses = fmt === "responses";
    let storeResponses = false;
    if (isResponses) {
      const storagePick = await vscode.window.showQuickPick(
        [
          { label: "本地优先：关闭服务端存储（推荐）", value: false },
          { label: "允许 OpenAI 服务端存储 Responses", value: true },
        ],
        { placeHolder: "Responses 数据存储策略", ignoreFocusOut: true }
      );
      if (!storagePick) return;
      storeResponses = storagePick.value;
    }

    const toolMode = await vscode.window.showQuickPick(
      [
        {
          label: "原生 function calling",
          description: isClaude || isGemini ? "（Claude/Gemini 当前建议用 ReAct，原生工具尚在打磨）" : isResponses ? "Responses API 原生 function_call / function_call_output" : "支持 Chat Completions tools 参数（官方/兼容服务）",
          value: "native",
        },
        {
          label: "ReAct 文本协议",
          description: "免费逆向服务等不支持 tools 的服务（FreeSeek 本地用此）",
          value: "react",
        },
      ],
      { placeHolder: "工具调用模式" }
    );
    if (!toolMode) return;

    // 模型列表：预设直接使用其模型（Ollama/LM Studio 预设自动 autoDiscover）；仅自定义时手动输入
    let models: Array<{ id: string; name?: string }> = [];
    let autoDiscoverModels = false;
    if (preset) {
      models = presetModels;
      autoDiscoverModels = autoDiscover;
    } else {
      const autoDiscoverPick = await vscode.window.showQuickPick(
        [
          { label: "否，手动输入模型列表", description: "适用于云端 API 或模型固定的服务" },
          { label: "是，自动发现模型", description: "适合 LM Studio / Ollama：自动拉取 /v1/models 的全部模型" },
        ],
        { placeHolder: "是否自动发现模型？", ignoreFocusOut: true }
      );
      if (!autoDiscoverPick) return;
      if (autoDiscoverPick.label.startsWith("是")) {
        autoDiscoverModels = true;
      } else {
        const modelsStr = await vscode.window.showInputBox({
          title: "模型列表",
          prompt: "逗号分隔，如：deepseek-v4-flash, deepseek-v4-pro；或『id:显示名』，如 deepseek-v4-flash:DeepSeek V4 Flash",
          placeHolder: "deepseek-v4-flash, deepseek-v4-pro",
          ignoreFocusOut: true,
        });
        if (!modelsStr) return;
        models = modelsStr
          .split(/[,\n]/)
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const idx = s.indexOf(":");
            if (idx > 0) return { id: s.slice(0, idx).trim(), name: s.slice(idx + 1).trim() };
            return { id: s };
          });
      }
    }
    // 自动发现模式下至少需要一个占位模型，否则设为空数组由发现填充
    if (!models.length && !autoDiscoverModels) {
      vscode.window.showInformationMessage("请至少输入一个模型，或选择自动发现模型。");
      return;
    }

    // 模型上下文窗口（可选）：本地小模型（如 LM Studio 8K）必须填写，否则请求会先超出窗口被服务端拒绝；
    // 云端大窗口模型可回车跳过（沿用默认 32K 压缩预算）。
    const ctxInput = await vscode.window.showInputBox({
      title: "模型上下文窗口（可选，token 数）",
      prompt: "如 LM Studio 的 qwen2.5-coder-7b 填 8192；云端 DeepSeek 等可回车跳过",
      placeHolder: "回车跳过（默认 32000）",
      ignoreFocusOut: true,
      validateInput: (v) =>
        v.trim() === "" || /^\d+$/.test(v.trim()) ? undefined : "请输入数字（token 数）",
    });
    if (ctxInput === undefined) return; // 按 Esc 取消
    const contextWindow = ctxInput.trim() ? parseInt(ctxInput.trim(), 10) : undefined;

    const id = "p-" + Date.now().toString(36);
    const secureApiKey = await storeProviderSecret(this.context, id, apiKey || "");
    // claude/gemini 使用各自的认证头方式；openai 默认 Bearer（预设已定 authType 则沿用）
    const computedAuth: AuthType = isClaude ? "x-api-key" : isGemini ? "x-goog-api-key" : "bearer";
    authType = authType || computedAuth;
    const newProvider: ProviderConfig = {
      id,
      name,
      baseUrl: baseUrl.replace(/\/+$/, ""),
      apiKey: secureApiKey,
      toolMode: (toolMode.value as "native" | "react"),
      models,
      format: fmt,
      authType,
      ...(preset?.capabilities ? { capabilities: preset.capabilities } : {}),
      ...(isResponses && storeResponses ? { storeResponses: true } : {}),
      ...(autoDiscoverModels ? { autoDiscoverModels: true } : {}),
      ...(contextWindow ? { contextWindow } : {}),
    };

    const cfg = vscode.workspace.getConfiguration("freesek");
    const list = (cfg.get<ProviderConfig[]>("providers", []) || []).slice();
    list.push(newProvider);
    await cfg.update("providers", list, vscode.ConfigurationTarget.Global);
    if (models[0]?.id) setActiveSelection({ providerId: id, modelId: models[0].id });
    this.view?.webview.postMessage({ type: "model_info", label: getActiveLabel() });
    this.view?.webview.postMessage({ type: "model_options", ...buildModelOptions() });

    // 参照 CodeBuddy「保存，测试连通」：保存后调用 /models 测试连通性并反馈
    const ok = await this.testProviderConnection(newProvider);
    vscode.window.showInformationMessage(
      ok
        ? `已添加提供商「${name}」并设为当前模型；连通性测试通过 ✅`
        : `已添加提供商「${name}」。注意：连通性测试未通过（服务未启动 / API Key 无效 / 网络受限），可在其运行后重试。`
    );
  }

  /** 在设置 UI 中打开 providers 配置，便于高级编辑/删除。 */
  async editProviders() {
    await vscode.commands.executeCommand("workbench.action.openSettings", "freesek.providers");
  }

  /**
   * Hookify 规则管理（侧边栏「规则」入口 / 命令面板）：列出项目级+用户全局规则，
   * 支持新建 / 查看编辑（打开文件）/ 启用停用 / 删除。规则为 markdown 文件，热加载即时生效。
   */
  async manageHookifyRules() {
    const root = this.workspaceRoot();
    const main = async () => {
      const rules = listHookifyRules(root);
      const items = rules.map((r) => ({
        label: `${r.enabled ? "" : "[停用] "}${r.name}`,
        description: `${r.event} · ${r.action}`,
        detail: r.source,
      }));
      const pick = await vscode.window.showQuickPick(
        [
          { label: "＋ 新建规则", detail: "创建一个新的 hookify markdown 规则" },
          ...items,
        ],
        { title: `Hookify 规则（${rules.length} 条）` }
      );
      if (!pick) return;
      // 新建规则
      if (pick.label === "＋ 新建规则") {
        await this.createHookifyRuleFlow(root);
        return;
      }
      const source = pick.detail;
      const action = await vscode.window.showQuickPick(
        [
          { label: "查看 / 编辑", detail: "用编辑器打开规则文件" },
          { label: "启用 / 停用", detail: "切换 enabled 状态" },
          { label: "删除", detail: "删除该规则文件（不可恢复）" },
        ],
        { title: `规则 ${pick.label}` }
      );
      if (!action) return;
      if (action.label === "查看 / 编辑") {
        const uri = vscode.Uri.file(source);
        const doc = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(doc, { preview: true });
      } else if (action.label === "启用 / 停用") {
        const rule = rules.find((r) => r.source === source);
        const res = toggleHookifyRule(source, !rule?.enabled);
        vscode.window.showInformationMessage(
          res.ok ? `已${rule?.enabled ? "停用" : "启用"}规则「${pick.label}」。` : `操作失败：${res.error}`
        );
      } else if (action.label === "删除") {
        const cf = await vscode.window.showWarningMessage(
          `确定删除规则「${pick.label}」？此操作不可恢复。`,
          { modal: true },
          "删除"
        );
        if (cf === "删除") {
          const res = deleteHookifyRule(source);
          vscode.window.showInformationMessage(res.ok ? "已删除规则。" : `删除失败：${res.error}`);
        }
      }
    };
    await main();
    // 支持在管理面板内连续操作（新建/删除后刷新列表）
    void vscode.commands.executeCommand("freesek.chatView.focus");
  }

  /**
   * 管理已安装的专家套件：列出注册表登记的全部套件，选择后可查看文件清单或卸载。
   * 卸载（逆操作）依据 kits.json 注册表删除套件安装的文件，不触碰用户自建内容。
   */
  async manageKits() {
    const root = this.workspaceRoot();
    if (!root) {
      vscode.window.showWarningMessage("FreeSeek：请先打开一个工作区文件夹，再管理已安装套件。");
      return;
    }
    const records = listInstalledKits(root);
    const pick = await vscode.window.showQuickPick(
      records.length
        ? records.map((r: KitRecord) => ({
            label: r.name,
            description: `v${r.version ?? "?"} · ${r.files.length} 个文件`,
            detail: r.installedAt ? `安装于 ${new Date(r.installedAt).toLocaleString()}` : "",
          }))
        : [{ label: "（暂无已安装套件）", description: "可通过「安装专家套件」安装", detail: "" }],
      { title: `已安装专家套件（${records.length}）` }
    );
    if (!pick || pick.label.startsWith("（暂无")) return;
    const rec = records.find((r) => r.name === pick.label);
    if (!rec) return;
    const action = await vscode.window.showQuickPick(
      [
        { label: "查看文件清单", detail: `${rec.files.length} 个文件` },
        { label: "卸载套件", detail: "删除该套件安装的全部文件（不影响用户自建内容）" },
      ],
      { title: `套件 ${rec.name}` }
    );
    if (!action) return;
    if (action.label === "查看文件清单") {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.file(path.join(root, ".agent", "kits.json"))
      );
      await vscode.window.showTextDocument(doc, { preview: true });
    } else if (action.label === "卸载套件") {
      const cf = await vscode.window.showWarningMessage(
        `确定卸载套件「${rec.name}」？将删除其安装的 ${rec.files.length} 个文件。`,
        { modal: true },
        "卸载"
      );
      if (cf === "卸载") {
        const res = uninstallKit(root, rec.name);
        vscode.window.showInformationMessage(`FreeSeek：${res.message}`);
      }
    }
    void vscode.commands.executeCommand("freesek.chatView.focus");
  }

  /** 新建规则的交互流程：名称 → 事件 → 动作 → 匹配串 → 提示语。 */
  private async createHookifyRuleFlow(root: string) {
    if (!root) {
      vscode.window.showWarningMessage("FreeSeek：请先打开一个工作区文件夹，再创建 Hookify 规则。");
      return;
    }
    const name = await vscode.window.showInputBox({
      prompt: "规则名称（仅字母/数字/下划线/连字符）",
      placeHolder: "如 block-dangerous-rm",
    });
    if (!name) return;
    const eventPick = await vscode.window.showQuickPick(
      [
        { label: "bash", detail: "命令执行前（run_command / run_code）" },
        { label: "file", detail: "文件编辑前（edit_file / write_file）" },
        { label: "prompt", detail: "用户提交提示时" },
        { label: "stop", detail: "会话结束时" },
        { label: "all", detail: "所有事件" },
      ],
      { title: "选择规则触发事件" }
    );
    if (!eventPick) return;
    const event = eventPick.label as HookifyEvent;
    const actionPick = await vscode.window.showQuickPick(
      [
        { label: "warn", detail: "命中时仅警告（默认）" },
        { label: "block", detail: "命中时阻断执行" },
        { label: "command", detail: "命中时执行外部命令（需开启 allow）" },
      ],
      { title: "选择命中动作" }
    );
    if (!actionPick) return;
    const action = actionPick.label as HookifyAction;
    let pattern: string | undefined;
    let command: string | undefined;
    if (action === "command") {
      command = await vscode.window.showInputBox({ prompt: "外部命令", placeHolder: "如 node hook.js" });
      if (!command) return;
    } else {
      pattern = await vscode.window.showInputBox({
        prompt: "匹配正则（作用于事件主字段，如命令文本/文件内容）",
        placeHolder: "如 rm\\s+-rf",
        validateInput: (v) => {
          if (!v.trim()) return "";
          return validateHookifyPattern(v) ? "" : "不是合法的正则表达式";
        },
      });
      if (pattern === undefined) return;
    }
    const message = await vscode.window.showInputBox({
      prompt: "命中时提示语（markdown 正文，可留空）",
      placeHolder: "如：禁止递归删除",
    });
    const res = createHookifyRule(root, name, { event, action, pattern, command, message: message ?? "" });
    if (res.ok) {
      vscode.window.showInformationMessage(`已创建规则「${name}」，可在管理面板中打开编辑。`);
    } else {
      vscode.window.showErrorMessage(`创建失败：${res.error}`);
    }
  }

  /** 连通性测试（参照 CodeBuddy「保存，测试连通」）：调用 /models 探测服务是否可达、鉴权是否有效。 */
  private async testProviderConnection(p: ProviderConfig): Promise<boolean> {
    try {
      const base = (p.baseUrl || "").replace(/\/+$/, "");
      const apiKey = interpolateSecret(p.apiKey);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (apiKey && p.authType !== "none") {
        if (p.authType === "x-api-key") headers["x-api-key"] = apiKey;
        else if (p.authType === "x-goog-api-key") headers["x-goog-api-key"] = apiKey;
        else headers["authorization"] = `Bearer ${apiKey}`;
      }
      if (p.format === "claude") headers["anthropic-version"] = "2023-06-01";
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      // 不同格式的模型列表端点不同：openai/claude 用 /models，gemini 用 /models（官方也支持）
      const res = await fetch(`${base}/models`, { headers, signal: ctrl.signal });
      clearTimeout(timer);
      return res.ok || res.status === 401; // 401 说明服务可达但 Key 无效（也算"连通"但需提示）
    } catch {
      return false;
    }
  }

  private skillManager(root: string): SkillManager {
    if (!this._skillMgr) {
      // 注入可用工具名集合：技能 tools 声明在 loadSkill 时校验（缺失提示不阻塞）
      const toolNames = getAllToolDefinitions().map((t) => t.function.name);
      this._skillMgr = new SkillManager(
        [
          path.join(root, ".agent", "skills"),
          path.join(root, "skills"),
          defaultUserSkillsDir(), // 用户级技能目录（技能沉淀器的落盘位置，pending 需审核后启用）
        ],
        { availableTools: toolNames }
      );
    }
    return this._skillMgr;
  }

  /** 向 webview 下发最新技能列表（技能管理 UI 刷新用）。 */
  private pushSkillList(webview: vscode.Webview) {
    webview.postMessage({
      type: "skills_list",
      skills: this.skillManager(this.workspaceRoot()).listAll().map((s) => ({
        name: s.name,
        description: s.description,
        triggers: s.triggers,
        status: s.status,
        builtin: !!s.builtin,
      })),
    });
  }

  /** 读取当前 MCP 配置。 */
  private getMcpConfig(): McpServerConfig[] {
    return (
      vscode.workspace.getConfiguration("freesek").get<McpServerConfig[]>("mcpServers", []) || []
    );
  }

  /** 向 webview 下发 MCP server 列表（管理面板渲染用）。 */
  private pushMcpServers(webview: vscode.Webview) {
    webview.postMessage({
      type: "mcp_servers",
      servers: mcpManager.listServers(this.getMcpConfig()),
    });
  }

  /** 向 webview 下发最近会话列表（顶栏会话 Tab 渲染用）。 */
  private pushRecentSessions(webview: vscode.Webview) {
    try {
      const recent = this.activeSessions()
        .slice(0, 6)
        .map((s) => ({ id: s.id, title: s.title || "未命名" }));
      webview.postMessage({ type: "recent_sessions", sessions: recent, current: this.currentSessionId });
    } catch {
      /* 无索引时忽略 */
    }
  }

  /** 「管理 MCP」命令：聚焦侧栏并让前端打开 MCP 管理面板。 */
  manageMCP(): void {
    const view = this.view;
    if (!view) return;
    // 确保 webview 已加载（可能为首次 focus 后立即调用，稍等一拍）
    setTimeout(() => {
      this.pushMcpServers(view.webview);
      view.webview.postMessage({ type: "open_mcp_panel" });
    }, 150);
  }

  /** 打开「添加模型」webview 内弹窗（对齐 CodeBuddy，替代 vscode 顶部原生输入框）。 */
  openAddModelModal(): void {
    const view = this.view;
    if (!view) return;
    setTimeout(() => {
      view.webview.postMessage({ type: "open_add_model" });
    }, 120);
  }

  private toolInventory(): string {
    return getAllToolDefinitions()
      .map((t) => `- ${t.function.name}: ${t.function.description}`)
      .join("\n");
  }

  private buildSystemPrompt(root: string): string {
    const cfg = vscode.workspace.getConfiguration("freesek");
    const custom = cfg.get<string>("systemPrompt", "");
    const base = custom && custom.trim() ? custom : SYSTEM_PROMPT;
    // 按当前激活 provider 的 toolMode 决定是否追加 ReAct 文本协议
    const toolMode = getActiveToolMode();

    // 模型可见上下文纪律（对标 Codex bounded fragments）：每个片段有界、总量有硬上限、
    // 关键协议绝不参与组装（末尾追加，永不被截断）。所有动态注入内容统一走组装器，
    // 并收敛为 ContextualFragment 契约（key/kind/source/indexOnly），供回放审计。
    const frags: ContextualFragment[] = [
      { title: "", content: base, key: "system-core", kind: "core", priority: -1000 },
      // 当前时间注入：让模型感知"现在"（长会话中由 handleUser 轻量刷新，不重建整段 prompt）
      { title: "", content: currentTimeBlock(), key: "time", kind: "time" },
    ];

    // Layer 1：分层规则（AGENTS.md / CLAUDE.md / .agent 自动加载）
    const rules = loadRules(root);
    if (rules.trim()) {
      frags.push({
        title: "项目规则（由 AGENTS.md / CLAUDE.md / .agent 自动加载）",
        content: rules,
        key: "rules",
        kind: "rules",
        source: root,
      });
    }

    // 压缩前快照（PreCompact Hook 钉住的任务目标，跨自动压缩持久）
    const compactState = loadLastCompactState(root);
    if (compactState.trim()) {
      frags.push({ title: "", content: compactState, key: "compact-state", kind: "goal" });
    }

    // Layer 3：技能索引（渐进式披露，仅标题+描述；按活动文件目录做技能路径绑定）
    const sm = this.skillManager(root);
    if (sm.hasSkills()) {
      const active = vscode.window.activeTextEditor?.document.uri.fsPath;
      const rel = active ? path.relative(root, active) : "";
      const wd =
        rel && !rel.startsWith("..") && !path.isAbsolute(rel)
          ? path.dirname(rel).replace(/\\/g, "/")
          : ".";
      frags.push({ title: "", content: sm.getSummary(wd), key: "skills", kind: "skills", indexOnly: true });
    }

    // 记忆（跨会话持久层：用户级 + 项目级 .agent/memory）
    const mem = loadMemorySection(root, this.storage.userMemoryPath());
    frags.push({
      title: "记忆（跨会话持久）",
      content:
        mem.trim() ||
        "（暂无记忆。若发现值得长期记住的偏好/约定/坑，可让 Agent 用 remember 工具记录。）",
      key: "memory",
      kind: "memory",
    });

    // 工作流指引：任务规划（TodoWrite）+ 子智能体编排（spawn_agent）
    frags.push({ title: "", content: WORKFLOW_GUIDANCE, key: "workflow", kind: "guidance" });

    // 当前目标（goal 状态机）：跨压缩/跨会话持久，恢复历史会话后自动重新注入，
    // 让模型在上下文重建后仍锚定主线目标（对标 Claude Code 的 goal + preCompact 组合）。
    const goalState = loadGoalState(root);
    if (goalState.objective && goalState.phase !== "complete") {
      frags.push({ title: "当前目标（goal）", content: renderGoalView(goalState), key: "goal", kind: "goal" });
    }

    // 可用子代理清单（对齐 CodeBuddy Subagents 的 description 自动路由）：
    // 把内置 + 用户自定义角色的 name/description 注入主系统提示词，让主 Agent 主动判断何时派发哪个。
    const subagents = listRolePresets();
    if (subagents.length) {
      const lines = subagents
        .map((s) => `- ${s.name}（${s.executor ? "可执行" : "只读"}）：${s.description}`)
        .join("\n");
      frags.push({
        title: "可用子代理（spawn_agent 的 role 参数，按 description 自动选）",
        content: `${lines}\n\n根据任务性质自动选择最合适的子代理：需要探索/理解用只读类（explore/plan），需要验证用 verify，需要实际改动/执行用 executor 类（general）。`,
        key: "subagents",
        kind: "subagents",
      });
    }

    // 质量门禁：autoVerify 开启时注入「验证闭环」引导（写→跑→修）
    if (cfg.get<boolean>("autoVerify", true)) {
      frags.push({ title: "", content: VERIFY_GUIDANCE, key: "verify", kind: "guidance" });
    }

    // 上下文压缩认知：纠正"模型是否支持压缩"的口径，避免小模型误答"不支持"
    frags.push({ title: "", content: CONTEXT_COMPRESSION_GUIDANCE, key: "compression", kind: "guidance" });

    // 工具清单（动态生成，含全部可用工具 + 已连接 MCP server 的工具；索引型，渐进式披露）
    frags.push({ title: "工具清单", content: this.toolInventory(), key: "tools", kind: "tools", indexOnly: true });
    // 连接器插件（conn__<id>__<tool> 前缀的工具由对应连接器执行）
    const cs = connectorSummary();
    if (cs) frags.push({ title: "可用连接器", content: cs, key: "connectors", kind: "connectors", indexOnly: true });

    // MCP resources / prompts（对齐 Claude Code / CodeBuddy 的 MCP 扩展）：用 mcp_read_resource / mcp_get_prompt 访问
    const rs = mcpManager.resourceSummary();
    if (rs) frags.push({ title: "可用 MCP 资源", content: `${rs}\n用 mcp_read_resource 读取某个 resource 的内容。`, key: "mcp-resources", kind: "mcp", indexOnly: true });
    const ps = mcpManager.promptSummary();
    if (ps) frags.push({ title: "可用 MCP 提示词", content: `${ps}\n用 mcp_get_prompt 获取某个 prompt 模板。`, key: "mcp-prompts", kind: "mcp", indexOnly: true });
    // 知识库接入（FreeSeek 只做工具接线）：用 mcp_kb_search / mcp_list_kb 检索外部知识库
    const ks = mcpManager.knowledgeSummary();
    if (ks) frags.push({ title: "可用 MCP 知识库（外部）", content: `${ks}\n用 mcp_list_kb 列出来源、mcp_kb_search 检索（FreeSeek 仅做工具接线，不内置知识库）。`, key: "mcp-kb", kind: "mcp", indexOnly: true });

    // Slash 自定义命令（项目 .agent/commands/）：让 Agent 知道有哪些预设工作流可用
    const slashCmds = loadCommands(root);
    if (slashCmds.length) {
      frags.push({
        title: "可用 Slash 命令（项目 .agent/commands/）",
        content:
          slashCmds.map((c) => `- /${c.name}: ${c.description}`).join("\n") +
          `\n你可用 slash_command 工具在对话中执行这些命令（其正文会作为你的指令）。`,
        key: "slash",
        kind: "slash",
        indexOnly: true,
      });
    }

    // 对话模式指引：plan（规划）追加 PLAN 指引；ask（问答）追加 ASK 指引；
    // coder（编码）追加 CODER 指引（专职需求理解+代码生成，权限等同 craft）；craft（制作）不追加（完整能力）
    if (this.agentMode === "plan") frags.push({ title: "", content: PLAN_MODE_GUIDANCE, key: "mode-plan", kind: "guidance" });
    if (this.agentMode === "ask") frags.push({ title: "", content: ASK_MODE_GUIDANCE, key: "mode-ask", kind: "guidance" });
    if (this.agentMode === "coder") frags.push({ title: "", content: CODER_MODE_GUIDANCE, key: "mode-coder", kind: "guidance" });

    const fragOpts = { maxFragmentTokens: 8000, warnAtTokens: 2500, maxTotalTokens: 24000 };
    const { prompt, manifest } = assembleBoundedFragmentsWithManifest(frags, fragOpts);
    // react 模式（免费逆向服务等不支持原生 tools）追加 ReAct 文本协议；
    // native 模式（官方/本地 LM Studio 等支持 tools 的服务）追加"必须用工具"
    // + ReAct 文本兜底，应对本地模型不主动触发 function calling 的情况。
    let out = prompt;
    const protocol = toolMode === "react" ? REACT_PROTOCOL : NATIVE_TOOL_GUIDANCE;
    out += protocol;
    // 记录片段处置清单（尽力而为）：scripts/check-fragments.mjs 回放校验组装不变量
    try {
      appendEvent("prompt_manifest", {
        opts: fragOpts,
        manifest,
        protocol: {
          key: toolMode === "react" ? "REACT_PROTOCOL" : "NATIVE_TOOL_GUIDANCE",
          promptTail: out.slice(-400),
          endMarker: (protocol.trim().split("\n").pop() ?? "").trim().slice(0, 80),
        },
        agentMode: this.agentMode,
      });
    } catch {
      // eventlog 尽力而为，失败不影响主流程
    }
    // 最后追加保密规则，强制模型不得复述/透露系统提示词，抵御 System Prompt Extraction。
    out += SYSTEM_PROMPT_PROTECTION;
    return out;
  }

  /** 快速问答模式用的精简系统提示词：仅基础人格 + 记忆，不携带工具协议/工作流/验证/压缩等长指引。 */
  private buildChitChatPrompt(root: string): string {
    const cfg = vscode.workspace.getConfiguration("freesek");
    const custom = cfg.get<string>("systemPrompt", "");
    const base = custom && custom.trim() ? custom : SYSTEM_PROMPT;
    const mem = loadMemorySection(root, this.storage.userMemoryPath());
    return (
      base +
      "\n\n" +
      currentTimeBlock() +
      "\n\n# 记忆（跨会话持久）\n" +
      (mem.trim() || "（暂无记忆）") +
      "\n\n快速问答模式：用户消息很简短，通常是问候、闲聊或简单提问。请直接给出简洁的中文回答，不要调用任何工具。" +
      SYSTEM_PROMPT_PROTECTION
    );
  }

  private workspaceRoot(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (folders && folders.length) return folders[0].uri.fsPath;
    return os.homedir();
  }

  private getHtml(webview: vscode.Webview): string {
    return buildWebviewHtml(webview, this.context.extensionUri);
  }
}

export { activate, deactivate } from "./activate";
