# 第三代看板与诊断规格（Dash3 / ai-dash3）

## 0. 文档角色与维护约定（**SSOT**）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 编写 **`ai-dash3/SKILL.md`**、**`ai-dash3/scripts/**/*.cjs`** 时，**以本文为规范来源**。看板行为不依赖口头约定。 |
| **与 `docs/input-spec.md` 的关系** | 全流水线跨界语义（阶段链、**`stages.json` 真源**、退出码表、日志目录、**ai-auto3** 与 **ai-dash3** 职责边界等）以 **`docs/input-spec.md`** 为总纲。本文收束 **仅与 ai-dash3 相关**的可执行条款；若冲突，收束顺序：**先改 `input-spec` → 再改本文 → 再改 skill 实现**。 |
| **与 `docs/spec/auto3.md` 的关系** | **自动推进**、**`<skills_root>/_runtime/<project_id>/runtime.json`** 写入（**`runtime-pipeline.md`**）、**PID 锁** 申请/释放、**`gen-report.cjs`** 调用均由 **ai-auto3** 负责（**`auto3.md`**）。**ai-dash3** **不得**重复实现上述能力；**不**读取 **`registry.sqlite`**。 |
| **与上一版（v2）的关系** | 本版 **不**读取 v2 业务仓内 **`stages.json` 旧路径**、旧看板脚本或 v2 SQLite 作为默认真源。心智映射：**ai-dash3** ≈ **ai-dash2** 的**看板 / 状态洞察**职能；**不**包含 v2 **autorun**（本版归 **ai-auto3**）。 |

**维护流程（需求变更时）**：

1. 在本文修改 CLI、输出形态、下一步建议规则、验收清单。  
2. 若涉及与 **ai-auto3** 的边界或 **`stages.json`** 键名，同步 **`docs/input-spec.md`**（通常 §4.2 / §4.2.1）与（必要时）**`docs/spec/auto3.md`**。  
3. 再改 **ai-dash3** 实现，并跑通 **§9** 验收项。

---

## 1. 文档目的、读者与自身完整性

| 项目 | 说明 |
| --- | --- |
| **目的** | 作为 **Cursor Agent Skill：`ai-dash3`** 的**详细规划与实施指引**：只读聚合 **`.pipeline/stages.json`**、**`.pipeline/reports/`** 与 **PID 锁文件**（若存在），向人与 Agent 输出**一眼可扫**的进度表、阻塞摘要与**建议的下一步命令**（**不**自动执行）。 |
| **读者** | 实现与 review **ai-dash3** 的工程师或 Agent；在会话开场需要「当前卡在哪」快照的成员。 |
| **自身完整性** | 未读 **`input-spec.md`** 的读者仍可依 **§2–§8** 完成 **MVP**；**§10** 为交叉索引。 |
| **非目标** | **不**定义各业务阶段的 LLM prompt；**不**定义 **autorun** 循环、子进程超时、**runtime.json** 写入算法（除 **`services.dash_serve`**）；**不**替代 **ai-auto3** 的 checklist 真源（dash 可提供**只读**提示，**不得**声称已等价于 **preflight-only**）。 |

---

## 2. 定位：只读、轻薄、与 ai-auto3 互斥「推进」

### 2.1 一句话职责

**ai-dash3** 提供 **pipeline 看板与诊断**：读取 **`<skills_root>/_runtime/<project_id>/runtime.json`**（运行态）与业务仓 **`<project_root>/.pipeline/stages.json`**、**`reports/`**，**不** spawn 其它 **ai-*3**、**不**写 **`stages.*` 业务字段**、**不**申请 **PID 锁**、**不**写入 **`orchestration`**（可选写 **`services.dash_serve`**）。

### 2.2 显式禁止（实现时自检）

| 禁止项 | 说明 |
| --- | --- |
| **写 `stages.json`** | 含「为对齐展示而微调 JSON」；**唯一真源**只能由对应阶段 skill / **ai-auto3** 依契约更新。 |
| **spawn 子 skill** | 不得 `spawn` **`ai-design3` / `ai-code3` / `ai-publish-*` / `ai-auto3`** 作为 dash 子命令的副作用。 |
| **持锁 / 释锁（默认）** | **`.agent-sessions/locks/pipeline.pid`** 默认仅 **存在性 + 进程存活** 只读检测（见 **§5.3**）。**例外**：Web **`POST /api/stop`** 经 **`ai-auto3/scripts/stop-pipeline.cjs`** 终止该项目 **ai-auto3 编排子进程**并移除陈旧锁、清理 registry（**不**写 **`stages.json`**）。**`POST /api/stop-serve`** 仅关闭**当前** ai-dash3 **serve** 进程，**不**调用 stop-pipeline。 |
| **代写 report 正文** | **`.pipeline/reports/*`** 中由 **ai-prd3 / ai-auto3** 等生成的文件，dash **只列举路径**，**不**覆盖。可选 **`write-md`** 输出到**单独文件名**（默认 **`dash-status.md`**），与 **`prd-implementation-summary.md`** 等并存。 |

### 2.3 与 ai-auto3 的协作话术

- 用户说「**只看进度、不要自动跑**」→ 使用 **`ai-dash3`**（**`status` / `json` / `write-md` / `serve`**）。  
- 用户说「**从 design 自动跑到 report**」→ 使用 **`ai-auto3`**（**`autorun.cjs`**）；运行态写入 **`<skills_root>/_runtime/<project_id>/runtime.json`**。  
- 用户说「**多项目列表为空**」→ 确认目标项目曾跑过 **autorun / soak**（会创建 runtime 文件），或 **`serve --project=<abs>`** 直链单项目。

---

## 3. Skill 目录与 CLI 规划

### 3.1 目录布局

| 路径 | 说明 |
| --- | --- |
| **`ai-dash3/SKILL.md`** | 触发词、必读路径、一行命令、退出码指针；**不**内联算法。 |
| **`ai-dash3/scripts/run.cjs`** | **唯一**对外 CLI 入口（含委派 **`serve`**）。 |
| **`ai-dash3/scripts/serve.cjs`** | 本地 Web 看板 HTTP 服务（由 **`run.cjs serve`** 调用）。 |
| **`ai-dash3/scripts/lib/*.cjs`** | 聚合逻辑（**`summary`**、**`features`**、**`dashboard`**、**`runtime-bridge`**（读 **`<skills_root>/_runtime/*/runtime.json`**））。 |
| **`ai-dash3/web/`** | 看板静态页与 **`/assets/*`**。 |
| **`ai-dash3/scripts/smoke.cjs`** | 仓库内自检（**§9**）。 |
| **`ai-dash3/package.json`** | 可为 **零依赖**（仅用 Node 内置 **`fs` / `path` / `child_process`**）；**禁止**为 dash 引入 **SQLite** 客户端。 |

### 3.2 启动方式

统一：**`node <skill_dir>/scripts/run.cjs <子命令> --project=<业务项目根绝对路径> [选项]`**

- **`<skill_dir>`**：安装目录，例如 **`~/.cursor/skills/ai-dash3`**。  
- **`--project`**：除 **`serve`** 外**必填**、**绝对路径**；**`serve`** 可省略（浏览器内再选项目）。**禁止**依赖 `process.cwd()` 推断项目根（对齐 **`input-spec.md` §3.3**）。

### 3.3 子命令

| 子命令 | 默认？ | 职责 |
| --- | --- | --- |
| **`status`** | **是**（省略子命令时等价于 **`status`**） | **stdout** 输出人类可读块：项目 id、`pipeline.current_stage`、**阶段表**（见 **§4**）、**阻塞摘要**（见 **§5**）、**报告文件列表**（见 **§5.2**）、**建议下一步**（见 **§6**）。 |
| **`json`** | 否 | **stdout** 输出 **单行 minified JSON**（UTF-8），供脚本消费；字段集合见 **§7**。 |
| **`write-md`** | 否 | 将 **`status`** 等价内容写入 Markdown 文件；**`--out=`** 为**相对项目根**或**绝对路径**；默认 **`.pipeline/reports/dash-status.md`**。写入前 **`mkdir -p`** 父目录。 |
| **`serve`** | 否 | 启动**本地 Web 看板**（只读）：默认 **`http://127.0.0.1:9473/`**；**`--port=`**、**`--host=`**（默认 **`127.0.0.1`**）、可选 **`--project=`** 作为页面默认项目。静态资源在 **`ai-dash3/web/`**；HTTP API 见 **§7.1**。 |

**共用选项**：

| 选项 | 说明 |
| --- | --- |
| **`--out=<path>`** | 仅 **`write-md`**：输出路径（默认 **`.pipeline/reports/dash-status.md`**）。 |
| **`--port=` / `--host=`** | 仅 **`serve`**：监听端口（默认 **9473**）与绑定地址（默认 **127.0.0.1**，仅本机）。 |
| **`--open`** | 仅 **`serve`**：监听成功后用系统默认浏览器打开看板 URL；**`AI_DASH3_NO_OPEN=1`** 可禁用。 |

**Agent 唤起约定**：用户通过 **`/ai-dash3`** 或触发词使用本 skill 时，Agent **须**后台执行 **`serve --open --project=<绝对路径>`**，**不得**仅以 **`status`** 结束；用户明确要求「只要终端 / 不要网页」时例外（见 **`ai-dash3/SKILL.md`** §Agent 会话）。

### 3.4 本地 Web 看板（**`serve`**）

- **职责**：在浏览器中展示 **当前项目** 阶段表、阻塞、**Feature 流水线状态**、**`runtime.json` → `orchestration`**（phase/stage/pending_features）+ **PID 锁**只读探测、**`processes[]`** 后台进程列表；顶栏项目下拉来自扫描 **`<skills_root>/_runtime/*/runtime.json`**。
- **数据流**：选中 **`project_id`** → 读 **runtime.json** 得 **`root_path`** → 再读 **`<root_path>/.pipeline/stages.json`** 与 **`reports/`**（见 **`runtime-pipeline.md` §4**）。
- **数据边界**：**不**打开 **`registry.sqlite`**；**不**调用 **`registry-export.cjs`**（已废弃）。
- **禁止**：与 **§2.2** 相同——**不** spawn 编排、**不写** **`stages.json`** / **`orchestration`**。

---

## 4. 阶段表（展示顺序与列）

### 4.1 固定列

对下列 **`stages` 键**（**下划线**形式，与 **`stages.json.template`** 一致）按**自上而下**顺序展示；若某键在 JSON 中缺失，该行显示 **`—`**，**不得**因缺键崩溃（**退出码仍为 0**，见 **§8**）。

`prd` → `prd_review` → `design` → `contract` → `design_review` → `codegen` → `typecheck` → `test` → `code_review` → `merge_push` → `build` → `deploy` → `smoke` → `report`

### 4.2 每行至少包含

| 列 | 来源 |
| --- | --- |
| **stage** | 上表键名；**`status` 子命令**可把 **`merge_push`** 显示为 **`merge-push`** 以利阅读。 |
| **status** | **`stages.<k>.status`**（缺省 **`unknown`**）。 |
| **validation** | **`stages.<k>.validation.passed`** → **`ok` / `no` / `—`**（无 `validation` 对象时）。 |

---

## 5. 阻塞摘要与辅助信号

### 5.1 从 `stages.json` 推断的阻塞（**MVP** 须实现）

| 条件 | 展示文案（示例） |  severity |
| --- | --- | --- |
| **`prd_review.outputs.decision`** ∈ **`failed` / `rejected` / `pending`** 且 **`prd_review.status`≠`completed`** | 引用 **decision** 与 **status** | **high** |
| **`prd_review.outputs.decision === 'conditional_passed'`** | 提示「**conditional_passed**：**ai-auto3** 默认不放行」 | **high** |
| **`contract.outputs.human_approval.status === 'pending'`** | 「契约待人工审批（**ai-design3** `approve-contract` / `reject-contract`）」 | **high** |
| **`contract.status === 'blocked'`** | 「**contract** 已标记 **blocked**」 | **high** |
| 任一阶段 **`status==='failed'`** | 列出 **stage** 名 | **medium** |
| 任一阶段 **`outputs.timed_out===true`** | 列出 **stage** + **`timeout_reason`**（若有） | **medium** |

### 5.2 `.pipeline/reports/` 列举

若目录存在：按**文件名排序**列出相对路径（每行一个）；若不存在：提示「**无 reports 目录**」。**不**递归子目录（**MVP**）。

### 5.3 PID 锁（只读）

若 **`.agent-sessions/locks/pipeline.pid`** 存在且内容为**正整数** PID：

- **Unix / macOS**：若 **`process.kill(pid, 0)`** 不抛错 → 文案 **「pipeline 锁存在且进程或存活 (PID=…)」**；若抛错 **`ESRCH`** → **「锁文件残留（PID 不存在）」**。  
- **Windows**：**MVP** 可仅提示「**存在 pipeline.pid**（未做跨平台存活探测）」，**不得**因探测失败退出非 0。

---

## 6. 建议下一步（启发式，**非**门闸）

下列规则按**自上而下**匹配，**命中第一条即输出**为主建议（**`json`** 中可同时附 **`hints: string[]`** 列出多条）：

1. **无** **`.pipeline/stages.json`** → 建议 **`ai-prd3`**：`node <skills>/ai-prd3/scripts/run.cjs bootstrap --project=...`  
2. **`prd` 未完成**（非 **`completed`** 或 **`validation.passed`≠true**）→ **`ai-prd3`** **`validate-prd` / `write-prd`**（见 **`prd3.md`**）  
3. **`prd_review` 未完成** 或 **`outputs.decision`∉{`passed`}**（且非已放行组合）→ **`ai-prd3`** **`finalize-prd-review`**（须 **`--json=`**）  
4. **`contract` 待审批或 blocked** → **`ai-design3`** 审批子命令（**`design3.md` §8**）  
5. **`design` / `contract` / `design_review` 链**上存在首个未完成 stage → **`ai-design3`** **`run.cjs`** 按段触发（见 **`design3.md`**）  
6. **`codegen`～`build`** 上存在首个未完成 → **`ai-code3`** **`run.cjs`**（见 **`code3.md`**）  
7. **`deploy` / `smoke`** 未完成且用户意图是「**仅 dev 发布**」→ **`ai-publish-dev3`**；若意图是「**整链自动**」→ **`ai-auto3`**（**须在话术上并列提示**，由人选择）  
8. **`report` 未完成** 但 **`smoke` 已完成** → **`ai-auto3`** **`gen-report.cjs`** 或完整 **`autorun`** 的尾部（见 **`auto3.md`**）  
9. 若 **`stages.report.status==='completed'`** 且 **`validation.passed===true`** → 「**本轮汇总已就绪**」+ **`reports/`** 路径提示  

**声明**：本节输出**不构成** **`ai-auto3` preflight** 的替代；**开跑前**仍以 **`autorun.cjs preflight-only`** 为准。

---

## 7. `json` 子命令输出形状（**MVP**）

单行 JSON 对象，键至少包含：

| 键 | 类型 | 说明 |
| --- | --- | --- |
| **`schema`** | `string` | 固定 **`ai-dash3.summary.v1`**。 |
| **`project_id`** | `string` | 来自 **`stages.json`**；缺文件则为 **`""`**。 |
| **`pipeline`** | `object` | **`current_stage`**、**`last_completed_stage`**、**`updated_at`**（各字段缺则 **`null`**）。 |
| **`rows`** | `array` | 每项 **`{ stage, status, validation_passed }`**（**`validation_passed`** 为 **`boolean \| null`**）。 |
| **`blockers`** | `array` | 每项 **`{ code, message, stage? }`**；**`code`** 为稳定枚举（如 **`prd_review_pending`**、**`contract_pending_approval`**）。 |
| **`reports`** | `string[]` | **`.pipeline/reports/`** 下文件名；目录不存在为 **`[]`**。 |
| **`pid_lock`** | `object` | **`{ present: boolean, pid: number \| null, alive: boolean \| null }`**。 |
| **`suggested_next`** | `string` | 主建议一句自然语言（**§6**）。 |
| **`hints`** | `string[]` | 可选附加提示。 |

### 7.1 Web API（**`serve`**，**MVP**）

| 路径 | 说明 |
| --- | --- |
| **`GET /`** | **`index.html`** |
| **`GET /assets/*`** | 静态 CSS/JS |
| **`GET /api/config`** | **`{ schema: "ai-dash3.config.v1", default_project_root, serve: { pid, host, port } }`**（**`serve`** 为当前监听实例元数据） |
| **`GET /api/projects`** | **`ai-dash3.projects.v1`**：扫描 **`<skills_root>/_runtime/*/runtime.json`** 的项目摘要列表（**`project_id`**、**`root_path`**、**`orchestration.active`**、**`updated_at`**）；**`GET /api/registry`** 可保留为**别名**（同响应，deprecated） |
| **`GET /api/dashboard?project=<abs>`** | **`ai-dash3.dashboard.v1`**：含 **§7** 的 **`summary`**、**`features[]`**、**`runtime`**（来自 **runtime.json** + 现场 PID）、**`recent_runs`**、**`processes`**、**`overall`**、**`pipeline_stoppable`** |
| **`POST /api/stop-serve`** | 优雅关闭**当前** ai-dash3 **serve**（**`server.close` + `process.exit`**）；响应 **`ai-dash3.stop-serve.v1`**（含 **`pid` / `host` / `port`**）。**不**终止 ai-auto3 子进程。端口仍被其它陈旧进程占用时，用户可在终端执行 **`lsof -ti :<port> \| xargs kill`**。 |
| **`POST /api/stop?project=<abs>`** | **「停止所有后台任务」**：调用 **ai-auto3** **`stop-pipeline.cjs`**，终止匹配进程，清理 **`pipeline.pid`**，更新 **runtime.json**（**`orchestration.active=false`**、**`processes` exited**）。响应 **`ai-dash3.stop.v1`**；仍有存活进程时 HTTP **207**。**不**关闭 ai-dash3 serve。 |

**`features[].pipeline_status`**（与 **`feature_status`** 同值，供筛选/聚合）：**`pending` | `in_progress` | `paused` | `completed`**（见 **`lib/features.cjs`**）。**阶段失败**体现在 **`current_stage_status=failed`**，**不**再单独占用 **`pipeline_status=failed`**。

**`feature_status`（整条 feature，Web 底栏徽章）**：

| 状态 | 条件（按优先级） |
| --- | --- |
| **`completed`** | **`stages.test.outputs.per_feature[]`** 该 **`feature_id`** 通过 **且** 项目 **`stages.ui_e2e.status=completed`**（**唯一**「已完成」） |
| **`in_progress`** | 与本 feature 相关的任一阶段 **`running`**（含 active codegen、test running、项目 prd running 等） |
| **`pending`** | 项目 **`prd`** 尚未开始，且本 feature 未动工 |
| **`paused`** | **`prd`** 已完成且项目 **`ui_e2e`** 未完成，且非 **`in_progress`**（含 codegen 完待 test、test 失败待处理、延期等） |

**`current_stage` / `current_stage_status`（卡片「当前阶段」行）**：

| 字段 | 说明 |
| --- | --- |
| **`completed_stages[]`** | 已完成阶段键名列表（展示为 **`prd, prd-review, …`**） |
| **`current_stage`** | 当前阶段键名 |
| **`current_stage_status`** | **`pending` | `running` | `failed` | `deferred`**（**无** `completed`；已完成阶段只出现在 **`completed_stages`**） |

**内部启发式（`hints[]`）** 仍记录 **`test_per_feature_failed`**、**`blocked_in_feature_list`** 等；**「失败」筛选** 匹配 **`current_stage_status=failed`** 或上述 hints。

**`isFeatureCodegenDone`（codegen 完成）**：与 **autorun** **`filterRemainingCodegenQueue`**、看板 **`codegenDone` / `completed_stages`** 共用同一实现；**真源**为 **`stages.*.outputs.per_feature[]`**（**`feature-stages.cjs`**），**worktree / git** 仅作无 per_feature 时的回退。看板 **`feature_status=completed`** 仍以 **test + ui_e2e** 为准（上表）。

**`orchestration.pending_features`**（**`runtime.json`**，原 registry **`pending_features_json`**）：表示**尚未完成 codegen 的排队列表**；**autorun** 在 codegen 波次中应随进度收缩，**不得**长期等于整期 **`phase_plan`** 全集否则看板会把全员标为处理中。

---

## 8. 退出码与错误

与 **`input-spec.md` §五**对齐的**子集**（dash **不**跑子工具，故 **3/4/5/6/7/8** 在常态下不应出现）：

| 退出码 | 含义 |
| --- | --- |
| **0** | 看板生成成功（含 **`stages.json` 缺失**时的「空态 + 建议 bootstrap」）。 |
| **1** | **`--project` 缺失 / 非绝对路径 / 路径不存在**；**`write-md` 写入失败**；**`stages.json` 存在但非合法 JSON**（解析抛错）。 |

**`stages.json` 缺失**：**不得**退出 **1**；**`json`** 输出 **§7** 空态 + **`hints`** 含 **`missing_stages_json`**。

---

## 9. 验收清单（实现完成前勾选项）

- [x] **`SKILL.md`** 含触发词、**`--project`** 必填、与 **ai-auto3** 边界、退出码指针。  
- [x] **`run.cjs`** 实现 **`status` / `json` / `write-md`**；缺 **`stages.json`** 不崩溃。  
- [x] **阶段表**顺序与 **§4.1** 一致；**`merge_push`** 展示名可读。  
- [x] **阻塞摘要**覆盖 **§5.1** 列出的 **MVP** 条件。  
- [x] **`json`** 输出可 **`JSON.parse`** 且含 **§7** 必填键。  
- [x] **`write-md`** 默认路径 **`.pipeline/reports/dash-status.md`**，不覆盖 **`prd-implementation-summary.md`**。  
- [x] **`smoke.cjs`** 对 fixtures 连续跑两轮子命令，均 **退出 0**。  
- [x] **`serve`** 绑定默认 **`127.0.0.1`**；**`GET /api/dashboard`** 对非法 **`stages.json`** 返回 **400**（与 CLI 退出码 **1** 语义对齐）。  
- [x] **`serve`** + **`web/`** 展示 **Feature `pipeline_status`** 与 **runtime.json** 运行态（扫描 **`<skills_root>/_runtime/`**，**不**使用 SQLite）。  
- [x] **依赖**：**零** npm 生产依赖；**无** `better-sqlite3`。

---

## 10. 交叉索引

| 主题 | 文档 |
| --- | --- |
| 全流水线阶段链、**ai-dash3 / ai-auto3** 边界 | **`docs/input-spec.md` §4.2、§4.2.1、§4.3** |
| **自动编排**、**runtime.json**、**PID 锁**、**gen-report** | **`docs/spec/auto3.md`**、**`docs/spec/runtime-pipeline.md`** |
| **prd / prd-review** | **`docs/spec/prd3.md`** |
| **contract 审批** | **`docs/spec/design3.md` §8** |
| **字段真源** | **`docs/templates/stages.json.template`** |
