// check:max-lines 670 (内置工具定义 schema，纯声明数据；tools.ts 拆分)
import { ToolDefinition } from "../provider";

/** 内置工具定义全集（系统提示词与模型调用用）。tools.ts 拆分而来，导出路径保持兼容。 */
export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件内容。可指定起始行与行数。用于查看代码、配置。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对或绝对文件路径" },
          offset: { type: "number", description: "起始行（从 1 开始），可选" },
          limit: { type: "number", description: "读取行数，可选" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "创建或覆盖写入文件。用于新建/修改代码、文档。自动按原文件编码写回（保留 GBK/UTF-16 等非 UTF-8 编码），并在文件已被外部修改时做冲突检测。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整文件内容" },
          force: { type: "boolean", description: "可选：true 时跳过外部修改冲突检测，强制覆盖。默认 false（检测到冲突会拒绝并提示先 read_file）" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "列出目录内容（含子目录标记）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "目录路径，默认工作区根" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "按文件名模式递归查找文件，支持 * 与 ** 通配。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "如 '*.ts' 或 'src/**/*.json'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "在工作区内按正则/关键字搜索文件内容，返回匹配行。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "搜索关键字或正则" },
          path: { type: "string", description: "搜索起点目录，可选" },
          include: { type: "string", description: "文件过滤，如 '*.ts'，可选" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区内执行进程/命令并返回 stdout/stderr。跨平台单程序调用优先传 argv（如 [\"node\",\"tests/run.js\"]），它不经过 shell 引号解析；只有确实需要管道/重定向/&& 等 shell 语法时才传 command。Windows 的 command 走 cmd.exe，`;` 不是命令分隔符。仅在用户开启 allowShell 时可用。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "可选：shell 命令字符串；与 argv 至少提供一个。需要 shell 运算符时使用" },
          argv: {
            type: "array",
            items: { type: "string" },
            description: "可选且推荐：精确进程 argv，例如 [\"node\",\"tests/run.js\"]；不经过 shell 解析，跨平台且避免 quoting 问题",
          },
          cwd: { type: "string", description: "工作目录，可选" },
          input: {
            type: "string",
            description: "可选：写入命令 stdin 的内容（应对交互式确认/输入，如 'y\\n'）；不需要时省略",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "向用户提问并等待回答（用于澄清需求、确认高风险操作）。可提供结构化多选项（对齐 Claude Code Interactive Questions）：传 options 时用户从选项中选，不传则为自由文本输入。",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "要问用户的问题" },
          options: {
            type: "array",
            description: "可选：结构化选项数组（每项 { label, description }）。传了就在选项里选，最多 4 项",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "选项文案" },
                description: { type: "string", description: "选项补充说明，可选" },
              },
              required: ["label"],
            },
          },
          multiSelect: {
            type: "boolean",
            description: "可选：是否允许多选（配合 options 使用），默认 false",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "精确字符串替换（不重写整个文件）。提供 old_string 与 new_string；若 old_string 出现多次，需设 replace_all=true 或提供更多上下文。省 token，对齐 Claude Code 的 Edit。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          old_string: { type: "string", description: "要被替换的原文片段" },
          new_string: { type: "string", description: "替换后的新内容" },
          replace_all: { type: "boolean", description: "是否替换全部匹配，默认 false" },
          force: { type: "boolean", description: "可选：true 时跳过外部修改冲突检测，强制编辑。默认 false（检测到冲突会拒绝并提示先 read_file）" },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "按文件名模式匹配（如 '**/*.ts'、'src/**/*.json'）。比 search_files 更贴合 glob 语义，用于快速定位文件。",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "glob 模式，如 '*.ts' 或 'src/**/*.json'" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description: "按需加载某个技能的完整 SOP（系统提示词中已列出可用技能名与描述）。返回该技能 SKILL.md 全文。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称，如 commit-push-pr" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_write",
      description:
        "写入/覆盖当前任务清单（Claude Code 式：每次调用给出完整列表）。用于多步骤任务的规划与进度跟踪。每项含 content 与 status（pending/in_progress/completed）。每开始一步置 in_progress，完成置 completed。",
      parameters: {
        type: "object",
        properties: {
          todos: {
            type: "array",
            description: "完整的任务列表（全量覆盖，非增量追加）",
            items: {
              type: "object",
              properties: {
                content: { type: "string", description: "任务描述" },
                status: {
                  type: "string",
                  enum: ["pending", "in_progress", "completed"],
                  description: "任务状态",
                },
                activeForm: {
                  type: "string",
                  description: "进行中时的动作描述（可选），如『正在读取配置』",
                },
              },
              required: ["content", "status"],
            },
          },
        },
        required: ["todos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "todo_read",
      description: "读取当前任务清单，返回各任务的状态。用于在多步任务中确认进度。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "把一条值得跨会话记住的信息写入持久记忆（用户偏好、项目约定、踩过的坑等）。scope=user 写入用户级记忆（跨所有项目），scope=project 写入项目级记忆（.agent/memory，随项目）。下次会话自动注入系统提示词。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要记住的内容" },
          scope: {
            type: "string",
            enum: ["user", "project"],
            description: "记忆作用域，默认 project",
          },
        },
        required: ["content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_agent",
      description:
        "派发一个独立上下文的子智能体去探索代码库或执行子任务，它只把一页结论交回，保持主上下文干净。用于理解陌生模块、技术调研、大规模搜索、并行实现。参数：agent=角色定义文件名（.codebuddy/agents/ 或 .agent/agents/<name>.md，可选）；role=角色预设名（系统提示词「可用子代理」清单中的名字：内置 explore(只读探索)/plan(只读规划)/verify(读+跑测试验证)/general(可改通用) 及用户自定义角色）；mode=explore（只读）或 executor（可改），当未指定 role 时作为默认；provider/model=可选，指定该子智能体使用哪个提供商/模型（多模型分工，如规划用便宜模型、写代码用强模型），省略则与主 Agent 共用全局活动模型；worktree=可选，指定在某 Git 工作树内独立运行，实现并行改不同模块且互不覆盖；run_in_background=可选 true，后台异步运行并在完成时通知，不阻塞主流程。",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "角色定义文件名（不含 .md），位于 .codebuddy/agents/ 或 .agent/agents/，可选；不填则按 role/mode 用默认角色",
          },
          provider: {
            type: "string",
            description: "可选：指定该子智能体使用的提供商（provider id 或名称，如 deepseek-official / ollama）。与全局活动模型解耦，实现多模型分工；省略则用全局活动提供商",
          },
          model: {
            type: "string",
            description: "可选：指定该子智能体使用的模型（模型 id 或名称，如 deepseek-v4-flash / qwen2.5-coder-7b-instruct）。配合 provider 让「规划用便宜模型、写代码用强模型」成为可能；省略则用该提供商默认模型",
          },
          task: { type: "string", description: "交给子智能体的任务描述" },
          name: {
            type: "string",
            description: "命名该子智能体（可选）。命名后它会被登记到「子智能体团队注册表」，可用 send_message 工具按名寻址并续跑（即 Agent Teams 寻址，对标 Claude Code SendMessage）",
          },
          role: {
            type: "string",
            description: "角色预设名（系统提示词中的「可用子代理」清单里列出的名字，含内置 explore/plan/verify/general 与用户自定义角色）：explore（只读探索）/ plan（只读规划）/ verify（读+跑测试验证）/ general（可改通用执行）",
          },
          mode: {
            type: "string",
            enum: ["explore", "executor"],
            description: "子智能体模式（未指定 role 时生效）：explore（只读）/ executor（可改文件、跑命令）",
          },
          worktree: {
            type: "string",
            description: "可选：在某工作树内运行（绝对路径或相对工作区根的路径，如 .worktrees/feature-x），文件改动隔离在该副本，最后手动合并回主线",
          },
          run_in_background: {
            type: "boolean",
            description: "可选：true 时后台异步运行子智能体，立即返回 taskId，完成通过通知回报，不阻塞主流程",
          },
        },
        required: ["task"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spawn_agents",
      description:
        "并行派发多个独立子智能体（Promise.all 同时运行），各自独立上下文并行执行，最后合并交回各子智能体的结论。用于可拆分的多任务并行（如分别调研多个模块、并行实现互不依赖的改动）。比逐个 spawn_agent 更快。每个子任务参数同 spawn_agent（task 必填，role/mode/worktree 可选）。",
      parameters: {
        type: "object",
        properties: {
          agents: {
            type: "array",
            description: "并行子任务数组（至少 2 个，最多 4 个）",
            items: {
              type: "object",
              properties: {
                task: { type: "string", description: "子任务描述" },
                role: { type: "string", description: "角色预设名（可选，含内置 explore/plan/verify/general 与用户自定义角色）" },
                mode: { type: "string", enum: ["explore", "executor"], description: "模式（可选，未指定 role 时生效）" },
                provider: { type: "string", description: "可选：该子任务使用的提供商（id 或名称），多模型分工" },
                model: { type: "string", description: "可选：该子任务使用的模型（id 或名称），多模型分工" },
                worktree: { type: "string", description: "可选：在某 Git 工作树内独立运行" },
                label: { type: "string", description: "可选：该子任务标识（用于合并报告中标注）" },
              },
              required: ["task"],
            },
          },
        },
        required: ["agents"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_worktree",
      description:
        "新建一个 Git 工作树（<root>/.worktrees/<name>），含独立文件副本与分支 worktree/<name>，用于派发子智能体并行修改不同模块而不互相覆盖。需工作区为 git 仓库。返回该工作树路径，可传给 spawn_agent 的 worktree 参数。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "工作树名（决定目录与默认分支名）" },
          branch: { type: "string", description: "显式分支名，可选；不填则派生 worktree/<name>" },
          base: { type: "string", description: "新建分支的基点（如 main），可选；不填则基于当前 HEAD" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_worktree",
      description: "移除一个 Git 工作树（含其分支）。仅移除工作副本，已合并的内容不受影响。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要移除的工作树路径（create_worktree 返回的 .worktrees/<name> 路径）" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_worktrees",
      description: "列举当前仓库的全部 Git 工作树（含主工作树），返回路径与分支，便于选择派发目标。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "checkpoint",
      description:
        "创建检查点：把当前工作区状态记录到 FreeSeek 独立 shadow Git（不触碰用户 branch/index/stash），形成可回溯时间线。name 可选，不填自动生成。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "检查点名（可选），便于后续按名回滚定位" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rewind",
      description:
        "回滚到指定 FreeSeek shadow checkpoint。该操作会真实改写工作区文件，属于破坏性操作并应始终经过权限确认；不会修改用户 Git branch/index/stash。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要回滚到的检查点名（可选），不填回滚到最近一次" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_checkpoints",
      description:
        "列出当前工作区的 FreeSeek shadow checkpoint 时间线（含自动与命名检查点），供 rewind 选择恢复点；不读取或修改用户 stash。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "slash_command",
      description:
        "执行一个用户自定义 Slash 命令（项目 .agent/commands/<name>.md）。不传 name 时列出全部可用命令；传入 name（和可选 args）时返回该命令展开后的提示词（将正文中的 $ARGUMENTS 替换为 args），供你按此指令继续工作。用于在对话中复用项目级预设工作流。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "命令名（不含 .md），如 commit、review。不填则列出命令" },
          args: { type: "string", description: "传给命令的参数，替换其正文中的 $ARGUMENTS" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description:
        "向一个此前用 spawn_agent 派发并指定了 name 的命名子智能体发送后续消息，使其在已有上下文上续跑并交回新结论（即 Agent Teams 寻址，对标 Claude Code SendMessage）。target 为该子智能体的 name。",
      parameters: {
        type: "object",
        properties: {
          target: { type: "string", description: "目标子智能体 name（spawn_agent 时指定的 name）" },
          message: { type: "string", description: "要发送给该子智能体的后续指令/问题" },
        },
        required: ["target", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "promote_skill",
      description:
        "技能自动激活（验证门控）：当你用某个 pending（待审核）技能完成了一次真实任务、且已通过 verify 验证后，调用本工具激活该技能（status: pending → active），使其后续可被自动加载。若技能不存在或已激活会提示。",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "要激活的 pending 技能名" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "联网搜索：向公开搜索引擎发起查询并返回相关结果（标题/链接/摘要）。用于查找最新文档、API 用法、报错含义、技术方案等模型记忆可能过时或不确定的信息。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "要搜索的关键词/问题" },
          max: { type: "number", description: "可选：最多返回结果数，默认 6，最大 10" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description:
        "抓取指定 URL 的网页内容并转换为可读文本。用于阅读文档页、博客、GitHub README 等以获取详细内容。仅 http/https。",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "要抓取的完整 URL" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_file",
      description:
        "安全删除文件/目录（Safe-Delete）：删除操作转为移入系统回收站，可恢复，避免误删。删除前会读取目标内容供你确认。不可删除工作区外的路径。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的文件或目录路径（相对工作区根）" },
          recursive: { type: "boolean", description: "可选：删除目录时需为 true，默认 false" },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser",
      description:
        "浏览器操作（CDP 控制真实 Chrome/Edge，或自动拉起 headless 实例）。适合验证网页效果、抓取动态页面、登录后操作、截图回显。动作：navigate{url} 打开页面并返回标题与正文；click{selector} 点击元素；type{selector,text} 输入文本；press{key} 按键；evaluate{expression} 执行 JS 并返回结果；screenshot{name?} 截图并渲染进聊天；list 列出标签页；status 查看当前页面；close 关闭连接。页面正文默认截断 3000 字符。仅在 Craft 模式可用（plan/ask 会拦截）。",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["navigate", "click", "type", "press", "evaluate", "screenshot", "list", "status", "close"],
            description: "要执行的动作",
          },
          url: { type: "string", description: "navigate：要打开的 URL（可省略协议，自动补 https://）" },
          selector: { type: "string", description: "click/type：CSS 选择器，定位目标元素" },
          text: { type: "string", description: "type：要输入的文本" },
          key: { type: "string", description: "press：按键名（Enter/Tab/Escape/Backspace/ArrowUp/ArrowDown 等）" },
          expression: { type: "string", description: "evaluate：要执行的 JS 表达式（支持 async）" },
          name: { type: "string", description: "screenshot：截图文件名（可选，默认时间戳）" },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lsp",
      description:
        "语义级代码导航（Language Server Protocol）：查找符号的定义（definition）、所有引用（references）、文件内符号（documentSymbols）、工作区符号（workspaceSymbols）。比文本 grep 更准确，用于理解代码结构与调用关系。",
      parameters: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["definition", "references", "documentSymbols", "workspaceSymbols"], description: "要执行的动作，默认 definition" },
          file: { type: "string", description: "可选：目标文件路径（相对工作区根）" },
          line: { type: "number", description: "可选：行号（0 基），配合 file 定位符号" },
          character: { type: "number", description: "可选：列号（0 基），配合 file/line 定位符号" },
          query: { type: "string", description: "可选：workspaceSymbols 时用于符号名模糊搜索" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "verify",
      description:
        "运行项目的验证（质量门禁）：根据项目类型自动执行 typecheck / lint / test（如 tsc --noEmit、npm run lint、npm test）。返回结构化结果：通过/失败、执行命令、以及失败时按「文件:行」解析出的错误定位列表。用于在改动后自动验证并驱动修复循环（Agentic Engineering 的写→跑→修闭环）。可指定 command 覆盖自动探测。需 allowShell 开启。",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "可选：手动指定验证命令（如 'npm run lint'）。不填则按项目自动探测（优先 test，其次 lint，再 tsc --noEmit）",
          },
          kind: {
            type: "string",
            enum: ["auto", "typecheck", "lint", "test"],
            description: "可选：验证类别，auto 为自动探测（默认）",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_python",
      description:
        "执行一段 Python 代码（专门的 Python 运行器）。pandas / numpy / matplotlib 等常用科学计算库已随运行环境自动可用；matplotlib 生成的图表会自动渲染进聊天。适合数据分析、统计、可视化、CSV/Excel 处理。带超时与输出截断（防止长输出撑爆上下文）。需要 freesek.allowShell 开启。",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "要执行的 Python 代码（纯文本）" },
          timeout: { type: "number", description: "可选：超时秒数（默认 120，最大 600）" },
          cwd: { type: "string", description: "可选：工作目录，用于相对路径解析（如读取数据文件）" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_code",
      description:
        "通用代码执行器（Code Mode）：在沙箱内执行轻量代码片段。python 可用 pandas/numpy/matplotlib；javascript/typescript 通过 Node 在所选 cwd 执行，CommonJS require('./src/...') 会相对 cwd 解析，ESM import/export 自动切换 module 模式；bash 走 run_command 沙箱通道。适合计算与小范围验证，避免用 run_command + node -e 手工处理跨平台引号。需要 freesek.allowShell 开启。",
      parameters: {
        type: "object",
        properties: {
          language: { type: "string", enum: ["python", "javascript", "typescript", "bash"], description: "代码语言（默认 python）" },
          code: { type: "string", description: "要执行的代码（纯文本）" },
          timeout: { type: "number", description: "可选：超时秒数（默认 60，最大 300）" },
          cwd: { type: "string", description: "可选：工作目录，用于相对路径解析" },
          module_format: {
            type: "string",
            enum: ["auto", "commonjs", "module"],
            description: "javascript/typescript 可选：模块模式。auto（默认）根据 import/export 自动判断；CommonJS require 建议 commonjs。",
          },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal",
      description:
        "目标状态机（区别于 todo_write 的步骤清单：goal 跟踪『为什么做』，todo 跟踪『怎么做』）。" +
        "op=create 登记新目标（max_rounds 可选设置轮次预算，0=不限，防止无限绕圈）；" +
        "edit 改目标/预算；pause 暂停；resume 恢复；complete 完成；block 标记受阻（附 reason）；" +
        "clear 清空。目标跨压缩、跨会话持久：恢复历史会话后自动重新注入当前目标。",
      parameters: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["create", "edit", "pause", "resume", "complete", "block", "clear"],
            description: "目标操作",
          },
          objective: { type: "string", description: "目标描述（create/edit 用）" },
          max_rounds: { type: "number", description: "轮次预算上限（0=不限，create/edit 可选）" },
          reason: { type: "string", description: "block 时受阻原因（可选）" },
        },
        required: ["op"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "goal_view",
      description: "查看当前目标状态（目标描述 / 阶段 / 已用轮次与预算 / 受阻原因）。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "job_list",
      description:
        "列出全部后台任务（run_in_background 启动的子智能体）：ID / 状态 / 标签 / 起止时间。",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "job_output",
      description: "读取某个后台任务已收集的输出分片（完成/运行中均可读）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "后台任务 ID（job_list 查看）" } },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "job_kill",
      description: "终止某个后台任务（标记为 killed，其完成通知将被抑制）。",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "后台任务 ID（job_list 查看）" } },
        required: ["id"],
      },
    },
  },
];
