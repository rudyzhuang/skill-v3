# report 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [编排映射](../std4.md#3-run-pipelinecjs-编排映射) · [流水线收尾](../std4.md#33-流水线收尾report-之后) · [卡点速查](../std4.md#4-agent-卡点速查)

> 流水线**最后一站**：汇总各 stage 门闸与子报告，用 **Agent + 失败日志摘录** 生成**人话总报告**；完成后由 `run-pipeline.cjs` **自动收尾**（结束 detached 子进程、复合阶段 worker、看板等），整条流水线宣告结束。
>
> **无独立 smoke stage**：HTTP 冒烟结果见 `stages.codegen.features[].smoke_checks[]` 与 `stages.deploy.outputs.inline_smoke_*`。

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `stages/report.cjs` | 编排：collect →（可选）Agent 撰写失败摘要 → render → teardown 触发 |
| `libs/report-collect.cjs` | 只读聚合 `stages.json`、子报告路径、结构化日志中的 ERROR/WARN |
| `libs/report-log-extract.cjs` | 从 `logs/**` 抽取**失败/错误**行，写入 `.pipeline/reports/.report-error-excerpt-<datetime>.txt`（供 Agent，**禁止**整文件灌入 prompt） |
| `libs/report-render.cjs` | 将 `collected` + Agent 产出合并为最终 Markdown |
| `libs/pipeline-teardown.cjs` | 由 `run-pipeline.cjs` 在 report 成功后调用：结束本 session 全部子进程/线程 |

> 实现目录前缀：`ai-std4/scripts/`（`stages/` 为主脚本，`libs/` 为子脚本）。

```bash
node ai-std4/scripts/stages/report.cjs --project=<业务项目根绝对路径> [--session-id=] [--no-teardown]
```

> **重复运行（幂等）**：report 总是重新生成，覆盖当次 `<datetime>` 对应的报告文件（新文件使用更新后的 `<datetime>-<session_id>`）；`stages.report.status=completed` **不**导致跳过，无需 hash 门控（重新生成无副作用）。

## 上游门闸

**无硬性门闸**——`run-pipeline.cjs` 在 stage 链末尾**总是**调用 report（成功、失败、`stopped`、用户中断后 best-effort 均应生成报告）。

| 参数 | 说明 |
| --- | --- |
| `--project=` | 业务项目根（必填） |
| `--session-id=` | 本次会话 ID；缺省则生成 |
| `--datetime=` | 与 `logs/<datetime>.log` 一致；缺省从 `pipeline.run_started_at` 推导 |
| `--failure-reason=` | 编排器捕获的 stderr 一行摘要（可选） |
| `--from-stage=` | 续跑时写入报告「本次自 \<stage\> 接上」 |
| `--skip-agent` | 调试：跳过 Agent，仅用脚本模板填「失败与原因」节 |
| `--no-teardown` | 调试：**不**调用 `pipeline-teardown`（默认 **会** 收尾） |

> report 启动时若存在 `stop.signal`：**仍执行** report（用户需要结论），但 teardown 须尊重已停止状态，**不强启**新 Agent。

## 输入

| 来源 | 用途 |
| --- | --- |
| `output-stages/stages.json` | 各 stage `status` / `validation` / `outputs` / `features.*` |
| `pipeline.stop_info` | 用户停止：停在何 stage、原因 |
| `docs/config.dev.json` | 项目名、`ui_e2e.enabled`、`client_targets` |
| `stages.prd.outputs.features[]` | **索引真源**：feature 一览与依赖 |
| `logs/<datetime>.log` | 按 `event` + `LEVEL` 筛失败（见 [日志摘录](#日志摘录仅错误失败)） |
| `logs/stages/<stage>/**`、`logs/features/<feature_id>/**` | 路径索引（报告只链路径，不贴全文） |
| **各 stage 子报告**（存在则链接/表格索引） | 见下表 |

| 子报告 | 产出 stage |
| --- | --- |
| `.pipeline/reports/prd-implementation-summary.md` | prd-review |
| `.pipeline/reports/design-review-summary.md` | design-review |
| `.pipeline/reports/codegen-summary.md` | codegen |
| `.pipeline/reports/code-review-summary.md` | code-review |
| `.pipeline/reports/create-ui-scenarios-summary.md` | create-ui-scenarios |
| `.pipeline/reports/build-summary.md` | build |
| `.pipeline/reports/deploy-summary.md` | deploy |
| `.pipeline/reports/ui-e2e-<session>.md` | ui_e2e |

## 处理逻辑

### 1. `report-collect.cjs`（确定性聚合）

构建内存对象 **`collected`**（不写盘），包含：

- **run**：`session_id`、`datetime`、`started_at`、`ended_at`、`duration_ms`、`from_stage`
- **project**：`name`、`root_path`、`git.remote_url`、`final_commit`（`merge_push.outputs.final_commit`）
- **overall**（见 [overall 推导](#overall-推导)）
- **stages[]**：固定顺序 12 个核心 stage 各一条：`status`（人话标签）、`duration_ms`、`validation.summary`、关键 outputs 摘要
- **features[]**：合并 `prd.outputs.features[]` 与各 stage `features.<id>`：
  - design / design-review / codegen / code-review / create-ui-scenarios / ui_e2e 状态
- **`completed_tasks[]`** / **`failed_tasks[]`** / **`skipped_tasks[]`**：人话 bullet（见 [任务归类规则](#任务归类规则)）
- **artifacts**：`build.outputs.artifacts[]`、`deploy.outputs.services[]`（URL）
- **ui_e2e**：通过/失败场景数、`blocked_features[]`、截图根目录
- **sub_reports[]`**：`{ path, exists, stage }`
- **log_index[]`**：总日志、stage 日志、feature 日志相对路径
- **has_errors`**：是否存在任一 `failed` / `stopped` / `blocked` / Agent 失败事件

### 2. 日志摘录（仅错误/失败）

`report-log-extract.cjs` **只**收集与失败相关的行，写入：

```text
<项目根>/.pipeline/reports/.report-error-excerpt-<datetime>.txt
```

**纳入规则**（满足任一即收录，每行截断至 **500 字符**）：

| 来源 | 条件 |
| --- | --- |
| `logs/<datetime>.log` | `LEVEL` ∈ `{ERROR, WARN}`；或 `event` ∈ `stage_failed`, `agent_failed`, `agent_timeout`, `agent_stall_detected`, `validation_fail`, `build_target_failed`, `git_push_failed`, `http_smoke_failed`, `ui_scenario_failed`, `pipeline_stop`, `pipeline_stopped` |
| `logs/stages/<stage>/*` | 同上；或子进程 stderr 标记为失败的行 |
| `logs/features/<feature_id>/*` | 同上 |
| `logs/stages/ui_e2e/*-<scenario_id>.log` | 场景失败相关段落 |

**排除**：`DEBUG`、纯 `agent_heartbeat`、成功完成的 `agent_complete`（除非同 feature 另有失败行）。

**体积上限**：摘录文件总大小 **≤ 256 KiB**；超出时按时间倒序保留最新行，并在文件头注明 `truncated: true`。

### 3. Agent 撰写失败摘要（`has_errors=true` 时）

当存在失败/停止/阻断，且未 `--skip-agent`：

1. 调用 **Agent** + **`ai-std4/prompts/report-author.md`**。
2. **注入材料**（仅此三类，**禁止**传入完整 `stages.json` 或完整日志）：
   - **`collected` 的 JSON 摘要**（脚本预生成 `.pipeline/reports/.report-collect-<datetime>.json`，仅含 stages 状态表、failed_tasks、feature 矩阵、overall）
   - **`.pipeline/reports/.report-error-excerpt-<datetime>.txt`**（错误摘录）
   - **`--failure-reason=`**（若有）
3. Agent **产出**（写入 `.pipeline/reports/.report-agent-<datetime>.md`）：
   - **「失败与原因（人话）」**：按 stage 或 feature 分组；每条说明**发生了什么、可能原因、优先处理顺序**
   - **「建议的下一步」**：编号列表，每条含**可复制**的 `run-pipeline.cjs` CLI（与 [§4 卡点速查](../std4.md#4-agent-卡点速查) 一致）
4. 环境变量：`AI_STD4_REPORT_AGENT_OUTPUT`、 `AI_STD4_PROJECT`、`AI_STD4_SESSION_ID`。
5. Agent 超时：`timeouts.stages.report_agent_s`（默认 **300** 秒）→ 降级为脚本模板填充失败节（`agent_skipped`，`reason: report_agent_timeout`），**不**使 report stage 失败。

当 **`has_errors=false`**（全程成功或仅合法 skip）→ **跳过** Agent，由 `report-render` 直接写「无阻塞项」。

### 4. `report-render.cjs`（人话 Markdown）

输出主报告：

```text
<项目根>/.pipeline/reports/autorun-<datetime>-<session_id>.md
```

**全文用人话组织**（中文小标题 + 短句；表格列名中文或中英对照）。**禁止**写入密钥、完整鉴权头、超长 stderr（用「见日志路径」代替）。

**必须章节**（无数据写「（本次未涉及）」）：

```markdown
# 流水线执行报告 — <项目名>

> 生成于 <本地时间> · 会话 <session_id> · 执行批次 <datetime>

## 一句话结论

<overall 人话 + 主因一句>

## 这次跑了什么

- 项目路径、Git 远程、最终提交（若有）
- 覆盖端、feature 总数、当前分期（prd-review）
- 是否续跑（--from-stage）

## 各阶段完成情况

| 阶段 | 状态 | 耗时 | 说明 |
| … | 已完成 / 失败 / 已跳过 / 已停止 / 未执行 | … | 一句人话 |

## 已完成的事项

- （bullet：对用户有价值的结果，如 PRD 通过、N 个 feature 已合并、部署 URL、UI 场景通过数）

## 未完成或出错的事项

- （bullet：阶段或 feature 级；脚本 collected + Agent「失败与原因」合并）

## 功能（Feature）一览

| 功能 | 设计 | 评审 | 代码 | 代码评审 | UI 场景 | UI 测试 |
| … | ✓ / ✗ / — / … | … |

## 部署与访问地址

（deploy.services[]；deploy 内联 smoke 一行摘要）

## 构建产物

（build-summary 要点或 artifacts 表）

## UI 端到端（若启用）

（通过/失败数、失败场景 id、截图目录、ui-e2e 子报告链接）

## 相关日志与详细报告

| 类型 | 路径 |
| … | … |

## 建议的下一步

1. …（可复制 CLI）
```

渲染时将 **Agent 产出**的「失败与原因」「建议的下一步」**合并**进对应章节（Agent 节优先于脚本占位模板）。

### 5. 写回 `stages.report` 与 stdout

- `status=completed`（报告文件落盘即 completed，**即使** `overall=failed`）
- `outputs`：
  - `overall`：`success` | `partial` | `failed` | `blocked` | `stopped`
  - `report_path`：相对项目根
  - `summary`：一句话（与报告首段一致）
  - `next_steps[]`：字符串数组（来自 Agent 或规则模板）
  - `blockers[]`：`{ stage, feature_id?, reason }[]`
  - `feature_coverage`：`{ "<feature_id>": { design, codegen, ui_e2e, … } }`
  - `agent_report_path`：若调用了 Agent
  - `error_excerpt_path`：摘录文件路径
  - `teardown`：`{ invoked: true, killed_pids[], errors[] }`（由编排器写入，见 [流水线收尾](../std4.md#33-流水线收尾report-之后)）
- **stdout**（CI / 看板）：
  - `[report] overall=<overall> path=<report_path>`
  - `[report] pipeline_complete=true`（teardown 成功后）
- 日志：`stage_start` → `file_created`（report_path）→ 若 Agent：`agent_start` / `agent_complete` → `stage_complete`

### 6. 流水线收尾（由 `run-pipeline.cjs` 触发）

`report.cjs` **正常退出 0** 后，编排器**必须**调用 **`pipeline-teardown.cjs`**（除非 `--no-teardown`）。详见 [std4 §3.3](../std4.md#33-流水线收尾report-之后)。

> **report 是整条流水线的终点**：teardown 之后**不再**进入任何 stage，**不再**调度 design_phase / build_phase 的 `--tick`。

## overall 推导

**核心 stage**（与阶段链一致）：

```text
setup, prd, prd_review, design, design_review, create_ui_scenarios,
codegen, code_review, merge_push, build, deploy, ui_e2e
```

| 优先级 | 条件 | `overall` |
| ---: | --- | --- |
| 1 | `pipeline.stop_info` 或任一核心 stage `status=stopped` | `stopped` |
| 2 | `merge_push.outputs.conflict_features[]` 非空 | `blocked` |
| 3 | `deploy.outputs.decision=blocked` 或退出码 **9** 残留 | `blocked` |
| 4 | `--failure-reason=` 非空；或任一核心 stage `failed`；或 `completed` 且 `validation.passed=false` | `failed` |
| 5 | `ui_e2e.enabled=true` 且 ui_e2e `status ∉ {completed, skipped, failed}`（即 `running` / `pending` / 未启动）；或多个核心 stage `skipped` 但下游仍有 `failed` | `partial` |
| 6 | 全部核心 stage ∈ `{completed, skipped}` 且无失败 | `success` |
| 7 | 其余 | `partial` |

> `report` 脚本自身异常 → 退出码 **1**；**不**改变业务 `overall`（编排器可写 `failure-reason=report_failed` 后仍尝试 teardown）。

## 任务归类规则

脚本根据 `stages.*` 与摘录生成 **`completed_tasks[]` / `failed_tasks[]` / `skipped_tasks[]`**（人话字符串，供 Agent 与 render 共用）：

| 类型 | 示例条目 |
| --- | --- |
| **completed** | 「PRD 评审通过，当前分期 Phase 1，共 12 个 feature」；「已合并至 main，提交 `abc1234`」；「website 已部署：https://…」；「UI 场景 8/8 通过」 |
| **failed** | 「【codegen · NOTE-001】第 2 次 resume 后仍失败：类型检查未通过」；「【deploy】Cloudflare API 403，见 deploy-summary」；「【ui_e2e · NOTE-002-smoke-001】步骤 click 失败」 |
| **skipped** | 「ui_e2e 未启用」；「create-ui-scenarios：backend-only feature NOTE-API-003」；「build：backend 标 not_applicable」 |

**失败任务**须附带 **`log_hint`**（相对路径），供报告内链到摘录或 stage 日志。

## 日志事件（report）

| event | LEVEL | 关键 meta |
| --- | --- | --- |
| `stage_start` | INFO | `stage`, `run_id`, `session_id`, `datetime`, `has_errors` |
| `file_created` | INFO | `path`（error excerpt / collect json / autorun md） |
| `agent_start` | INFO | `agent_id: "report-author"`, `prompt`, `excerpt_bytes` |
| `agent_complete` | INFO | `agent_id`, `duration_ms`, `output_files[]` |
| `agent_skipped` | INFO | `reason`（无错误 / skip-agent / timeout） |
| `file_created` | INFO | `path`（autorun 主报告）, `overall`, `size_bytes` |
| `pipeline_teardown_start` | INFO | `session_id`, `targets[]`（子进程类型） |
| `pipeline_teardown_complete` | INFO | `killed_count`, `duration_ms` |
| `stage_complete` | INFO | `overall`, `duration_ms`, `failed_tasks_count` |
| `stage_failed` | ERROR | 仅 report 脚本自身异常 |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/reports/autorun-<datetime>-<session_id>.md` | **人话总报告**（主交付物） |
| `.pipeline/reports/.report-error-excerpt-<datetime>.txt` | 错误日志摘录（内部 + Agent 输入） |
| `.pipeline/reports/.report-collect-<datetime>.json` | 聚合摘要（Agent 输入，可保留排障） |
| `.pipeline/reports/.report-agent-<datetime>.md` | Agent 撰写的失败/建议章节（并入主报告） |
| `output-stages/stages.json` | `stages.report.outputs.*` |
| stdout | `overall`、`report_path`、`pipeline_complete=true` |

## 退出码

| 码 | 含义 |
| ---: | --- |
| **0** | 主报告已生成（**无论** `overall`）；teardown 由编排器单独处理，teardown 失败**不**改 report 退出码 |
| **1** | `stages.json` 缺失、写盘失败、collect 异常 |

> 业务失败时 report 仍返回 **0**，以便 CI 归档报告；编排器根据 `stages.report.outputs.overall` 决定进程退出码（见 [std4 §3.3](../std4.md#33-流水线收尾report-之后)）。

## 解锁

无下游 stage。用户、看板、`run-dash` 以 **`outputs.report_path`** 与 **`outputs.overall`** 为本次执行最终展示入口；**teardown 完成后**流水线会话结束。

---
