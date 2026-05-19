# 实现规范 — ai-std4（独立全量流水线 Skill）

| 项 | 值 |
| --- | --- |
| **skill name** | `ai-std4` |
| **定位** | **独立 Skill**：自包含实现，不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 脚本 |
| **实现目录** | 主调度：`ai-std4/scripts/run-pipeline.cjs`；各 stage 主脚本：`ai-std4/scripts/stages/<stage>.cjs`；子脚本：`ai-std4/scripts/libs/` |
| **编排入口** | `ai-std4/scripts/run-pipeline.cjs` |
| **规范真源** | 本文件；[各 stage](#1-stage-实现规范人话版)、[templates](templates/)、[schemas](schemas/) 分文件维护 |

---

## 阅读指南

| 你是谁 | 建议阅读顺序 |
| --- | --- |
| **首次接入** | [§0 架构](#0-架构定位) → [setup 阶段](stages/setup.md) → [§3 编排](#3-run-pipelinecjs-编排映射) |
| **排查卡点** | [§4 Agent 卡点速查](#4-agent-卡点速查) → [§3.4 编排级自动修复](#34-stage-失败后的编排级自动修复run-pipeline) → 对应 [§1 stage 文档](#1-stage-实现规范人话版) |
| **实现脚本** | 各 stage 文件（含门闸、输入输出、日志事件）+ [templates/](templates/) + [schemas/](schemas/) |
| **运维/看板** | [§7 run-dash](#7-run-dash--流水线状态看板) · [§8 stop-pipeline](#8-stop-pipeline--停止流水线脚本) |

**文档结构**

```text
docs/spec/std4/
├── std4.md          ← 本文件（架构、§1 stage 索引、门闸链、编排、速查表）
├── stages/*.md      ← 各 stage 详情（13 个，索引见 §1）
├── templates/       ← 拷贝用模板（10 个）
└── schemas/         ← Ajv JSON Schema（13 个）
```

---

## 目录

- [0. 架构定位](#0-架构定位)
  - [停止信号文件](#停止信号文件)
  - [信号检查点](#信号检查点)
  - [优雅停止流程](#优雅停止流程)
  - [日志文件路径](#日志文件路径)
  - [日志行格式](#日志行格式)
  - [标准事件类型（所有 stage 通用）](#标准事件类型所有-stage-通用)
- [1. stage 实现规范（人话版）](#1-stage-实现规范人话版)
  - [setup](stages/setup.md)
  - [prd](stages/prd.md)
  - [prd-review](stages/prd-review.md)
  - [design](stages/design.md)
  - [design-review](stages/design-review.md)
  - [create-ui-scenarios](stages/create-ui-scenarios.md)
  - [codegen](stages/codegen.md)
  - [code-review](stages/code-review.md)
  - [merge_push](stages/merge_push.md)
  - [build](stages/build.md)
  - [deploy](stages/deploy.md)
  - [ui_e2e](stages/ui_e2e.md)
  - [report](stages/report.md)
- [2. 门闸链汇总](#2-门闸链汇总)
- [3. `run-pipeline.cjs` 编排映射](#3-run-pipelinecjs-编排映射)
  - [3.3 流水线收尾（report 之后）](#33-流水线收尾report-之后)
  - [3.4 stage 失败后的编排级自动修复](#34-stage-失败后的编排级自动修复run-pipeline)
- [4. Agent 卡点速查](#4-agent-卡点速查)
- [5. prompts 文件清单（待建）](#5-prompts-文件清单待建)
- [6. 附录：模板文件](#6-附录模板文件)
  - [`req-template.md`](templates/req-template.md)
  - [`config.env.template`](templates/config.env.template)
  - [`config.json.template`](templates/config.json.template)
  - [`stages.json.template`](templates/stages.json.template)
  - [`prd-spec.md.template`](templates/prd-spec.md.template)
  - [`prd-web.json.template`](templates/prd-web.json.template)
  - [`prd-backend.json.template`](templates/prd-backend.json.template)
  - [`prd-mobile.json.template`](templates/prd-mobile.json.template)
  - [`prd-admin.json.template`](templates/prd-admin.json.template)
  - [`prd-default.json.template`](templates/prd-default.json.template)
- [7. `run-dash` — 流水线状态看板](#7-run-dash-流水线状态看板)
- [8. `stop-pipeline` — 停止流水线脚本](#8-stop-pipeline-停止流水线脚本)
- [9. 附录：JSON Schema 文件](#9-附录json-schema-文件)
  - [`stop.signal.schema.json`](schemas/stop.signal.schema.json)
  - [`stages.json.schema.json`](schemas/stages.json.schema.json)
  - [`config.json.schema.json`](schemas/config.json.schema.json)
  - [`prd-client.base.schema.json`](schemas/prd-client.base.schema.json)
  - [`prd-web.json.schema.json`](schemas/prd-web.json.schema.json)
  - [`prd-backend.json.schema.json`](schemas/prd-backend.json.schema.json)
  - [`prd-mobile.json.schema.json`](schemas/prd-mobile.json.schema.json)
  - [`prd-admin.json.schema.json`](schemas/prd-admin.json.schema.json)
  - [`prd-default.json.schema.json`](schemas/prd-default.json.schema.json)
  - [`prd-review-client-output.schema.json`](schemas/prd-review-client-output.schema.json)
  - [`prd-review-output.schema.json`](schemas/prd-review-output.schema.json)
  - [`design.json.schema.json`](schemas/design.json.schema.json)
  - [`design-review-feature-output.schema.json`](schemas/design-review-feature-output.schema.json)
  - [`ui-scenarios.yaml.schema.json`](schemas/ui-scenarios.yaml.schema.json)
  - [`pipeline-recovery-output.schema.json`](schemas/pipeline-recovery-output.schema.json)

---

## 0. 架构定位

ai-std4 是一个**独立的全量流水线 Skill**，借鉴 V3 各 skill 的思路，但自行实现所有 stage 脚本，不 spawn 其它 skill 的 `run.cjs`。

**设计取舍（与原 V3 pipeline 的主要差异）**：

| 原 V3 有 | ai-std4 选择 | 理由 |
| --- | --- | --- |
| contract 五件套（types/api/schema/test_spec/design_snapshot） | **不要**：跳过 register-contract-artifacts + validate-contract | 契约文件由 AI 自动生成意义有限；改为直接从 design.json 派生 |
| typecheck stage | **不要** | 类型检查合并入 codegen Agent 职责；不做独立门闸 |
| test stage | **不要** | 单元/集成测试合并入 codegen Agent 职责；不做独立门闸 |
| merge_push stage | **要**：独立 stage | 合并到主干是发布的硬前置，需要独立状态与门闸 |
| create-ui-scenarios | **要**：独立 stage，从 design.json 派生 | 设计阶段验收标准是场景的最佳来源，比契约文件更直接 |
| smoke stage | **不要** | HTTP 冒烟合并入 **codegen**（feature 实现完成后）与 **deploy**（各 service 上线后）内联执行；配置仍用 `config.*.json` → `smoke.checks[]`，**无** `stages.smoke` |
| stage 失败编排修复 | **要**：`run-pipeline` 内 **pipeline-recovery** | stage 可恢复退出后：分析日志 → 修复 → 自评 → skill/项目分仓 commit+push → 重跑本 step（[§3.4](#34-stage-失败后的编排级自动修复run-pipeline)） |

**阶段链（固定顺序）**：

```
setup
→ prd
→ prd-review
→ design ──────────┐（复合编排 `design_phase`：与 design-review 流水线并行，按 dependency group 放行下游）
→ design-review ───┘
→ create-ui-scenarios ─┐（复合编排 `build_phase`：两条独立 track 并行；无相互门闸）
→ codegen ─────────────┘
→ code-review
→ merge_push
→ build
→ deploy
→ ui_e2e
→ report
```

**通用约定**：

- 状态真源：业务项目 **`<业务项目根绝对路径>/.pipeline/stages.json`**
- 所有脚本调用形态：`node ai-std4/scripts/stages/<stage>.cjs --project=<业务项目根绝对路径> [选项]`
- 脚本不复制进业务仓

**Agent 与环境（统一 `CURSOR_API_KEY` + `@cursor/sdk`）**：

| 项 | 说明 |
| --- | --- |
| **凭证真源** | `<项目>/inputs/config.env`（setup 从 [`config.env.template`](templates/config.env.template) 拷贝）→ `sync-config-env` 同步到 `docs/config.env` |
| **运行时加载** | `run-pipeline.cjs` 与各 stage 启动时调用 `libs/pipeline-config.cjs` → `loadProjectEnv(projectRoot)` 注入 `process.env` |
| **调用封装** | `libs/invoke-sdk-agent.cjs`：`Agent.create` + `send` + 可选 `artifactPath`（Ajv 校验 JSON 产出） |
| **模型** | `PIPELINE_MODEL`（env）优先 → `docs/config.*.json` → `pipeline.model`；默认 **`composer-2`** |
| **Skill 路径** | `CURSOR_SKILLS_ROOT`（env，可选）→ 默认 `~/.cursor/skills` |
| **已废弃** | ~~`AI_STD4_AGENT_BIN`~~（CLI 子进程派发） |
| **ui_e2e 场景执行** | **web**：`ui-e2e-runner`（`playwright` → `http`）；**mobile**：`ui-e2e-dart-runner`（Flutter CLI + 单场景 `integration_test`）；`--use-sdk-scenarios` 回退 SDK |
| **ui_e2e 分诊** | 仍用 `invoke-sdk-agent.cjs` + `ui-e2e-triage.md` |

`inputs/config.env` 必填项（`verify-inputs.cjs`）：`CURSOR_API_KEY`、`CLOUD_PROVIDER` 及对应云密钥；`CURSOR_SKILLS_ROOT` / `PIPELINE_MODEL` 可空（有默认/警告）。

**真源分层（Single Source of Truth）**：

| 层 | 文件 / 字段 | 角色 | 谁读 |
| --- | --- | --- | --- |
| **内容真源** | `docs/prd-spec.md`、`docs/prd-<client_target>.json`、`docs/designs/<feature_id>.design.json` | feature / 设计的完整文本 | **Agent** |
| **索引真源** | `stages.prd.outputs.features[]`（含 `feature_id` / `client_targets[]` / `dependencies[]` / `sources`）、`stages.design.inputs.dependency_groups[]` | feature 全集与依赖图 | **脚本**（prd-review 门闸、design bootstrap、依赖组、调度器） |
| **执行态** | `stages.<stage>.features.<feature_id>.*`（`status` / `group_id` / `can_enter_codegen` 等） | 单 feature 在某 stage 的进度 | 当前 stage 与下游编排 |

> 任何 stage 脚本需要 feature 列表 / 依赖 / 跨端归属时，**只读** `stages.prd.outputs.features[]`，不得在脚本里重新扫 `docs/prd-*.json`。Agent 仍按提示词读各端原文。详见 [prd § 真源分层](stages/prd.md#真源分层重要)。

### 退出码

与 [`docs/input-spec.md`](../input-spec.md) §5 对齐；各 stage 脚本**必须**映射到本表，禁止私自定义冲突语义。

| 码 | 含义 | 典型 stage / 场景 |
| ---: | --- | --- |
| 0 | 成功 | 任意 stage 正常结束或合法 `skipped` |
| 1 | 前置/参数/配置/门闸不满足 | 缺文件、schema 失败、destructive 未确认、凭证**缺失**、产物映射失败 |
| 2 | 用户中断或门闸需人工填写 | setup：`req.md` / `config.env` 未填完 |
| 3 | 超时（可重试） | codegen / build / deploy 等子进程或 Agent 挂钟超阈；含内联 smoke 子命令超时 |
| 4 | 质量门或未自动修复的失败（**可**经 Agent/改代码后重跑本 stage） | prd-review、design、codegen（含内联 smoke 失败）、code-review；deploy 分诊 `fix_script` 用尽 |
| 5 | 流水线停止（**stop.signal** 已检测） | 任意 stage 启动时或 Agent 派发前检测到 `stop.signal`；优雅停止后退出 |
| 6 | Git **合并冲突** | `merge_push`：`conflict_features[]` 非空 |
| 7 | Git **推送**失败 | `merge_push`：push 非零 |
| 8 | **云平台 / 托管 API**失败（可重试或改配置后再 deploy） | deploy：CF API 非 2xx、5xx、瞬态错误；`retry_deploy` 用尽 |
| 9 | **须人工介入、流水线阻断**（Agent/脚本**无法**自动修复） | deploy 分诊 `decision=blocked`：权限/IAM/配额/账号策略等 |

**deploy 分诊与退出码**（详见 [deploy](stages/deploy.md#3-失败分诊agent--重试)）：

| 分诊 `decision` | 脚本行为 | 仍失败时退出码 |
| --- | --- | --- |
| `fix_script` | 修改 `ai-std4` 内 deploy 脚本后重试 deploy | **4**（修复次数用尽） |
| `retry_deploy` | 不修改脚本，仅重试部署 | **8**（重试次数用尽） |
| `blocked` | 写 `blocked_reason` / `user_actions[]`，**停止整条流水线** | **9** |

> **4 vs 9**：**4** 表示「本 stage 失败但可通过改代码/配置/重跑 stage 继续」；**9** 表示「当前环境/权限下自动推进无意义，必须人工处理后再 `--from-stage=<stopped_stage>`」。

### stage 状态值

`started` · `running` · `completed` · `failed` · `skipped` · `stopped` · `pending_user_input`

> `pending_user_input`：仅用于 **setup** 阶段因 `verify-inputs` 未通过（退出码 2）时；表示等待用户补全 `req.md` / `config.env`，与 `failed` 区分，hash 门控同样视为未命中。

- 路径占位符：`<client_target>` 表示某一端标识（如 `website`、`backend`、`mobile`）；全文统一使用此写法

**停止机制**：

### 停止信号文件

流水线停止通过**信号文件**驱动，而非 OS 信号（因 Agent 是独立进程，无法可靠传递 SIGTERM）：

```
<项目根>/.pipeline/stop.signal
```

文件内容（JSON）：

```json
{
  "requested_at": "2026-05-18 08:30:15 +0800",
  "reason": "user_request",
  "requested_by": "stop-pipeline-cmd"
}
```

> `requested_by` 枚举值：`"run-dash"` | `"stop-pipeline-cmd"` | `"user"`

### 信号检查点

所有脚本在以下位置**必须**检查 `stop.signal` 是否存在，存在则立即执行优雅停止：

| 检查位置 | 说明 |
| --- | --- |
| `run-pipeline.cjs` 每个 stage 启动前 | 不再进入下一 stage |
| 每个 `stages/<stage>.cjs` 启动时 | 拒绝执行，直接退出码 `5` |
| 每个 `stages/<stage>.cjs` 调用 Agent 前 | 不派发新 Agent，直接退出码 `5` |
| Agent-B 每个并发任务启动前 | 已启动的并发 Agent 等其自然完成，不再起新的 |

### 优雅停止流程

1. 检测到 `stop.signal` → 写日志事件 `pipeline_stop`（INFO）
2. 若当前有 Agent 正在运行（`status=running`）：等待当前 Agent 完成当前步骤（**不强杀**），然后不写 `completed`，写 `status=stopped`
3. 若当前 stage 为 `setup` / `prd`（无破坏性操作）：直接中止，退出码 `5`
4. 若当前 stage 为 `codegen` / `merge_push` / `deploy`（有破坏性操作）：完成当前原子操作后中止，在日志中记录中止位置
5. 写 `pipeline.stop_info`：`{ "stopped_at": "<本地时间>", "stopped_stage": "<stage>", "reason": "<reason>" }`
6. 删除 `stop.signal` 文件（避免下次重跑被误拦截）
7. 退出码 `5`

**通用日志规范**：

### 日志文件路径

| 文件 | 写入时机 | 说明 |
| --- | --- | --- |
| `<项目根>/logs/<datetime>.log` | 全程追加 | 本次执行的流式总日志，跨所有 stage |
| `<项目根>/logs/stages/<stage>/<datetime>.log` | stage 运行期间追加 | 该 stage 所有日志，含 Agent 调用细节 |
| `<项目根>/logs/features/<feature_id>/<datetime>.log` | codegen / code-review / ui_e2e 期间 | 每个 feature 独立日志，供 report 按 feature 分析 |
| `<项目根>/logs/stages/ui_e2e/<datetime>-<scenario_id>.log` | ui_e2e 期间 | 单场景完整 MCP 执行日志 |
| `<项目根>/.pipeline/logs/snapshots/<scenario_id>/<datetime>.jpg` | ui_e2e 期间 | Browser/Dart MCP 截图落盘 |

`<datetime>` = 本次流水线启动的**本地时间**，格式 `YYYY-MM-DD_HH-mm-ss`（如 `2026-05-18_08-30-15`）。同一次执行所有日志文件共用同一 `<datetime>` 前缀，方便关联。

### 日志行格式

每行为一条结构化文本记录，末段 `<JSON meta>` 是合法单行 JSON 对象（report 脚本按此格式解析行结构后，用 `JSON.parse` 提取 meta 字段）：

```
[本地时间 YYYY-MM-DD HH:mm:ss.SSS Z] [LEVEL] [<stage>] <event> | <human message> | <JSON meta>
```

| 字段 | 说明 |
| --- | --- |
| **本地时间** | 必须使用系统本地时区（`new Date().toLocaleString('zh-CN', {timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone})`），**禁止使用 UTC** |
| **LEVEL** | `INFO` / `WARN` / `ERROR` / `DEBUG` |
| **stage** | 当前 stage 名称（如 `setup`、`prd`、`codegen`） |
| **event** | 标准化事件类型（见下表），report 阶段按 event 聚合分析 |
| **human message** | 可读描述，中文或英文均可 |
| **JSON meta** | 事件附属数据，必须是合法单行 JSON，不可省略（无额外数据时写 `{}` ） |

### 标准事件类型（所有 stage 通用）

| event | LEVEL | 触发时机 | meta 必填字段 |
| --- | --- | --- | --- |
| `stage_start` | INFO | stage 脚本启动 | `run_id`, `stage`, `project`, `started_at`（本地时间字符串） |
| `stage_complete` | INFO | stage 成功退出 | `stage`, `duration_ms`, `exit_code: 0` |
| `stage_failed` | ERROR | stage 异常退出 | `stage`, `exit_code`, `reason`, `duration_ms` |
| `stage_skipped` | INFO | hash 门控命中，跳过 | `stage`, `reason` |
| `hash_check` | INFO | 计算并比对输入哈希 | `file`, `stored_hash`, `computed_hash`, `hit`（bool） |
| `file_created` | INFO | 脚本新建文件 | `path`, `size_bytes`, `from_template`（bool） |
| `file_updated` | INFO | 脚本更新文件 | `path`, `size_bytes` |
| `file_skipped` | INFO | 文件已存在，跳过拷贝 | `path` |
| `validation_pass` | INFO | 校验通过 | `checks`, `warnings[]` |
| `validation_fail` | ERROR | 校验未通过 | `missing[]`, `invalid[]` |
| `agent_batch_start` | INFO | 并发 Agent 批次开始 | `batch_id`, `stage`, `client_targets[]`, `agents_total` |
| `agent_batch_complete` | INFO | 并发 Agent 批次结束 | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| `agent_start` | INFO | 启动 Agent 调用 | `agent_id`, `prompt`, `input_files[]`, `model`；并发场景另含 `client_target` |
| `agent_complete` | INFO | Agent 调用结束 | `agent_id`, `duration_ms`, `output_files[]`；并发场景另含 `client_target`, `decision` |
| `agent_skipped` | INFO | 单端哈希命中，跳过该 Agent | `agent_id`, `reason`；并发场景另含 `client_target` |
| `agent_retry` | WARN | Agent 校验失败，触发重试 | `agent_id`, `attempt`（1-based）, `reason`；并发场景另含 `client_target` |
| `agent_failed` | ERROR | Agent 超过重试次数或单端失败 | `agent_id`, `max_attempts`, `last_error`；并发场景另含 `client_target` |
| `git_commit` | INFO | git commit 完成 | `branch`, `commit_hash`, `files_changed` |
| `git_push` | INFO | git push 完成 | `remote`, `branch`, `status` |
| `git_push_failed` | ERROR | git push 失败 | `remote`, `branch`, `error`, `exit_code: 7` |
| `pipeline_stop` | INFO | 检测到 stop.signal，开始优雅停止 | `stage`, `reason`, `current_agent_id`（若有）, `stopped_at`（本地时间） |
| `pipeline_stopped` | INFO | 优雅停止完成 | `stage`, `stopped_at`（本地时间）, `exit_code: 5` |
| `pipeline_teardown_start` | INFO | report 后开始结束子进程 | `session_id`, `targets[]` |
| `pipeline_teardown_complete` | INFO | 收尾完成 | `killed_count`, `duration_ms`, `errors[]` |
| `pipeline_complete` | INFO | 整条流水线会话结束 | `overall`, `report_path`, `process_exit_code` |

---

## 1. stage 实现规范（人话版）

各 stage 独立成文，结构统一为：**上游门闸 → 输入 → 处理逻辑 → 输出 → 解锁**（部分含日志事件表）。

| 分组 | stage | 说明 | 文档 |
| --- | --- | --- | --- |
| 准备 | `setup` | 初始化 inputs 与 pipeline 状态 | [stages/setup.md](stages/setup.md) |
| 文档 | `prd` | 生成 prd-spec 与各端 prd | [stages/prd.md](stages/prd.md) |
| 文档 | `prd-review` | AI 评审 PRD | [stages/prd-review.md](stages/prd-review.md) |
| 设计 | `design` | 按 feature 生成 design.json | [stages/design.md](stages/design.md) |
| 设计 | `design-review` | 评审设计可 codegen | [stages/design-review.md](stages/design-review.md) |
| 设计 | `create-ui-scenarios` | 派生 UI 场景 | [stages/create-ui-scenarios.md](stages/create-ui-scenarios.md) |
| 实现 | `codegen` | worktree 内写代码 + 内联 HTTP smoke | [stages/codegen.md](stages/codegen.md) |
| 实现 | `code-review` | 代码评审 | [stages/code-review.md](stages/code-review.md) |
| 发布 | `merge_push` | 合并并 push | [stages/merge_push.md](stages/merge_push.md) |
| 发布 | `build` | 探测框架、并行构建各端产物并输出报告 | [stages/build.md](stages/build.md) |
| 发布 | `deploy` | Cloudflare 部署 + 内联部署后 smoke + 失败分诊 | [stages/deploy.md](stages/deploy.md) |
| 验证 | `ui_e2e` | MCP 场景并行 + 失败分诊与 feature 修复子链 | [stages/ui_e2e.md](stages/ui_e2e.md) |
| 验证 | `report` | 人话总报告 + 错误日志 Agent 摘要 + 流水线收尾 | [stages/report.md](stages/report.md) |

脚本根目录：`ai-std4/scripts/`；`stages/` 下为各 stage 主脚本，`libs/` 下为所有子脚本，`run-pipeline.cjs` 位于根目录（见 [§3](#3-run-pipelinecjs-编排映射)）。


## 2. 门闸链汇总

| stage | 前置条件（缺失则退出码 1 或 4） |
| --- | --- |
| setup | — |
| prd | `stages.setup.status=completed` 且 `stages.setup.validation.passed=true` |
| prd-review | `stages.prd.status=completed` 且 `stages.prd.validation.passed=true` 且 `outputs.features[]` 非空 |
| design | `stages.prd_review.outputs.decision=passed` |
| design-review | `stages.prd_review.outputs.decision=passed` 且 design bootstrap 已完成；**单 feature** 另需 `stages.design.features.<id>.status=completed`（**不要求** design stage 整体 completed） |
| create-ui-scenarios | `stages.design_review.outputs.can_enter_codegen=true`（stage 可启动）；**单 feature** 另需 `stages.design_review.features.<id>.can_enter_codegen=true`；`config.dev.json.ui_e2e.enabled=true`（否则整段 `skipped`） |
| codegen | `stages.design_review.outputs.can_enter_codegen=true`；**单 feature** 另需 `stages.design_review.features.<id>.can_enter_codegen=true`。**与 create-ui-scenarios 无相互门闸**，两者按 [§3.2](#32-codegen--create-ui-scenarios-并行编排) 并行 |
| code-review | `stages.codegen.status=completed` |
| merge_push | `stages.code_review.status=completed` 且 `outputs.decision=passed` |
| build | `stages.merge_push.status=completed` |
| deploy | `stages.build.status=completed` |
| ui_e2e | `stages.deploy.status ∈ {completed, skipped}`；`ui_e2e.enabled=true`；**且** `stages.create_ui_scenarios.status ∈ {completed, skipped}`；若 `ui_e2e.require_deploy_smoke_passed=true`（默认）则另需 `stages.deploy.outputs.inline_smoke_passed=true`（deploy 内联 smoke，见 [deploy](stages/deploy.md)） |
| report | 无（总是运行） |

---


## 3. `run-pipeline.cjs` 编排映射

| stage | 脚本 |
| --- | --- |
| setup | `scripts/stages/setup.cjs`（内联依次调用 `libs/setup-inputs.cjs`、`libs/verify-inputs.cjs`、`libs/sync-config-env.cjs`、`libs/register-project.cjs`） |
| prd | `scripts/stages/prd.cjs` |
| prd-review | `scripts/stages/prd-review.cjs` |
| design | `scripts/stages/design.cjs` |
| design-review | `scripts/stages/design-review.cjs` |
| create-ui-scenarios | `scripts/stages/create-ui-scenarios.cjs` |
| codegen | `scripts/stages/codegen.cjs` |
| code-review | `scripts/stages/code-review.cjs` |
| merge_push | `scripts/stages/merge-push.cjs` |
| build | `scripts/stages/build.cjs` |
| deploy | `scripts/stages/deploy.cjs` |
| ui_e2e | `scripts/stages/ui-e2e.cjs` |
| report | `scripts/stages/report.cjs` |

`run-pipeline.cjs` 支持 `--from-stage=<stage> --to-stage=<stage>` 续跑，`--force-rerun=<stage>` 强制重跑单个 stage。

**自动启动看板**：`run-pipeline.cjs` 在启动流水线的同时，自动以 `spawn`（detached）方式在独立终端拉起 `run-dash.cjs`，默认传入当前 `--project` 路径：

```
启动顺序：
1. run-pipeline.cjs 解析 --project（见"项目自动探测"规则）
2. spawn run-dash.cjs --project=<解析后的绝对路径>（detached，不阻塞流水线）
3. 正常执行 stage 链
```

若当前终端不支持 TUI（如 CI 环境、`NO_COLOR=1`、`CI=true`），则跳过自动启动看板，仅输出纯文本进度到 stdout。

**停止信号检查**：`run-pipeline.cjs` 在每个 stage 进入前检查 `<项目根>/.pipeline/stop.signal`：

```text
for each stage in stageList:
  if stop.signal exists → log pipeline_stop → write pipeline.stop_info → exit(5)
  spawn stages/<stage>.cjs ...
```

各 `stages/<stage>.cjs` 脚本在启动时及每次调用 Agent 前同样执行相同检查；检测到信号后写 `pipeline_stop` 日志，`status` 置为 `stopped`（非 `failed`），退出码 `5`。

续跑时（`--from-stage`）会自动清除残留的 `stop.signal`，避免误拦截。

### 3.1 design / design-review 复合编排

`design` 与 `design-review` **不再**严格串行「design `completed` → 再跑 design-review」。`run-pipeline.cjs` 在两者均处于 stage 列表时进入 **复合阶段**（`design_phase`），直至 `design_review` stage 级完成或失败。

```text
design_phase:
  design-bootstrap + design-review-bootstrap（各一次）
  loop until design_review.status ∈ {completed, failed, stopped}:
    check stop.signal
    design.cjs --tick
    design-review.cjs --tick
    schedule_downstream_for_newly_released_groups()
```

**`schedule_downstream_for_newly_released_groups()`**（仅编排器实现，**不修改** create-ui-scenarios / codegen 等 stage 脚本正文）：

1. 读取 `stages.design_review.outputs.released_groups[]` 中尚未调度过的 `group_id`。
2. 对该组内**全部** `feature_ids[]` **同时**入队下游 **两条并行 track**（`codegen` 与 `create-ui-scenarios`，详见 [§3.2](#32-codegen--create-ui-scenarios-并行编排)）；组内 feature **多线程**执行，两 track 之间**无相互门闸**。
3. 并发上限：每条下游 track 各自取 `effective = min(当前下游 stage 的 feature_max_parallel, pipeline.autorun.feature_max_parallel)`；**design + design-review + 全部下游 track** 在途 feature Agent **合计**不得超过 `pipeline.autorun.feature_max_parallel`（全局天花板）。
4. 若剩余槽位不足以启动某个待调度 **整组**，则：
   - 优先调度**已 release 且组内在途数未满**的 group 的剩余 feature；
   - 对未 release 的 group **不**部分进入下游（组级原子性）；
   - 在 design / design-review 侧，若槽位不足以同时跑满一整组，按 `dependency_groups[].topo_order` **优先启动依赖端 feature**（与 [design.md](stages/design.md)、[design-review.md](stages/design-review.md) 一致）。
5. 若 `effective` 仍有空闲且已有 release 的 group 无在途任务，可启动**其他已 release group** 的 feature（跨组并行，直至触顶）。

**下游 feature 过滤**（编排器调用既有 stage 脚本时传入 `--feature=` 或脚本内读 `stages.design_review.features.<id>.can_enter_codegen`）：

- 仅处理 `can_enter_codegen=true` 的 feature；
- `create-ui-scenarios` / `codegen` 的 stage 文档与门闸表**不变**；过滤逻辑由 `run-pipeline` 在复合阶段负责。

**退出复合阶段**：`stages.design_review.status=completed` 且全部 `dependency_groups[]` 已在 `released_groups[]` 中出现（或对应 feature 均 `failed` 且流水线中止）→ 继续 stage 链中后续条目（若 create-ui-scenarios / codegen 已在复合阶段内按 feature 推进，则跳过已完成的 feature，仅补齐未 release 组）。

### 3.2 codegen + create-ui-scenarios 并行编排

`codegen` 与 `create-ui-scenarios` **无相互门闸**：两者各自只依赖 `stages.design_review.features.<id>.can_enter_codegen=true`，**且两者输出彼此不消费**（codegen 产物是代码 / 测试；create-ui-scenarios 产物只被 `ui_e2e` 消费）。`run-pipeline.cjs` 在两者都处于 stage 列表时进入 **复合阶段**（`build_phase`），将其作为**两条独立 track** 并行推进。

```text
build_phase:
  codegen-bootstrap + create-ui-scenarios-bootstrap（各一次，可并行）
  loop until (codegen.status ∈ {completed, failed, stopped}
              AND create_ui_scenarios.status ∈ {completed, failed, skipped, stopped}):
    check stop.signal
    codegen.cjs                --tick          # 独立 worker 池
    create-ui-scenarios.cjs    --tick          # 独立 worker 池
    refresh_release_groups_from_design_review()
```

**两条 track 的关系**：

| 维度 | codegen track | create-ui-scenarios track |
| --- | --- | --- |
| 触发源 | `design_review.features.<id>.can_enter_codegen=true` | 同左 |
| 失败影响 | feature 失败 → 该 feature `ui_e2e` 也无法跑（无代码）；**不**回滚 create-ui-scenarios | feature 失败 → 该 feature `ui_e2e` 跳过（无场景）；**不**回滚 codegen |
| 跳过条件 | hash 命中（design.json + worktree commit） | hash 命中（design.json + 已有 yaml）；或 `ui_e2e.enabled=false`（整段跳） |
| Worker 池 | 独立大小 `pipeline.stages.codegen.feature_max_parallel`；每个在途 feature 对应**一个长驻 worker 子进程**（跨 `--tick` 存活，托管 Agent + 看门狗 + resume，详见 [codegen.md](stages/codegen.md)） | 独立大小 `pipeline.stages.create_ui_scenarios.feature_max_parallel` |
| 单 feature 超时/卡死 | worker 看门狗心跳/FS/stdout 三路检测；自动 snapshot + interrupt + `codegen-impl-resume.md` resume；不覆盖已生成代码 | Agent 超时直接记该 feature `failed`（场景生成无中间态可保留） |

**全局并发上限**：两条 track 的在途 Agent **合计**受 `pipeline.autorun.feature_max_parallel` 约束（与 design / design-review 同款全局门闸）。即：

```
sum_inflight(codegen) + sum_inflight(create_ui_scenarios) ≤ pipeline.autorun.feature_max_parallel
```

**调度策略**：编排器每个 `--tick` 轮转两条 track，**优先**给 codegen 分配空闲槽位（关键路径耗时更长），再分给 create-ui-scenarios；同 group 内 feature **同时**入两条队列、独立完成。

**退出复合阶段**：两条 track 均到达终态后，`run-pipeline.cjs` 在进入 `code-review` / `ui_e2e` 前做编排级 **join 校验**：

- `code-review` 启动前：`codegen.status=completed`（不要求 create-ui-scenarios，因 code-review 不读场景）；
- `ui_e2e` 启动前：`create_ui_scenarios.status ∈ {completed, skipped}` **且** `deploy.status ∈ {completed, skipped}`；若 `ui_e2e.require_deploy_smoke_passed=true` 则 `deploy.outputs.inline_smoke_passed=true`（与门闸表一致）。

> **不修改 codegen.md / ui_e2e.md / create-ui-scenarios.md 之外的 stage 脚本正文**；并行调度逻辑由 `run-pipeline.cjs` 集中实现。

### 3.3 流水线收尾（report 之后）

**`report` 是整条流水线的终点**。`report.cjs` 正常退出后，`run-pipeline.cjs` **必须**调用 **`pipeline-teardown.cjs`**（除非 `report --no-teardown`），在本 session 内结束全部由本流水线启动或托管的子进程与 detached 进程，然后主进程退出。

```text
after report.cjs exit 0:
  pipeline-teardown.cjs --project=... --session-id=...
  write pipeline.pipeline_complete_at（本地时间）
  write logs: pipeline_teardown_start / pipeline_teardown_complete
  exit run-pipeline with process exit code derived from stages.report.outputs.overall
```

**须收尾的对象**（登记于 `<项目根>/.pipeline/session-<session_id>.json` 或由编排器内存表维护）：

| 类型 | 说明 | 收尾动作 |
| --- | --- | --- |
| **detached** `run-dash.cjs` | 启动看板 | SIGTERM → 等待 5s → SIGKILL |
| **design_phase** | `design.cjs` / `design-review.cjs` 在途 tick | 不再发起新 `--tick`；SIGTERM 在途子进程 |
| **build_phase** | `codegen.cjs` / `create-ui-scenarios.cjs` tick + codegen 长驻 worker | 停止 worker 池；SIGTERM 在途 Agent |
| **stage 子进程** | build / deploy / ui_e2e 并行子进程 | 按 `.pipeline/locks/*.pid` 结束 |
| **ui_e2e 修复子链** | `ui-e2e-repair-chain` 嵌套 stage | 标记 `repair_chain_interrupted`，SIGTERM |

**禁止**：teardown 时 `git reset --hard`、删除 `worktrees/`、`logs/` 或 `.pipeline/reports/`。

**`run-pipeline.cjs` 进程退出码**（由 `stages.report.outputs.overall` 推导）：

| `overall` | 退出码 |
| --- | ---: |
| `success` / `partial` | **0** |
| `failed` | **4** |
| `blocked` | **9** |
| `stopped` | **5** |
| report 未生成 | **1** |

详见 [report 阶段](stages/report.md)。

### 3.4 stage 失败后的编排级自动修复（`run-pipeline`）

当 **单个 step**（含复合阶段 `design_phase` / `build_phase` 整体）以**可恢复**非零退出时，`run-pipeline.cjs` **在继续后续 step 之前**（`report` 除外）调用编排级修复子流程 **`pipeline-recovery`**，避免仅依赖人工读日志再 `--from-stage` 续跑。

> **与 stage 内部分诊的关系**：`deploy`（`fix_script` / `retry_deploy`）、`ui_e2e`（`fix_prompt` / `fix_code` 子链）已在各自 `stages/*.cjs` 内尝试修复；编排级 recovery **不重复**同一轮已用尽的内部分诊配额，但若 stage 仍以退出码 **4** / **3** 等离开且未写 `blocked`，则由 `run-pipeline` 兜底。

#### 触发条件

| 条件 | 说明 |
| --- | --- |
| step 退出码 ∈ **可恢复集** | 默认 **`3`**（超时）、**`4`**（质量门/可修失败）；可配置扩展 |
| 非 **不可恢复** | **`5`** stopped、**`9`** blocked、**`2`** pending_user_input → **不**触发 |
| `pipeline.recovery.enabled=true` | 默认 **true**；`false` 时仅记日志，行为与现网一致（继续后续 step） |
| `CURSOR_API_KEY` 已设置（`loadProjectEnv` 后） | 未设置 → 写 `recovery_skipped`（WARN），不派发 Agent |
| 未超 `max_attempts_per_stage` | 默认每 **(step, exit_code)** 每 session **2** 次（exit 3 与 exit 4 分开计次） |

**不触发 recovery 的 step**：`report`（终点）；`setup` 退出码 **2**（等用户填表）。

#### 子流程（`libs/pipeline-recovery.cjs`，由 `run-pipeline` 调用）

```text
on step exit_code ∉ {0,5,9,2} and recoverable:
  1. assemble_error_bundle(stage, exit_code, stages.json, log_tail, …)
     → .pipeline/pipeline-recovery-<stage>.json（含 input + 空 recovery）
     → 附加：error_signatures、failed_features、artifact_excerpts（codegen worker）、recovery_hints
  2. spawn pipeline-recovery Agent（prompts/pipeline-recovery.md）
     → 分析签名 / worker 摘录 / stages / *-triage*.json
     → 修改文件（skill 或 project 二选一）
     → self_review（写入 recovery.self_review）
  3. 脚本确定性门闸（repair_target=skill 且 decision=fix）：
     → node ai-std4/scripts/self-test-pipeline-recovery.cjs（失败则 recovery_failed，不重跑）
     → git commit + push（见下表）
     → 若 build_phase/codegen 且适用：删除 .pipeline/workers/codegen/*.tmp.cjs
     → Ajv 校验 recovery JSON
  4. switch recovery.decision:
       fix | retry_only → 重跑**同一 step**（复合阶段重跑整个 design_phase/build_phase）
       blocked          → 写 pipeline.recovery_blocked_at、停止后续 step（进程最终倾向 9）
       invalid/missing  → 记 recovery_failed，**不**重跑，继续原「非零仍往下」语义
  5. 若重跑后仍失败且 attempts 未用尽 → 回到 1（**按 step + exit_code 计次**，exit 3 用尽仍可 recovery exit 4）
```

#### 双仓 git 规则

| `repair_target` | 工作目录 | commit | push |
| --- | --- | --- | --- |
| `skill` | `CURSOR_SKILLS_ROOT` 下含 `ai-std4/` 的 **git 根**（通常即 skill 安装仓） | 仅 `ai-std4/**` 相关路径 | **必须**尝试 `push`（失败 → `git.pushed=false`，recovery 仍可 `fix` 但打 `prompt_publish_failed` 同级 WARN） |
| `project` | 业务 `--project` 根 | 项目内变更（含 `docs/`、源码、`.pipeline/` 允许提交的产物） | `git.auto_commit=true` 时阶段结束 **commit**；`git.allow_push=true` 且已配置 `git.remote`/`remote_url` 时 **push**；否则在 `git_sync` / 日志中写明 `push_skipped_reason` |
| `none` | — | `retry_only` / `blocked` | 不提交 |

**硬约束**（Agent 与脚本共同遵守）：

1. **禁止**把 `inputs/config.env`、API Token、`.env` 打进任一 commit。
2. **禁止**在 `repair_target=skill` 时改业务仓；**禁止**在 `repair_target=project` 时改 `ai-std4/`。
3. commit message 建议：`fix(ai-std4): <stage> recovery — <reason 摘要>`（skill）或 `fix: <stage> pipeline recovery`（project）。
4. push 前脚本可选跑 **`git diff --stat`** 摘要写入日志事件 `recovery_review`（确定性评审，非 second Agent）。

#### 配置（`docs/config.*.json` → `pipeline.recovery`）

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `max_attempts_per_stage` | `2` | 每个 step 每 `run_id` 最多 recovery 轮次 |
| `recoverable_exit_codes` | `[3, 4, 6, 8]` | 触发 recovery 的 stage 退出码（**6**=merge_push 冲突，**8**=deploy 重试用尽等） |
| `log_tail_lines` | `200` | 注入 Agent 的 stage 日志尾行数 |
| `require_push_for_skill_fix` | `true` | skill 修复后 push 失败是否仍视为 `fix`（默认仍 `fix`，仅 WARN） |
| `run_self_test_after_skill_fix` | `true` | `decision=fix` 且 `repair_target=skill` 后跑 `self-test-pipeline-recovery.cjs` |
| `clear_stale_codegen_workers` | `true` | 重跑前删除 `.pipeline/workers/codegen/*.tmp.cjs`（避免旧内联 worker） |
| `artifact_excerpt_max_bytes` | `12000` | 错误包中 worker 摘录总字节上限 |

#### 日志事件（`stage=pipeline`）

| 事件 | 级别 | 时机 |
| --- | --- | --- |
| `recovery_start` | INFO | 开始 recovery | `failed_stage`, `exit_code`, `attempt` |
| `recovery_review` | INFO | Agent 完成自评 / 脚本 diff 摘要 | `repair_target`, `files_changed[]` |
| `recovery_git_push` | INFO / WARN | skill 或 project push 结果 | `repo`, `pushed`, `commit` |
| `recovery_complete` | INFO | recovery 结束 | `decision`, `will_retry_step` |
| `recovery_blocked` | ERROR | `decision=blocked` | `user_actions[]` |
| `recovery_skipped` | WARN | 未派发 Agent | `reason` |
| `recovery_self_test_passed` | INFO | skill 修复后确定性自测通过 | `script` |
| `recovery_self_test_failed` | ERROR | 自测未通过，本轮 recovery 失败 | `output` |
| `recovery_artifacts_cleared` | INFO | 已清理 stale codegen worker | `count`, `files` |

#### `stages.json` 写入

`pipeline.recovery_history[]`（追加，不覆盖）：

```json
{
  "stage": "prd-review",
  "exit_code": 4,
  "attempt": 1,
  "decision": "fix",
  "repair_target": "skill",
  "commit": "870b548",
  "pushed": true,
  "at": "2026-05-19 14:30:00 +0800"
}
```

#### 实现清单

| 路径 | 职责 |
| --- | --- |
| `scripts/run-pipeline.cjs` | step 失败后调用 recovery；按 `decision` 重跑或中止 |
| `scripts/libs/pipeline-config.cjs` | `loadProjectEnv`、模型/skills 根解析 |
| `scripts/libs/invoke-sdk-agent.cjs` | 统一 SDK Agent 调用 + artifact JSON |
| `scripts/libs/pipeline-recovery.cjs` | 组装错误包、SDK Agent、Ajv、git commit/push 封装 |
| `scripts/self-test-pipeline-recovery.cjs` | 无 Agent 确定性自测（门闸、Ajv、bundle） |
| `prompts/pipeline-recovery.md` | 修复 Agent 提示词 |
| `schemas/pipeline-recovery-output.schema.json` | recovery JSON |

> **实现状态**：上述脚本已在 `ai-std4` 落地；需 `inputs/config.env` 中配置 `CURSOR_API_KEY` 并经 setup 同步后，才会派发修复 SDK Agent，否则打 `recovery_skipped`。

#### 各 stage 修复能力矩阵（setup / report 除外）

| Step / Stage | Stage 内修复 | 实现 | 编排级 `pipeline-recovery`（默认可恢复 exit） |
| --- | --- | --- | --- |
| prd / prd-review | 瞬时重试 | `agent_retry`（schema/缺文件） | ✅ 3/4 |
| design_phase | 同上 | design + design-review `agent_retry` | ✅ 3/4 |
| build_phase | 同上 + codegen resume | create-ui-scenarios / codegen | ✅ 3/4 |
| code-review | 瞬时重试 | `agent_retry` | ✅ 3/4 |
| merge_push | 脚本 | `git pull --rebase` 后再 push | ✅ **6**/3/4 |
| build | — | 无分诊；失败记 `outputs` | ✅ 3/4 |
| deploy | **专用分诊** | `deploy-triage` → `retry_deploy` / **`fix_script` 后同 stage 重部署** / `blocked` | ✅ 3/4/8；`blocked` 跳过 recovery |
| ui_e2e | **专用分诊+子链** | 场景重试 + `ui-e2e-triage` + **`skill-prompt-publish`** + repair chain | ✅ 3/4；`blocked_features` 跳过 recovery |

**统一约定**：

- 所有 **SDK 分诊/修复 Agent** 均经 `libs/invoke-sdk-agent.cjs` + `CURSOR_API_KEY`。
- **无 stage 分诊** 的 step（build、merge_push、多数 Agent stage）在 exit **3/4/6/8** 时由 **`pipeline-recovery`** 兜底（可改 skill 或 project 后重跑本 step）。
- **setup**：退出码 **2** 不触发 recovery；**report**：永不触发。

---


## 4. Agent 卡点速查

| 场景 | 退出码 | 处理方式 |
| --- | ---: | --- |
| 任意 stage 可恢复失败且已开 recovery | 3 / 4 | 优先 [§3.4](#34-stage-失败后的编排级自动修复run-pipeline)：日志分析 → 修 skill/项目 → commit+push → 重跑本 step；用尽后再 `--from-stage=<stage>` |
| `inputs/req.md` / `config.env` 未填完 | 2 | 用户补全后重跑 `--from-stage=setup` |
| prd-spec 不符合 schema / 需求变更 | 4 | Agent 按 `prompts/prd-spec-author.md` 更新，重跑 `--from-stage=prd` |
| 缺少 `.pipeline/prd-review-<client_target>.json`（某端） | 4 | 对该端重跑 Agent（`--from-stage=prd-review`）；检查对应 `prompts/prd-review-*.md` |
| 合并后缺少 `.pipeline/prd-review-output.json` | 4 | 重跑 `prd-review-validate.cjs` 或 `--from-stage=prd-review` |
| prd-review `decision=failed` | 4 | Agent 改 PRD，重跑 `--from-stage=prd` |
| design.json 校验失败 | 4 | Agent 修 design，重跑 `--from-stage=design [--feature=<id>]` |
| 缺少 `.pipeline/design-review-<feature_id>.json` | 4 | 对该 feature 重跑 Agent；复合阶段中 `design-review.cjs --tick --feature=<id>` |
| design-review `blocking` gap / 组未 release | 4 | 改 `design.json` 后 `--from-stage=design --feature=<id>`；仅评审问题 → `design-review --feature=<id>` |
| 某 group 长期未 `group_released` | — | 检查 `dependency_groups[]` 内是否仍有 feature 未完成 design 或未 `passed` |
| UI 场景 schema 校验失败 | 4 | Agent 重试已自动 2 次，仍失败 → 检查 `design.json.acceptance`，必要时回 `--from-stage=design --feature=<id>`；仅修场景 → `--from-stage=create-ui-scenarios --feature=<id>` |
| 单 feature UI 场景超时 | 3 | 调大 `timeouts.stages.create_ui_scenarios_s`；其它 feature 与 codegen track **不受影响**，重跑 `--from-stage=create-ui-scenarios --feature=<id>` |
| 非 UI feature 被跳过场景 | — | 正常行为（`client_target=backend` 且无前端 client_targets[]）；ui_e2e 阶段自然不会消费 |
| codegen 单 feature 累计挂钟超 `timeouts.stages.codegen_s` | 3 | 调大 `timeouts.stages.codegen_s`，重跑 `--from-stage=codegen --feature=<id>`（worker 自动以 resume 继续，不清空 worktree） |
| codegen 单 feature 心跳/FS/stdout 静默假死 | — | 自动 `agent_hang_detected` → 快照 wip commit → SIGINT/SIGKILL → `codegen-impl-resume.md` 续跑，最多 `max_resume_attempts` 次；无需人工 |
| codegen 单 feature `resume` 用尽仍失败 | 4 | 查 `hang_history[]` / `last_error`；若 prompt/约束问题改 prompt；若资源不足调大 `attempt_max_s` / `max_resume_attempts` 后 `--from-stage=codegen --feature=<id>` |
| codegen worker 进程崩溃 | — | 下一轮 `--tick` 自动标 `crashed` 并以 resume 重启该 feature（计入 `attempts_used`）；触顶后 `failed` |
| code-review 单 feature `critical_issues > 0` 或 `decision=failed` | 4 | 查 `.pipeline/code-review-<feature_id>.json` 的 `issues[]`；改代码后 `--from-stage=codegen --feature=<id>`（codegen worker 自动以 resume 继续），然后 `--from-stage=code-review --feature=<id>` 重评 |
| code-review 单 feature 评审 Agent 超时 | 3 | 调大 `timeouts.stages.code_review_s`；其它 feature **不受影响**，重跑 `--from-stage=code-review --feature=<id>` |
| code-review schema 校验失败 / deterministic_issues 遗漏 | — | 自动 `agent_retry`（≤ `max_retries`）；超出后该 feature `failed`，按上一行处理 |
| code-review stage 级 `decision=failed` | 4 | 至少一个 feature 失败；按 `outputs.failed_features[]` 逐一处理后 `--from-stage=code-review` |
| merge_push 冲突 | 6 | 人工解冲突后重跑 `--from-stage=merge_push` |
| merge_push push 失败 | 7 | 网络/权限问题，修复后重跑 `--from-stage=merge_push` |
| build 单端超时 | 3 | 调大 `timeouts.stages.build_s` 或 `pipeline.stages.build.client_max_parallel` 后重跑 `--from-stage=build` |
| build 命令/产物校验失败 | 4 | 查 `.pipeline/reports/build-summary.md` 与 `logs/stages/build/*`；修代码或 `build.client_targets` / `commands` 后重跑 `--from-stage=build` |
| build 门闸/HEAD 不一致 | 1 | `git checkout <final_commit>` 或重跑 `--from-stage=merge_push` 后再 build |
| deploy 未授权 destructive | 1 | 配置 `allow_destructive_deploy=true` 或加 `--explicit-confirm` |
| deploy 无可部署端（无 website/admin/backend） | — | 正常 `skipped`，退出 0 |
| deploy Cloudflare API / 瞬态失败 | 8 | 查 `deploy-summary.md` 与 `logs/stages/deploy/*`；网络/配置恢复后 `--from-stage=deploy` |
| deploy 分诊 `blocked`（权限/配额等） | 9 | 按 `stages.deploy.outputs.user_actions[]` 在控制台处理；**勿**自动续跑下游 |
| deploy 脚本缺陷、Agent 修复次数用尽 | 4 | 人工改 `ai-std4` deploy 脚本或加大 `agent_fix_max_attempts` 后 `--from-stage=deploy` |
| deploy 超时 | 3 | 调大 `timeouts.stages.deploy_s` 后重跑 `--from-stage=deploy` |
| codegen 内联 smoke 失败 | 4 | 查 feature 日志与 `features.<id>.smoke_checks[]`；修代码后 `--from-stage=codegen --feature=<id>` |
| deploy 内联 smoke 失败 | 4 | 查 `deploy-summary.md` 与 `outputs.inline_smoke_failures[]`；修复后 `--from-stage=deploy` |
| ui_e2e 单场景失败（分诊前） | 4 | 查 `ui-e2e-*.md` 报告与 `.pipeline/logs/snapshots/<scenario_id>/`；`--from-stage=ui_e2e --scenario=<id>` |
| ui_e2e 分诊 `fix_code` / 子链中断 | 4 | 查 `repair_chain_failed` 日志；从失败 stage 重跑 `--from-stage=<stage> --feature=<id>` |
| ui_e2e 分诊 `blocked` | 9 | 按 `blocked_features[]` 处理环境/产品问题后再跑 |
| ui_e2e 分诊 `fix_prompt` 后仍失败 | 4 | 检查 skill 仓提示词 push 是否成功；再 `fix_code` 或改场景 `--from-stage=create-ui-scenarios` |

---


## 5. prompts 文件清单

真源目录：**[`docs/spec/std4/prompts/`](prompts/)**（实现时挂载为 `ai-std4/prompts/`）。

**无 Agent 的 stage**（纯脚本）：`setup`、`merge_push`、`build`。

| prompt | 被哪个 stage 调用 | 职责 |
| --- | --- | --- |
| [prd-spec-author.md](prompts/prd-spec-author.md) | prd（Agent-A） | 增量补全 `docs/prd-spec.md` |
| [prd-client-author.md](prompts/prd-client-author.md) | prd（Agent-B） | 增量补全该端 `prd-*.json` + `feature_list-*.md` |
| [prd-review-web.md](prompts/prd-review-web.md) | prd-review | 评审 web/website/frontend → `prd-review-<client_target>.json` |
| [prd-review-backend.md](prompts/prd-review-backend.md) | prd-review | 评审 backend |
| [prd-review-mobile.md](prompts/prd-review-mobile.md) | prd-review | 评审 mobile |
| [prd-review-admin.md](prompts/prd-review-admin.md) | prd-review | 评审 admin |
| [prd-review-default.md](prompts/prd-review-default.md) | prd-review | 未知端兜底 |
| [design-spec.md](prompts/design-spec.md) | design | 产出 `docs/designs/<feature_id>.design.json` |
| [design-review.md](prompts/design-review.md) | design-review | 产出 `.pipeline/design-review-<feature_id>.json` |
| [create-ui-scenarios.md](prompts/create-ui-scenarios.md) | create-ui-scenarios | 产出 `docs/ui-scenarios/<feature_id>.scenarios.yaml` |
| [codegen-impl.md](prompts/codegen-impl.md) | codegen（首次） | worktree 实现 + JSON Lines 心跳 |
| [codegen-impl-resume.md](prompts/codegen-impl-resume.md) | codegen（resume） | 续跑，禁止覆盖 `do_not_overwrite[]` |
| [code-review-agent.md](prompts/code-review-agent.md) | code-review | 只读评审 → `code-review-<feature_id>.json` |
| [deploy-triage.md](prompts/deploy-triage.md) | deploy（失败分诊） | → `deploy-triage.json` |
| [ui-e2e-triage.md](prompts/ui-e2e-triage.md) | ui_e2e（失败分诊） | → `ui-e2e-triage-<feature_id>.json` |
| [ui-e2e-run-scenario.md](prompts/ui-e2e-run-scenario.md) | ui_e2e（`--use-sdk-scenarios` 时） | Agent 辅助逐步 MCP；默认由 runner 直驱 |
| [report-author.md](prompts/report-author.md) | report（有失败时） | 人话「失败与原因」「建议的下一步」 |
| [pipeline-recovery.md](prompts/pipeline-recovery.md) | run-pipeline（stage 失败） | 分析日志 → 修 skill/项目 → 自评 → commit+push → `.pipeline/pipeline-recovery-<stage>.json` |

---

## 6. 附录：模板文件

所有模板位于 **`docs/spec/std4/templates/`**。脚本在目标文件不存在时从此处拷贝，拷贝后由脚本或 Agent 填入实际值。

| 模板 | 说明 |
| --- | --- |
| [req-template.md](templates/req-template.md) | inputs/req.md 模板；`verify-inputs.cjs` 检查带 `*` 的 H2 节非空 |
| [config.env.template](templates/config.env.template) | inputs/config.env 模板；不进 git |
| [config.json.template](templates/config.json.template) | docs/config.dev.json / config.release.json 模板 |
| [stages.json.template](templates/stages.json.template) | `.pipeline/stages.json` 初始骨架 |
| [prd-spec.md.template](templates/prd-spec.md.template) | docs/prd-spec.md 模板 |
| [prd-web.json.template](templates/prd-web.json.template) | docs/prd-web.json 模板（前端/Web） |
| [prd-backend.json.template](templates/prd-backend.json.template) | docs/prd-backend.json 模板（服务端） |
| [prd-mobile.json.template](templates/prd-mobile.json.template) | docs/prd-mobile.json 模板（移动端） |
| [prd-admin.json.template](templates/prd-admin.json.template) | docs/prd-admin.json 模板（管理后台） |
| [prd-default.json.template](templates/prd-default.json.template) | 未知端兜底 prd JSON 模板 |

---

## 7. `run-dash` — 流水线状态看板

**脚本**：`ai-std4/scripts/run-dash.cjs`

**调用形态**：

```bash
# 手动启动（手动指定项目）
node ai-std4/scripts/run-dash.cjs --project=<业务项目根绝对路径> [--tail=50]

# 自动启动（由 run-pipeline.cjs 在流水线启动时自动调用，无需手工执行）
node ai-std4/scripts/run-dash.cjs --project=<绝对路径> --auto-launched
```

### 项目自动探测

`run-dash` 与 `run-pipeline.cjs` 共用同一套项目路径解析规则，**优先级从高到低**：

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | `--project=<路径>` 参数 | 显式指定，绝对或相对路径均可（自动转绝对） |
| 2 | 环境变量 `AI_STD4_PROJECT` | `export AI_STD4_PROJECT=/path/to/project` |
| 3 | **当前工作目录（`process.cwd()`）** | 在哪个项目目录下运行 skill，就默认用哪个 |

取到路径后校验：若 `<路径>/.pipeline/stages.json` 不存在，则提示"未找到已初始化的 std4 项目，请先运行 setup"，退出码 `1`。

### 功能定位

`run-dash` 是一个**只读 TUI（终端 UI）看板**，实时监视**阶段**与**逐 feature**执行态（读 `stages.json` 的 `stages.*.features`），提供停止按钮与 feature 级日志切换。
它不参与流水线执行逻辑，任何时候退出看板都不影响正在运行的流水线。

### 实现依赖

| 依赖 | 说明 |
| --- | --- |
| `blessed` 或 `ink` | TUI 渲染（推荐 `blessed`，纯 Node.js，无需编译） |
| `fs.watch` / `chokidar` | 监听 `stages.json` 与日志文件变更 |
| `tail-file` 或手动 `readline` | 追读日志文件新增行 |

### TUI 布局

三栏：**阶段状态**（左）· **Feature 状态**（中）· **日志**（右）。中间栏在 feature 并行 stage 运行时展示逐 feature 进度；其余 stage 显示跨阶段汇总条。

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│  ai-std4 流水线看板  项目: RealNotes  启动: 2026-05-18 08:30:15   Feature: 3/12 · 在途 2 │
├─────────────────┬──────────────────────────────┬─────────────────────────────────────────┤
│  阶段状态       │  Feature 状态 [codegen]      │  日志（末 50 行）                        │
│                 │  ✓3  ⟳2  ○5  ✗1  ↷1  ⏳0    │  源: stage/codegen  · AUTH-LOGIN-001     │
│                 │                              │                                         │
│  ✓ setup   00:12│  ⟳ AUTH-LOGIN-001    02:15  │  [08:45:01] [INFO] worker_start        │
│  ✓ prd     08:20│  ⟳ PROJECT-CREATE-001 01:02 │  feature_id: AUTH-LOGIN-001           │
│  ✓ prd-review   │  ✓ AUTH-USER-001             │  attempt: 1 / max_resume: 2           │
│  ✓ design       │  ○ PROJECT-LIST-001      G1  │  [08:45:04] [INFO] agent_heartbeat      │
│  ✓ design-review│  ○ PROJECT-DASH-001      G1  │  ...                                    │
│  ⟳ codegen ←当前│  ⏳ BACKEND-API-QUERY-001  G2 │                                         │
│  ⟳ create-ui-… │  ✗ CLI-MODE-QUERY-001    G2  │                                         │
│  ○ code-review  │  ↷ FEISHU-BIDIR-001  skip    │                                         │
│  ○ merge_push   │  （↑/↓ 滚动 · Enter 选中）   │                                         │
│  ○ build        │                              │                                         │
│  ○ deploy       │                              │                                         │
│  ○ ui_e2e       │                              │                                         │
│  ○ report       │                              │                                         │
├─────────────────┴──────────────────────────────┴─────────────────────────────────────────┤
│  [S] 停止  [R] 刷新  [F] 切换 track  [↑/↓] 滚动  [Enter] 选中 feature  [Q] 退出看板      │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 阶段状态图标（左栏）

| 状态图标 | 含义 |
| --- | --- |
| `✓` | completed |
| `⟳` | running / started（Agent 处理中），显示已用时长 |
| `✗` | failed |
| `↷` | skipped |
| `◈` | stopped |
| `○` | pending（未开始） |
| `⚠` | pending_user_input（仅 setup） |

#### Feature 状态面板（中栏）

| 项 | 说明 |
| --- | --- |
| **适用 stage** | `design`、`design-review`、`create-ui-scenarios`、`codegen`、`code-review`、`ui_e2e`（凡在 `stages.<stage>.features.<feature_id>` 维护执行态的 stage） |
| **全集** | `stages.prd.outputs.features[]` 的 `feature_id`（索引真源，见 [prd § 真源分层](stages/prd.md#真源分层重要)） |
| **单行状态** | 当前 **track** 对应 stage 的 `stages.<stage>.features.<id>.status`；该 stage 尚无条目时显示 `—`（未到达） |
| **标题 `[codegen]`** | 当前 track 的 stage 名；复合阶段（design+design-review、codegen+create-ui-scenarios）下用 `[F]` 在并行 track 间切换 |
| **汇总行** | 对当前 track 统计各 status 数量（`✓3 ⟳2 ○5 …`），与顶栏 `Feature: 已完成/总数 · 在途 N` 一致 |
| **行尾 `G1`** | 可选显示 `features.<id>.group_id` 短写（依赖组，便于对照 `dependency_groups[]`） |
| **行尾 `skip`** | `status=skipped` 时附原因缩写（如 `no_ui`、`no_codegen`，取自 stage 字段 `skip_reason` 若存在） |
| **design-review 附加** | `can_enter_codegen=true` 且尚未进入 codegen 时，行尾可加 `→codegen` 标记 |

| Feature 状态图标 | `features.<id>.status` | 含义 |
| --- | --- | --- |
| `○` | `pending` | 未开始 |
| `⏳` | `pending_dep` | 等待同组依赖 feature 完成（codegen 等） |
| `⟳` | `running` | Agent / worker 处理中，显示已用时长 |
| `✓` | `completed` | 本 stage 该 feature 已完成 |
| `✗` | `failed` | 失败（可看 feature 日志或 `last_error`） |
| `↷` | `skipped` | 本 stage 跳过（非失败） |
| `◈` | `stopped` | 响应 `stop.signal` 后停止 |
| `⚡` | `crashed` | worker 进程异常退出（codegen 等；编排器下轮可 resume） |

**排序**：`running` → `pending_dep` → `pending` → `failed` → `stopped` → `crashed` → `completed` → `skipped`；同优先级按 `priority`（P0 在前）再按 `feature_id` 字典序。

**非 feature 并行 stage**（如 `prd`、`build`、`deploy`）：中栏不列逐行，改为**跨 stage 汇总表**（每 feature 一行，列显示 design / codegen / ui_e2e 等关键节点的末态缩写，如 `D✓ C⟳ E○`），数据同样只读 `stages.*.features`。

### 数据来源与刷新机制

| 数据 | 来源文件 / 字段 | 刷新触发 |
| --- | --- | --- |
| 阶段状态列表 | `stages.json` → `stages.<stage>.status` | `fs.watch` 变更后 100ms 防抖重读 |
| 阶段耗时 | 各 stage 的 `started_at` / `completed_at`；running 时动态计算 | 每秒刷新计时器 |
| Feature 全集 | `stages.prd.outputs.features[]` | 随 `stages.json` 重读 |
| Feature 单行状态 | `stages.<当前 track>.features.<feature_id>.status`（及 `group_id`、`skip_reason`、`can_enter_codegen` 等） | 随 `stages.json` 重读；`running` 行每秒刷新耗时 |
| Feature 汇总 / 顶栏进度 | 对当前 track 的 `features` 做 status 计数；顶栏 `已完成/总数` 可取 codegen 或「最靠后已启动的 feature stage」 | 随 `stages.json` 重读 + 每秒刷新在途数 |
| 日志追读（默认） | `logs/stages/<当前 stage>/<datetime>.log` | 每 500ms 读新增行 |
| 日志追读（选中 feature） | `logs/features/<feature_id>/<datetime>.log`（与 stage 日志共用 `pipeline.run_id` / `started_at` 推导的 `datetime`） | 选中后切换路径；每 500ms 追读 |
| 流水线停止状态 | `.pipeline/stop.signal` | `fs.watch`；存在时底栏变红 |

### 键盘操作

| 按键 | 行为 |
| --- | --- |
| `S` / `s` | 弹出确认框："确认停止流水线？[Y/N]"；确认后调用 `stop-pipeline.cjs`，写入 `stop.signal` |
| `Q` / `q` / `Ctrl+C` | 退出看板（**不停止**流水线） |
| `R` / `r` | 强制重新读取 `stages.json`，刷新阶段与 Feature 面板 |
| `F` / `f` | 在复合阶段的并行 track 间切换（如 `codegen` ↔ `create-ui-scenarios`）；无并行 track 时无操作 |
| `Enter` | 在中栏选中当前高亮 feature：日志源切至 `logs/features/<feature_id>/`；再次 `Enter` 取消选中，回到 stage 日志 |
| `↑` / `↓` | 焦点在中栏时滚动 Feature 列表；焦点在日志栏时滚动日志 |
| `Tab` | 在「阶段 / Feature / 日志」焦点间循环（可选实现；至少支持 ↑↓ 分栏滚动） |
| `PgUp` / `PgDn` | 当前焦点面板翻页 |

### 停止确认交互

```
╔══════════════════════════════════════╗
║  确认停止流水线？                    ║
║  当前阶段：prd（Agent 运行中）       ║
║  停止后可用 --from-stage=prd 续跑    ║
║                                      ║
║     [Y] 确认停止    [N] 取消         ║
╚══════════════════════════════════════╝
```

确认后：写入 `stop.signal` → 底部状态栏变红显示"停止中，等待当前步骤完成…" → 监听到 `pipeline.stop_info` 写入 `stages.json` 后显示"已停止"。

---


## 8. `stop-pipeline` — 停止流水线脚本

**脚本**：`ai-std4/scripts/stop-pipeline.cjs`

**调用形态**：

```bash
# 命令行直接停止
node ai-std4/scripts/stop-pipeline.cjs --project=<业务项目根绝对路径> [--reason="<原因>"]

# run-dash 内部调用（由看板 S 键触发，无需手工执行）
```

### 处理逻辑

1. 检查 `<项目根>/.pipeline/stages.json` 存在，否则退出码 `1`（项目未初始化）。
2. 检查是否已存在 `stop.signal`，若存在则打印"流水线已在停止中"，退出码 `0`。
3. 写入 `<项目根>/.pipeline/stop.signal`：
```json
{
  "requested_at": "<本地时间 YYYY-MM-DD HH:mm:ss Z>",
  "reason": "<--reason 参数值，默认 user_request>",
  "requested_by": "stop-pipeline-cmd"
}
```
4. 打印提示：
```
✓ 停止信号已写入。流水线将在当前步骤完成后停止。
  续跑命令：node ai-std4/scripts/run-pipeline.cjs --project=<path> --from-stage=<stopped_stage>
```
5. 退出码 `0`。

### 注意事项

- `stop-pipeline.cjs` **只写信号文件**，不做任何 kill 操作，保证原子操作的完整性。
- 续跑时 `run-pipeline.cjs` 会自动清除 `stop.signal`，无需手工删除。
- 若需立即强制终止（紧急情况），用 `Ctrl+C` 中断 `run-pipeline.cjs` 进程，但可能导致 stages.json 状态不一致，续跑前需手工校正 `status` 字段。

---

## 9. 附录：JSON Schema 文件

所有 Schema 位于 **`docs/spec/std4/schemas/`**，供脚本通过 **Ajv**（JSON Schema draft-07）校验 Agent 产出与脚本写入的 JSON。

| Schema | 校验目标 |
| --- | --- |
| [stop.signal.schema.json](schemas/stop.signal.schema.json) | `.pipeline/stop.signal` |
| [stages.json.schema.json](schemas/stages.json.schema.json) | `.pipeline/stages.json` |
| [config.json.schema.json](schemas/config.json.schema.json) | `docs/config.dev.json` / `config.release.json` |
| [prd-client.base.schema.json](schemas/prd-client.base.schema.json) | 所有 `docs/prd-*.json` 公共字段（`allOf` 引用） |
| [prd-web.json.schema.json](schemas/prd-web.json.schema.json) | `docs/prd-web.json` |
| [prd-backend.json.schema.json](schemas/prd-backend.json.schema.json) | `docs/prd-backend.json` |
| [prd-mobile.json.schema.json](schemas/prd-mobile.json.schema.json) | `docs/prd-mobile.json` |
| [prd-admin.json.schema.json](schemas/prd-admin.json.schema.json) | `docs/prd-admin.json` |
| [prd-default.json.schema.json](schemas/prd-default.json.schema.json) | 未知端 `docs/prd-<client_target>.json` |
| [prd-review-client-output.schema.json](schemas/prd-review-client-output.schema.json) | `.pipeline/prd-review-<client_target>.json` |
| [prd-review-output.schema.json](schemas/prd-review-output.schema.json) | `.pipeline/prd-review-output.json` |
| [design.json.schema.json](schemas/design.json.schema.json) | `docs/designs/<feature_id>.design.json` |
| [design-review-feature-output.schema.json](schemas/design-review-feature-output.schema.json) | `.pipeline/design-review-<feature_id>.json` |
| [ui-scenarios.yaml.schema.json](schemas/ui-scenarios.yaml.schema.json) | `docs/ui-scenarios/<feature_id>.scenarios.yaml`（先 YAML 解析后按 JSON Schema 校验） |
| [code-review-feature-output.schema.json](schemas/code-review-feature-output.schema.json) | `.pipeline/code-review-<feature_id>.json` |
| [deploy-triage-output.schema.json](schemas/deploy-triage-output.schema.json) | `.pipeline/deploy-triage.json` |
| [ui-e2e-triage-output.schema.json](schemas/ui-e2e-triage-output.schema.json) | `.pipeline/ui-e2e-triage-<feature_id>.json` |
