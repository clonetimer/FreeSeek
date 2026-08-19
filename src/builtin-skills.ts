/**
 * 内置技能模板库——随扩展分发、开箱即用的 SOP。
 * 这些模板作为代码内嵌（无需打进磁盘目录），构造 SkillManager 时自动注册为 active。
 * 用户可复制到自己的技能目录后修改定制。
 *
 * 拆分说明：原内嵌于 skills.ts 的 BUILTIN_SKILLS 使其超出行数上限（需 max-lines 豁免）；
 * 现独立成模块以去掉豁免、降低 skills.ts 体量。
 */
export interface BuiltinSkill {
  name: string;
  description: string;
  triggers: string[];
  content: string;
  requires?: string[];
  /** 所需工具声明（loadSkill 时校验，缺失提示不阻塞）。 */
  tools?: string[];
  version?: string;
  author?: string;
  category?: string;
  source?: 'builtin' | 'user' | 'remote';
}

/** 对齐 claude-code .claude-plugin/marketplace.json schema 的内置技能清单（P0-① 元数据登记）。 */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "explore-project",
    description: "了解当前文件夹/项目的功能、架构、入口与使用方式，输出结构化总结（而非仅列文件）",
    version: "1.0.0",
    author: "freeseek",
    category: "explore",
    source: "builtin",
    triggers: [
      "了解文件夹",
      "项目功能",
      "这个文件夹做什么",
      "这个目录做什么",
      "介绍一下这个项目",
      "explore project",
      "项目概述",
      "项目结构",
    ],
    content: `# explore-project

当用户问「这个文件夹/项目是做什么的」、「了解一下当前项目」、「介绍一下这个项目」等探索类问题时，
使用本 SOP，确保给出结构化总结，而不是只列文件名或只返回任务清单。

## 目标
在读取关键文件后，向用户清晰说明：这个项目是干什么的、用了什么技术、主要模块有哪些、如何运行/使用。

## 必做步骤
1. **探查根目录**：用 list_directory 查看当前目录，确认有哪些顶层文件/文件夹。
2. **精读 README**：若存在 README / README.md，必须完整读取（可用 read_file），提取项目定位、功能、安装与使用方式。
3. **精读 package.json / pyproject.toml / Cargo.toml / go.mod 等元数据文件**（视语言而定）：
   - 项目名、版本、描述、作者/仓库
   - 主要依赖与开发依赖
   - scripts / commands / entry points
   - license
4. **扫一眼核心入口**：根据元数据确定入口文件（如 src/extension.ts、src/main.py、src/index.js、cmd/server/main.go 等），用 read_file 读前 60-80 行，了解启动逻辑与核心依赖注入。
5. **勾勒模块结构**：若目录较深，用 glob / list_directory 列出 src/ 下的关键子目录与文件，用一句话概括每个主要目录/文件职责。

## 输出格式（最终回复必须包含，禁止只返回任务清单）
- **一句话总结**：这个项目是做什么的。
- **技术栈**：语言、框架、构建工具、关键库。
- **主要模块/文件**：列出 3-8 个核心文件/目录及其职责。
- **入口与使用方式**：如何安装、如何运行/构建、如何测试（从 README 或 package.json scripts 提取）。
- **值得注意的点**：任何特殊架构、配置、限制或亮眼的工程实践。

## 常见坑
- 不要只列文件名；每个条目必须附带职责说明。
- 不要只调用 todo_write 就结束；todo 只是计划，最终必须按上方格式给出总结。
- 如果 README 缺失或信息不足，如实说明，并根据 package.json / 目录结构给出最合理的推断。`,
  },
  {
    name: "commit-push-pr",
    description: "安全地提交改动、推送到远端并创建 Pull Request（遵循约定式提交与最小化原则）",
    version: "1.0.0",
    author: "freeseek",
    category: "workflow",
    source: "builtin",
    triggers: ["提交", "push", "PR", "pull request", "commit", "git"],
    content: `# commit-push-pr

安全地完成「提交 → 推送 → 建 PR」全流程。

## 目标
把当前工作区改动整理成清晰的提交并推送到远端，创建可审查的 PR。

## 步骤
1. 查看状态：git status --short、git diff --stat，梳理改动归属。
2. 审查改动，剔除临时代码 / 调试输出 / 无关文件（不要 git add . 盲目提交）。
3. 按逻辑拆分提交，提交信息用约定式（feat:/fix:/refactor:/docs:/test:/chore:）。
4. 提交前如有测试/类型检查，先跑 verify 确认通过。
5. git push 到当前分支；若需 force 必须万分谨慎并明确告知用户。
6. 若无远端分支，创建后 push -u；随后 gh pr create（或提示用户在网页创建），写明变更摘要与测试说明。
7. 若网络/git 服务不可用，如实说明卡在哪一步。

## 常见坑
- 不要提交包含密钥、.env、凭据的文件。
- 提交信息不要写"update"，要写清做了什么与为什么。
- PR 描述包含：背景、改动清单、如何验证、有无破坏性变更。`,
  },
  {
    name: "code-review",
    description: "对代码改动进行对抗性代码审查：正确性、安全、性能、可维护性、测试覆盖",
    version: "1.0.0",
    author: "freeseek",
    category: "review",
    source: "builtin",
    triggers: ["review", "代码审查", "审查", "cr", "code review"],
    content: `# code-review

对一段改动（或整个 PR）做结构化、对抗性代码审查。

## 目标
找出真实问题并给出可操作的修复建议，而非泛泛夸奖。

## 步骤
1. 明确审查对象：单文件、多文件 diff，还是整个 PR（用 git diff 或 read_file）。
2. 逐维度检查：
   - 正确性：边界条件、null/undefined、并发、错误处理、竞态。
   - 安全：注入、路径穿越、凭据硬编码、危险 eval、XSS（前端）。
   - 性能：不必要 O(n^2)、重复计算、大对象入上下文。
   - 可维护性：命名、单一职责、魔法数字、重复代码。
   - 测试：关键逻辑是否有测试覆盖、边界是否覆盖。
3. 按严重程度分级输出：🔴 阻断 / 🟡 建议 / 🟢 微小。
4. 每条给出：位置（文件:行）+ 问题 + 具体修复建议。
5. 不要改动代码；如需修复交给主 Agent。

## 常见坑
- 不要只报"这里可能有问题"，要给出证据和改法。
- 区分"风格偏好"与"真实缺陷"，后者优先。`,
  },
  {
    name: "refactor-to-composable",
    description: "把重复/冗长代码重构为可组合的模块（提取函数、抽象共用、保持行为不变）",
    version: "1.0.0",
    author: "freeseek",
    category: "refactor",
    source: "builtin",
    triggers: ["重构", "refactor", "提取函数", "组合", "composable", "可复用"],
    content: `# refactor-to-composable

在不改变外部行为的前提下，把重复、冗长、难维护的代码重构为可组合的模块。

## 目标
提升可读性与可复用性，消灭重复，保持所有测试/行为不变。

## 步骤
1. 先跑 verify（或测试）拿到「重构前」基线，确保绿。
2. 识别重复：搜索相似代码块、相同逻辑分支、耦合的单函数。
3. 设计拆分：按单一职责提取纯函数 / 子组件 / 工具模块；参数化差异部分。
4. 逐处小步重构，每次只改一个点，避免大爆炸式重写。
5. 每步后跑 verify，确认无回归（红则回退该步）。
6. 完成后再次 verify 全绿，并向用户总结：拆成哪些单元、如何组合、收益。

## 常见坑
- 不要在重构中顺手改行为 / 加功能（混入 diff 难审查）。
- 不要过度抽象——只提取确有 2 处以上复用的逻辑。
- 保持对外接口/签名兼容，避免连锁改动。`,
  },
  {
    name: "feature-dev",
    description: "多阶段功能开发工作流（对标 Claude Code feature-dev）：调研→设计→原型→实现→验证→文档→交付，每阶段产出明确交付物",
    version: "1.0.0",
    author: "freeseek",
    category: "workflow",
    source: "builtin",
    triggers: ["开发新功能", "feature", "新功能", "功能开发", "实现需求", "功能规划"],
    content: `# feature-dev

把一个需求从想法推进到可交付的功能，采用 7 阶段工作流（对标 Claude Code feature-dev 插件）。

## 目标
用结构化流程降低大型功能开发的返工率：先想清楚再动手，每阶段有明确交付物与「继续/暂停」决策点。

## 阶段
1. **research（调研）**：读懂需求与现有代码。产出：需求拆解 + 相关模块清单 + 技术风险点。
   - 用 codebase 搜索 / read_file 确认改动波及面；如复杂可用 spawn_agent（role=explore）并行调研。
2. **design（设计）**：产出：方案文档（数据流、接口签名、数据结构、UI 布局、兼容性）。
   - 复杂改动可用 spawn_agent（role=plan）评审设计，识别遗漏。
3. **spike（原型）**：仅对高风险点做最小可运行验证（技术选型、性能、协议对接）。产出：验证结论，可丢弃的临时代码。
4. **implement（实现）**：按设计小步实现。每完成一个逻辑单元就验证一次，不要攒到最后。
   - 用 edit_file 局部修改；保持与项目风格一致。
5. **verify（验证）**：跑类型检查 / 测试 / lint，修复回归。产出：全绿基线。
6. **document（文档）**：更新 README / 注释 / 变更说明；删除 spike 残留的临时代码。
7. **deliver（交付）**：向用户总结：改了什么、如何验证、有何风险；按需 load_skill commit-push-pr 提交。

## 原则
- 阶段 1-2 未确认前不写实现代码（除非用户明确要求直接动手）。
- 每阶段结束向用户汇报交付物，等待明确继续指令（或用户已授权则连续推进）。
- 规模小的功能可合并阶段（如跳过 spike），但 research→implement→verify 不可缺。`,
  },
  {
    name: "multi-agent-code-review",
    description: "多 agent 并行代码审查（对标 Claude Code code-review 插件）：5 个专职审查角色并发执行，按置信度过滤误报后汇总",
    version: "1.0.0",
    author: "freeseek",
    category: "review",
    source: "builtin",
    triggers: ["并行审查", "多角度审查", "deep review", "深度审查", "全面 code review"],
    content: `# multi-agent-code-review

对改动做多 agent 并行对抗性审查：多个专职角色各看一个维度，去重后按置信度分级汇总。

## 目标
用「多视角并行 + 置信度过滤」降低单 agent 审查的盲区与误报（对标 Claude Code code-review 插件）。

## 步骤
1. 明确审查对象与范围（文件列表 / diff / PR），确保各角色拿到相同输入。
2. 并行派发专职角色（用 spawn_agents 或多次 spawn_agent 并发）：
   - **correctness**：正确性——边界、并发、空值、错误处理、竞态。
   - **security**：安全——注入、路径穿越、硬编码凭据、危险 eval、XSS。
   - **performance**：性能——O(n^2)、重复计算、大对象入上下文、资源泄漏。
   - **maintainability**：可维护性——命名、单一职责、魔法数字、重复代码。
   - **tests**：测试覆盖——关键逻辑是否覆盖、边界用例是否缺失。
   每个角色的报告格式：文件:行 + 问题 + 置信度（高/中/低）+ 修复建议。
3. 汇总去重：相同问题的多角色报告合并；置信度「低」且无旁证的条目降级为提示。
4. 按严重程度分级输出：🔴 阻断（高置信度） / 🟡 建议 / 🟢 微小。
5. 不直接改代码；如需修复交给主 Agent。

## 常见坑
- 各角色必须独立并行执行，不要串行等待。
- 置信度过滤防止误报刷屏：低置信度条目单列，不混入阻断清单。
- 若改动很小（<30 行），单角色审查即可，不必强开并行。`,
  },
  {
    name: 'backend-architect',
    description: '后端架构设计工作流：在动手写实现前先交付分层架构（Strategy/Context/Controller）+ 显式错误处理 + 横切关注点 + 架构级测试，避免返工',
    version: '1.0.0',
    author: 'freeseek',
    category: 'architecture',
    source: 'builtin',
    tools: ['list_directory', 'read_file', 'write_file', 'run_command'],
    triggers: ['后端架构', 'backend architect', '后端设计', '系统架构', '分层设计', 'api 设计', '服务划分', '架构评审'],
    content: `# backend-architect

在写实现之前先交付架构：冻结接口与数据契约，让下游并行开发。架构先于实现，否则返工。

## 目标
降低大型后端改造的返工率：先想清楚分层、契约、错误处理与横切关注点，再进入实现。

## 步骤
1. **理解约束**：摸清规模、SLA、数据量、合规边界、现有模块边界。向用户澄清未知项再继续。
2. **定义分层**（冻结边界，禁止跨层调用）：
   - **Strategy（领域/用例）**：纯业务规则，不依赖框架。
   - **Context（聚合/实体）**：状态与不变式（invariants），不依赖 I/O。
   - **Controller（入口/端口）**：HTTP/gRPC/CLI 适配，只做编排与翻译。
3. **显式错误处理**：定义错误类型 + 传播策略。返回结构化错误，不抛裸异常、不静默吞错。
   - 每个 public 方法标注可能错误与 4xx/5xx 映射。
4. **横切关注点**：列出日志/鉴权/限流/事务/重试/追踪，用装饰器或中间件统一注入，不散落进业务。
5. **契约优先**：先写接口签名、DTO schema、错误码表；用 schema 校验入参出参。
6. **架构级测试**：先写契约测试与集成测试（端口层），再写单元测试。
7. **交付物**：架构文档（分层图 + 接口签名 + 错误码表 + 横切关注点清单）+ 可跑的骨架代码。

## 原则
- 架构未冻结前不写实现逻辑（除非用户明确要求直接动手）。
- 业务层（Strategy/Context）零框架依赖，便于测试与替换。
- 跨层调用一律走显式端口，禁止 Controller 直接操作数据库实体。`,
  },
  {
    name: 'data-engineer',
    description: '数据管道开发工作流：ingest→clean→dedup→validate→enrich→transform→load 标准化阶段 + 分块 + 幂等 + 可观测性，先把管道跑通再优化',
    version: '1.0.0',
    author: 'freeseek',
    category: 'data',
    source: 'builtin',
    tools: ['list_directory', 'read_file', 'write_file', 'run_command'],
    triggers: ['数据管道', 'data pipeline', 'etl', '数据工程', '批处理', '数据清洗', '流式处理', 'pipeline'],
    content: `# data-engineer

把原始数据可靠地变成可用数据：先让管道端到端跑通，再做优化与健壮性。可靠性 > 花哨。

## 目标
用标准化阶段 + 显式契约 + 幂等 + 可观测性，降低数据管道的静默损坏与重跑成本。

## 标准阶段（每阶段可独立测试与重跑）
1. **ingest**：接入源（DB/API/文件/流）。记录来源、偏移量、批次 id。
2. **clean**：去噪、统一类型、处理缺失（Null/NaN/空串显式区分）。
3. **dedup**：按业务主键去重，定义"重复"的明确判据。
4. **validate**：schema 校验（类型/范围/非空/枚举），失败行进死信队列而非中断整批。
5. **enrich**：关联外部维度，注意关联失败降级而非阻断。
6. **transform**：纯函数式转换，无副作用、可重入。
7. **load**：写入目标（幂等 upsert），记录写入行数与批次。

## 关键工程纪律
- **分块（chunk）**：流式/分批处理，避免整表载入内存；显式背压与批大小。
- **幂等**：同输入重跑 = 同结果。用 upsert / 覆盖写 / 批次幂等键，禁止 append-only 重复。
- **可观测性**：每阶段记录计数（in/out/dropped/error）、耗时、批次 id；异常行进死信队列可回查。
- **契约**：源/目标 schema 显式定义并用 schema 校验，schema 变更走版本与兼容策略。

## 测试
- 用小样例数据跑通端到端（golden file：输入→期望输出）。
- 单测每个阶段转换函数（纯函数易测）。
- 边界：空输入、超大批次、坏行、schema 漂移。

## 原则
- 先把管道跑通（happy path），再加健壮性（死信/重跑/告警）。
- 不要在 transform 里做 I/O；I/O 只在 ingest/load。
- 语言无关：上述阶段与纪律适用于 Python/SQL/Spark/任意语言。`,
  },
  {
    name: 'appsec-engineer',
    description: '应用安全审查工作流：先威胁建模与厘清意图，再按 OWASP 做增量 SAST 与手动审计，区分真实漏洞与噪音，附合规要点',
    version: '1.0.0',
    author: 'freeseek',
    category: 'security',
    source: 'builtin',
    tools: ['list_directory', 'read_file', 'write_file', 'run_command'],
    triggers: ['安全审计', 'security audit', 'appsec', '漏洞扫描', '代码安全', 'owasp', '威胁建模', '安全审查'],
    content: `# appsec-engineer

在被要求审计时，先理解"这代码是做什么的、攻击面在哪"，再动手找漏洞。误报比漏报更伤信任。

## 目标
用威胁建模 + 增量 SAST + 手动审计，产出高信噪比的安全结论：真实漏洞优先，附修复与合规依据。

## 步骤
1. **理解系统**：先读代码与文档，弄清架构、信任边界、数据流向、外部输入点（攻击面）。
2. **威胁建模**：识别资产、威胁代理、攻击向量；按风险排序关注点（不要一开始逐行扫）。
3. **厘清意图（减少误报）**：对可疑代码用工具确认是否真有漏洞，必要时向用户提问确认预期行为。
   - 宁可先问，也不要把"看起来奇怪但安全"的代码报成漏洞。
4. **增量 SAST**：只对新改动/改动波及的模块跑静态扫描，避免全量噪音。关注：
   - 注入（SQL/命令/模板）、XSS、路径穿越、SSRF、反序列化、硬编码凭据、危险 eval、不安全依赖。
5. **手动审计**：对高价值路径（鉴权、支付、文件上传）做人工走查，SAST 覆盖不到的逻辑漏洞。
6. **分级报告**：🔴 高危（可远程利用）/ 🟡 中危 / 🟢 低危/加固建议；每条给：位置 + 利用路径 + 修复 + 合规条款。
7. **合规要点**：涉及个人数据要提 GDPR/数据最小化/加密留存；总结合规风险与处置建议。

## 原则
- 真实漏洞优先；不确定就标"待确认"并说明疑点，不强行升级。
- 增量审查：只扫改动相关，全量扫描作为周期性动作而非每次。
- 修复建议要可执行；不直接改生产代码时可给最小补丁示例。`,
  },
];
