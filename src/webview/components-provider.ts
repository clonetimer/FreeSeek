import { el } from "./components-base";
import { ui } from "./state";
import { DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_OFFICIAL_BASE_URL, DEEPSEEK_PRO_MODEL } from "../deepseek";

// 实时拉取模型列表的回调注册表：主进程 fetch_models_result 消息到达时派发。
type FetchModelsListener = (res: { reqId?: number; models?: string[]; error?: string }) => void;
let fetchModelsListeners: FetchModelsListener[] = [];

export function addFetchModelsListener(fn: FetchModelsListener): void {
  fetchModelsListeners.push(fn);
}
/** 由 main.ts 的 fetch_models_result 消息分发调用。 */
export function dispatchFetchModelsResult(res: { reqId?: number; models?: string[]; error?: string }): void {
  const list = fetchModelsListeners;
  fetchModelsListeners = [];
  for (const fn of list) fn(res);
}

const ADD_PROVIDER_PRESETS: Array<{ id: string; name: string; baseUrl: string; format: string; authType?: "none" | "bearer"; models: string; envKey: string; autoDiscover?: boolean }> = [
  { id: "deepseek", name: "DeepSeek", baseUrl: DEEPSEEK_OFFICIAL_BASE_URL, format: "openai", models: `${DEEPSEEK_DEFAULT_MODEL}, ${DEEPSEEK_PRO_MODEL}`, envKey: "DEEPSEEK_API_KEY" },
  { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1", format: "openai", models: "openrouter/auto", envKey: "OPENROUTER_API_KEY" },
  { id: "siliconflow", name: "硅基流动", baseUrl: "https://api.siliconflow.cn/v1", format: "openai", models: "Qwen/Qwen2.5-72B-Instruct", envKey: "SILICONFLOW_API_KEY" },
  { id: "moonshot", name: "Moonshot Kimi", baseUrl: "https://api.moonshot.cn/v1", format: "openai", models: "kimi-k2-instruct", envKey: "MOONSHOT_API_KEY" },
  { id: "qwen", name: "阿里通义千问", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", format: "openai", models: "qwen-plus", envKey: "DASHSCOPE_API_KEY" },
  { id: "zhipu", name: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4", format: "openai", models: "glm-4-plus", envKey: "ZHIPU_API_KEY" },
  { id: "tencent-hunyuan", name: "腾讯云混元", baseUrl: "https://api.hunyuan.cloud.tencent.com/v1", format: "openai", models: "hunyuan-turbo, hunyuan-pro", envKey: "TENCENT_HUNYUAN_API_KEY" },
  { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1", format: "openai", models: "gpt-4o-mini", envKey: "OPENAI_API_KEY" },
  { id: "ollama", name: "Ollama 本地", baseUrl: "http://127.0.0.1:11434/v1", format: "openai", authType: "none", models: "", envKey: "", autoDiscover: true },
  { id: "lmstudio", name: "LM Studio 本地", baseUrl: "http://127.0.0.1:1234/v1", format: "openai", authType: "none", models: "", envKey: "", autoDiscover: true },
  { id: "custom", name: "自定义 / 其它服务商", baseUrl: "", format: "openai", models: "", envKey: "" },
];

/** 打开「添加模型」弹窗表单（对齐 CodeBuddy：一个弹窗填完 + 顶部提示 + 文档链接 + 紧凑 3 字段）。 */
export function openAddProviderModal(): void {
  const overlay = el("div", "modal-overlay");
  const box = el("div", "modal");
  // 标题栏：标题 + 关闭按钮
  const titleBar = el("div", "modal-title modal-title-row");
  titleBar.appendChild(el("span", "", "添加模型"));
  const closeBtn = el("button", "modal-close", "×") as HTMLButtonElement;
  closeBtn.addEventListener("click", () => overlay.remove());
  titleBar.appendChild(closeBtn);
  box.appendChild(titleBar);

  const body = el("div", "modal-body");
  // 顶部提示：需要 OpenAI 兼容的 API Key + 查看文档链接（对齐 CodeBuddy 黄色提示）
  const hint = el("div", "add-prov-hint");
  hint.innerHTML = '<span class="add-prov-tag">提示</span> 云端服务通常需要 API Key；本地服务可无认证';
  const docLink = el("a", "add-prov-doc", "查看文档") as HTMLAnchorElement;
  docLink.href = "#provider-doc"; // 实际点击由 extension host 打开本扩展 README
  docLink.target = "_blank";
  docLink.rel = "noopener";
  docLink.addEventListener("click", (e) => { e.preventDefault(); ui.post({ type: "open_provider_doc" }); });
  hint.appendChild(docLink);
  body.appendChild(hint);

  // 输入框统一样式
  const inputCss = "width:100%;box-sizing:border-box;padding:6px 8px;border-radius:var(--radius-sm);" +
    "border:1px solid var(--vscode-input-border,rgba(127,127,127,.3));background:var(--vscode-input-background,transparent);" +
    "color:var(--vscode-foreground);outline:none;";
  const selectCss = inputCss;
  const mkRow = (icon: string, label: string) => {
    const row = el("div", "add-prov-row");
    const ico = el("span", "add-prov-ico", icon);
    const lab = el("div", "add-prov-lab", label);
    row.appendChild(ico); row.appendChild(lab);
    return row;
  };

  // ── 服务商下拉（带 Cloud 图标）──
  body.appendChild(mkRow("☁", "服务商"));
  const presetSel = document.createElement("select");
  presetSel.className = "add-prov-sel";
  presetSel.style.cssText = selectCss + "margin:2px 0 12px;";
  ADD_PROVIDER_PRESETS.forEach((p) => {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.name;
    presetSel.appendChild(o);
  });
  body.appendChild(presetSel);

  // ── API KEY（带眼睛图标：显示/隐藏明文）──
  body.appendChild(mkRow("🔑", "API KEY"));
  const keyWrap = el("div", "add-prov-keywrap");
  keyWrap.style.cssText = "position:relative;margin:2px 0 12px;";
  const keyInput = document.createElement("input");
  keyInput.type = "password";
  keyInput.placeholder = "请输入 API Key";
  keyInput.style.cssText = inputCss + "padding-right:28px;";
  const eyeBtn = el("button", "add-prov-eye", "👁") as HTMLButtonElement;
  eyeBtn.type = "button";
  eyeBtn.title = "显示/隐藏";
  eyeBtn.style.cssText = "position:absolute;right:4px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:var(--vscode-foreground);cursor:pointer;opacity:.7;";
  eyeBtn.addEventListener("click", () => {
    keyInput.type = keyInput.type === "password" ? "text" : "password";
  });
  keyWrap.appendChild(keyInput);
  keyWrap.appendChild(eyeBtn);
  body.appendChild(keyWrap);

  // ── 模型名称下拉（含 Auto + 预设的常用模型；按所选服务商预填）──
  body.appendChild(mkRow("🏷", "模型名称"));
  const modelWrap = el("div", "add-prov-modelrow");
  modelWrap.style.cssText = "display:flex;gap:6px;margin:2px 0 4px;align-items:center;";
  const modelSel = document.createElement("select");
  modelSel.className = "add-prov-sel";
  modelSel.style.cssText = selectCss + "flex:1;";
  // Auto 永远第一个
  const autoOpt = document.createElement("option");
  autoOpt.value = ""; autoOpt.textContent = "Auto";
  modelSel.appendChild(autoOpt);
  modelWrap.appendChild(modelSel);
  // 实时获取模型按钮：调用 {baseUrl}/models 拉取官方模型列表
  const fetchBtn = el("button", "add-prov-fetch", "⟳ 获取模型") as HTMLButtonElement;
  fetchBtn.type = "button";
  fetchBtn.title = "从该服务商官网接口实时拉取可用模型列表（需已填 Base URL 与 API Key）";
  fetchBtn.style.cssText = "padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--vscode-panel-border);" +
    "background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);" +
    "cursor:pointer;font-size:12px;white-space:nowrap;";
  modelWrap.appendChild(fetchBtn);
  // 测试连接按钮：用当前 Base URL + API Key 探测接口是否可达（GET /models）
  const testBtn = el("button", "add-prov-fetch", "🛈 测试连接") as HTMLButtonElement;
  testBtn.type = "button";
  testBtn.title = "用当前 Base URL 与 API Key 探测接口是否可达（不消耗额度）";
  testBtn.style.cssText = "padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--vscode-panel-border);" +
    "background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);" +
    "cursor:pointer;font-size:12px;white-space:nowrap;margin-left:6px;";
  modelWrap.appendChild(testBtn);
  body.appendChild(modelWrap);
  // 模型下拉下方提示（实时拉取状态/结果数）
  const modelHint = el("div", "add-prov-err");
  modelHint.style.cssText = "color:var(--vscode-descriptionForeground);font-size:11px;margin:0 0 8px;opacity:.8;";
  body.appendChild(modelHint);
  // 手动指定模型输入框：当服务商不暴露 /models 列表（学校/企业网关常见）时兜底，避免卡在「获取模型」
  const modelManualInput = document.createElement("input");
  modelManualInput.type = "text";
  modelManualInput.placeholder = "该服务未暴露模型列表，请手动填写模型名（如 your_model_id）";
  modelManualInput.style.cssText = inputCss + "display:none;margin:4px 0 8px;";
  body.appendChild(modelManualInput);
  /** 显示/隐藏手动模型框，并同步到 currentModels 供保存时选用。 */
  function setManualModelVisible(v: boolean, prefill?: string) {
    modelManualInput.style.display = v ? "block" : "none";
    if (v && prefill) modelManualInput.value = prefill;
    if (!v) modelManualInput.value = "";
  }

  // ── 模型上下文窗口（可选，token 数）：本地小模型（LM Studio 8K/16K）必须填写，否则请求先超窗被拒 ──
  body.appendChild(mkRow("📐", "上下文窗口 (可选)"));
  const ctxInput = document.createElement("input");
  ctxInput.type = "text";
  ctxInput.placeholder = "如 8192 / 16384 / 32768；云端大窗口可留空";
  ctxInput.title = "模型实际 context 大小（token 数）。本地小模型建议填，如 LM Studio 的 8192；云端 DeepSeek 等可留空";
  ctxInput.style.cssText = inputCss + "margin:2px 0 12px;";
  body.appendChild(ctxInput);

  // 实时拉取：当前 modal 的请求 id（去重，避免过期响应覆盖新选择）
  let fetchReqId = 0;
  fetchBtn.addEventListener("click", () => {
    const p = ADD_PROVIDER_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    const base = (presetSel.value === "custom" ? baseInput.value.trim() : currentBaseUrl).replace(/\/+$/, "");
    if (!base) {
      modelHint.textContent = "⚠ 请先填写 Base URL（自定义服务需在下方填写）。";
      modelHint.style.color = "var(--vscode-errorForeground,var(--fs-err))";
      return;
    }
    // 本地服务（Ollama / LM Studio）无需 Key 也能拉取；云端若报 401 会在结果里提示。
    const key = keyInput.value.trim();
    fetchReqId++;
    fetchBtn.disabled = true;
    fetchBtn.textContent = "⟳ 获取中…";
    modelHint.style.color = "var(--vscode-descriptionForeground)";
    modelHint.textContent = "正在从服务商接口拉取模型列表…";
    // 注册一次性回调，等待主进程返回 fetch_models_result
    addFetchModelsListener((res) => {
      // reqId 后端以字符串返回、前端为数字，统一转数字比较，避免类型不一致导致永远不返回
      if (Number(res.reqId) !== fetchReqId) return;
      fetchBtn.disabled = false;
      fetchBtn.textContent = "⟳ 获取模型";
      if (res.error) {
        modelHint.textContent = "⚠ " + res.error;
        modelHint.style.color = "var(--vscode-errorForeground,var(--fs-err))";
        // 兜底：服务未暴露 /models 列表（超时 / 404 / 网关拦截均常见），允许手动填写模型名继续
        const is401 = /401/.test(res.error);
        setManualModelVisible(true, currentModels[0] || "your_model_id");
        modelHint.textContent = is401
          ? "⚠ " + res.error + "（路径可达但 Key 无效；请检查 API Key）"
          : "⚠ 该服务未暴露 /models 列表（学校/企业网关常见）。请在下方手动填写模型名后继续。";
        return;
      }
      const models = (res.models || []) as string[];
      if (!models.length) {
        modelHint.textContent = "⚠ 接口未返回任何模型。";
        modelHint.style.color = "var(--vscode-errorForeground,var(--fs-err))";
        return;
      }
      // 用拉取到的模型重建下拉（保留 Auto）
      modelSel.innerHTML = "";
      modelSel.appendChild(autoOpt);
      for (const m of models) {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        modelSel.appendChild(o);
      }
      modelHint.textContent = `✔ 已获取 ${models.length} 个模型（选择 Auto 将全部使用）。`;
      modelHint.style.color = "var(--vscode-charts-green,var(--fs-ok))";
      // 探测成功则收起手动框（防止上一次失败的残留）
      setManualModelVisible(false);
      // 同步 currentModels，使选 Auto 时保存全部拉取到的模型
      currentModels = models;
    });
    ui.post({ type: "fetch_models", baseUrl: base, apiKey: key, reqId: fetchReqId });
  });

  // 测试连接：探测接口可达性（GET /models，带 Key），不透传内容
  let testReqId = 0;
  testBtn.addEventListener("click", () => {
    const p = ADD_PROVIDER_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    const base = (presetSel.value === "custom" ? baseInput.value.trim() : currentBaseUrl).replace(/\/+$/, "");
    if (!base) {
      modelHint.textContent = "⚠ 请先填写 Base URL（自定义服务需在下方填写）。";
      modelHint.style.color = "var(--vscode-errorForeground,var(--fs-err))";
      return;
    }
    const key = keyInput.value.trim();
    testReqId++;
    testBtn.disabled = true;
    testBtn.textContent = "🛈 测试中…";
    modelHint.style.color = "var(--vscode-descriptionForeground)";
    modelHint.textContent = "正在探测接口可达性…";
    addFetchModelsListener((res) => {
      if (Number(res.reqId) !== testReqId) return;
      testBtn.disabled = false;
      testBtn.textContent = "🛈 测试连接";
      if (res.error) {
        const is401 = /401/.test(res.error);
        modelHint.textContent = is401
          ? "⚠ 接口可达但 Key 无效：" + res.error
          : "⚠ 接口不可达：" + res.error + "（可能未暴露 /models；可手动填写模型名后保存）";
        modelHint.style.color = "var(--vscode-errorForeground,var(--fs-err))";
        if (!is401) setManualModelVisible(true, currentModels[0] || "your_model_id");
        return;
      }
      // 测试连接成功收起手动框
      setManualModelVisible(false);
      modelHint.textContent = `✔ 接口正常（返回 ${res.models?.length ?? 0} 个模型，API Key 已生效）。`;
      modelHint.style.color = "var(--vscode-charts-green,var(--fs-ok))";
    });
    ui.post({ type: "test_connection", baseUrl: base, apiKey: key, reqId: testReqId });
  });

  // 错误提示
  const errHint = el("div", "add-prov-err");
  errHint.style.cssText = "color:var(--vscode-errorForeground,var(--fs-err));font-size:12px;margin:4px 0;display:none;";
  body.appendChild(errHint);

  // 当前选中的预设（保存/取消按钮用其 baseUrl/autoDiscover/models）
  let currentBaseUrl = "";
  let currentAutoDiscover = false;
  let currentModels: string[] = [];

  // 预设选择 → 自动填充 KEY 引用 + 刷新模型下拉
  const applyPreset = () => {
    const p = ADD_PROVIDER_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    currentBaseUrl = p.baseUrl;
    currentAutoDiscover = !!p.autoDiscover;
    currentModels = p.models ? p.models.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean) : [];
    if (p.envKey && !keyInput.value) keyInput.value = `\${env:${p.envKey}}`;
    // 刷新模型下拉
    modelSel.innerHTML = "";
    modelSel.appendChild(autoOpt);
    for (const m of currentModels) {
      const o = document.createElement("option");
      o.value = m; o.textContent = m;
      modelSel.appendChild(o);
    }
    // 自定义：允许用户输入（保留 Auto 即可）
    if (p.id === "custom") {
      modelSel.innerHTML = "";
      modelSel.appendChild(autoOpt);
      // 自定义服务还需 Base URL 输入（动态加）
    }
  };
  presetSel.addEventListener("change", applyPreset);
  applyPreset();

  // 错误提示
  // 额外：自定义服务的 Base URL 输入（紧贴服务商下拉）
  const baseInput = document.createElement("input");
  baseInput.type = "text";
  baseInput.placeholder = "https://.../v1（仅自定义需要）";
  baseInput.style.cssText = inputCss + "display:none;margin:0 0 12px;";
  body.appendChild(baseInput);
  const checkCustom = () => {
    baseInput.style.display = presetSel.value === "custom" ? "block" : "none";
  };
  presetSel.addEventListener("change", checkCustom);
  checkCustom();

  box.appendChild(body);
  const btns = el("div", "modal-btns");
  const cancel = el("button", "", "取消") as HTMLButtonElement;
  cancel.addEventListener("click", () => overlay.remove());
  const save = el("button", "primary", "保存") as HTMLButtonElement;
  save.addEventListener("click", () => {
    const p = ADD_PROVIDER_PRESETS.find((x) => x.id === presetSel.value);
    if (!p) return;
    const baseUrl = (presetSel.value === "custom" ? baseInput.value.trim() : currentBaseUrl).replace(/\/+$/, "");
    const name = p.name;
    if (!baseUrl) {
      errHint.textContent = "⚠ 自定义服务需要填写 Base URL。";
      errHint.style.display = "block";
      return;
    }
    const apiKey = keyInput.value.trim();
    // 模型：手动框优先（服务未暴露 /models 时用户自填）；否则选 Auto 时把预设 models 全加入，选具体则单模型
    const manualModel = modelManualInput.style.display !== "none" ? modelManualInput.value.trim() : "";
    const selected = modelSel.value;
    const models = manualModel ? [manualModel] : (selected ? [selected] : currentModels);
    ui.post({
      type: "save_provider",
      name,
      baseUrl,
      apiKey,
      models: models.join(", "),
      toolMode: "native",
      format: p.format,
      authType: p.authType ?? "bearer",
      autoDiscover: currentAutoDiscover,
      contextWindow: ctxInput.value.trim(),
    });
    overlay.remove();
  });
  btns.appendChild(cancel);
  btns.appendChild(save);
  box.appendChild(btns);
  overlay.appendChild(box);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}
