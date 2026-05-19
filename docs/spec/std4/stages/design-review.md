# design-review 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [design 复合编排](../std4.md#31-design--design-review-复合编排) · [卡点速查](../std4.md#4-agent-卡点速查)

> **AI 自动评审** design 阶段产出（**不使用**契约五件套）。各 feature Agent 产出评审 JSON，脚本做确定性检查 + **feature 级**合并；**组（dependency group）内全部 feature 通过后整组放行**下游。与 design **流水线并行**：不必等 `stages.design.status=completed`。

## 脚本

脚本根目录前缀 **`ai-std4/scripts/`**：`stages/design-review.cjs`（编排入口）、`libs/design-review-bootstrap.cjs`、`libs/design-review-validate.cjs`；步骤 2 为按 **feature** 并发的 Agent 池；复合编排时支持 **`--tick`**。

```bash
node ai-std4/scripts/stages/design-review.cjs --project=<业务项目根绝对路径> [--tick] [--feature=<feature_id>]
```

> **注意**：直接评审 `design.json` 与 PRD 对齐；**不**评审、**不**修改 `docs/contracts/` 五件套。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.prd_review.status=completed` 且 `outputs.decision=passed` 且 `validation.passed=true`；`stages.design.inputs.dependency_groups[]` 已存在（design bootstrap 已跑） |
| **单 feature 入队评审** | `stages.design.features.<feature_id>.status=completed` 且 `output-stages/design/<feature_id>.design.json` 存在；**不要求** `stages.design.status=completed` |
| **组内评审完整性** | 组内某 feature 已 `completed` 时可先评；**组级放行**须组内**每个** feature 均已 `design_review.features.<id>.decision=passed` 且无 blocking gap |

`dependency_groups[]` 定义与 [design 依赖组](design.md#依赖组dependency-group) 相同（读 `stages.design.inputs.dependency_groups[]`）。

## 并发配置（feature 级线程池）

与 `design` stage 相同模型，并发度取自 **`docs/config.dev.json`**：

```
effective_parallel = min(
pipeline.stages.design_review.feature_max_parallel,
pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.design_review.feature_max_parallel` | `3` | 本 stage 同时运行的 design-review Agent 上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | 全局天花板（与 design / codegen 共用） |
| `timeouts.stages.design_review_s` | `900` | 单 feature 评审 Agent 超时（秒） |

配置示例：

```json
{
"pipeline": {
"stages": {
"design_review": {
"feature_max_parallel": 3
}
}
},
"timeouts": {
"stages": {
"design_review_s": 900
}
}
}
```

> 实现要求：固定大小 Worker 池，**禁止**按 feature 无限制起线程。评审 Agent **仅依赖 design.json 已就绪**（feature 级），与 design Agent **可同时进行**（合计占用须遵守 `pipeline.autorun.feature_max_parallel` 全局限额，见 [复合编排](../std4.md#31-design--design-review-复合编排)）。组内若槽位不足，**优先评审 `topo_order` 靠前的 feature（依赖端）**。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.design.outputs.design_specs[]` | 待评审 feature 列表（与 `stages.design.features` 完成态一致） |
| `stages.prd_review.review.phase_plan[]` | 分期目标 / `exit_criteria`（Agent 对齐用） |
| `stages.prd.outputs.features[]` | feature 元数据（`client_targets`、优先级） |
| `<业务项目根绝对路径>/output-stages/design/<feature_id>.design.json` | 评审对象 |
| `<业务项目根绝对路径>/output-stages/prd/prd-spec.md` | 需求总源头 |
| 各端 PRD 内容文件 | 按 feature 涉及端加载；路径见 [prd § 映射](prd.md#client_target--文件与模板映射) |
| `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、`timeouts.stages.design_review_s` |

**CLI 过滤**：`--feature=<feature_id>` 仅重评单个 feature。

## 处理逻辑

1. **`design-review-bootstrap.cjs`（bootstrap + 确定性预检）**：
- 从 `stages.design.inputs.feature_ids[]` 收集全集。
- **先读旧值**：读取 `stages.design_review.inputs.design_bundle_hash`（骨架不存在则为 `null`）与 `stages.design_review.inputs.phase_plan_hash`。
- **计算新值**：`design_bundle_hash_new`（当前所有 `stages.design.features.<id>.status=completed` 的 feature，按 `feature_id` 字典序排列各自 `output-stages/design/<id>.design.json` 的 SHA-256，再对该列表做 `JSON.stringify + SHA-256`，即 hash-of-hashes 方式；随 design 增量完成而更新）；`phase_plan_hash_new`（同 design stage 算法）。
- **hash 门控（全段跳过）**：若 `design_bundle_hash_new == 旧值` **且** `stages.design_review.status=completed` **且** `outputs.decision=passed` **且** 全部 `released_groups[]` 覆盖全部 `dependency_groups[]`，则**整段跳过**（写 `stage_skipped` + 退出码 0，不修改 stages.design_review）。
- **骨架处理 + 写入新值**（非跳过路径）：
  - 若骨架**不存在**：初始化 `stages.design_review`，含 `inputs.design_bundle_hash = design_bundle_hash_new`、`inputs.phase_plan_hash = phase_plan_hash_new`、`features.<feature_id>.status = pending_review`、`features.<feature_id>.group_id`、`features.<feature_id>.can_enter_codegen = false`、`outputs.gaps[]`、`outputs.released_groups[]`、`outputs.decision = pending`。
  - 若骨架**已存在**：将任何状态为 `running` 的 feature 重置为 `pending_review`（zombie 恢复）；若 `design_bundle_hash` 变化（design 重跑新增 feature），将新增 feature 的 `features.<id>` 初始化为 `pending_review`；写入新 hash 值。
- **确定性预检**（仅对 `stages.design.features.<id>.status=completed` 且 `design_review.features.<id>.status∈{pending_review,failed}` 的 feature，不调用 Agent，直接写入 `gaps[]`）：
  - `acceptance.length < 3` → `blocking`；
  - `dependencies[]` 中 id 不在本期 `feature_ids[]` → `blocking`；
  - 跨 feature **modify_files** 路径冲突（同一文件被多个 feature 修改）→ `warning`（可配置升级为 `blocking`）；
  - `file_plan.new_files` 与 `modify_files` 路径重叠 → 该 feature `blocking`。
- 写 `stages.design_review.status=running`；步骤 2 按 feature 增量评审（hash 命中且上次 `decision=passed` 的跳过 Agent）。

2. **Agent-Review（按 feature 并发，与 design 流水线并行）**：
- 每轮 `--tick` 从「`design.features.<id>.status=completed` 且 `design_review.features.<id>` 未 `passed`/`failed`」集合中取就绪 feature，**无 blocking 确定性 gap** 者入队。
- 按 `effective_parallel` 与全局限额并发启动 Agent；每个 Agent **仅评审一个 feature**，按 **`ai-std4/prompts/design-review.md`** 执行，产出 **`.pipeline/design-review-<feature_id>.json`**（**不得**直接修改 `design.json`）。
- 单 feature 评审落盘后：写 `features.<feature_id>.decision`、`design_hash`；打 `feature_review_complete`。
- **组级放行（group release）**：对每个 `dependency_groups[]` 条目，若组内**全部** feature 均已 `decision=passed` 且该 `group_id` 尚未在 `outputs.released_groups[]` 中：
  - 将组内每个 `features.<id>.can_enter_codegen=true`；
  - 追加 `outputs.released_groups[]`：`{ group_id, feature_ids[], released_at, design_hashes[] }`；
  - 打事件 `group_released`（`meta.group_id`, `meta.feature_ids[]`）；
  - 若 `outputs.can_enter_codegen` 仍为 `false`，置为 `true`（表示**至少一组**已可进入下游；具体 feature 以 `features.<id>.can_enter_codegen` 为准）。
- **`--tick` 模式**：调度一轮后写回并退出 **0**；批量模式由编排器循环直至全部 feature 已评审且全部 group 已 release 或失败。

**单 feature 产出 JSON**（须满足 `design-review-feature-output.schema.json`）：

```json
{
  "feature_id": "NOTE-CRUD-001",
  "outputs": {
    "decision": "passed",
    "alignment_summary": "design 与 prd-spec、各端 prd 对齐，可实现。"
  },
  "gaps": [
    {
      "field": "api_outline",
      "category": "prd_alignment",
      "severity": "warning",
      "message": "POST /api/notes 未在 backend prd 的 endpoints 中声明"
    }
  ]
}
```

**Agent 硬约束**：
- 评审维度：**完整性**（`file_plan` / `acceptance` / `api_outline`）、**可实现性**、**与 PRD 对齐**（`prd-spec` + 所涉 `prd-<client_target>.json`）、**跨端一致性**（`client_targets[]`）。
- `outputs.decision`：`passed` | `failed` | `needs_design_fix`（**无** `needs_contract_fix`，std4 不使用契约五件套）。
- `passed` 时：无 `severity=blocking` 的 gap（`warning` 允许）。
- `failed` / `needs_design_fix`：须含至少一条 `blocking` gap 或明确 `message`。
- **禁止**：改写 `design.json`；缺口只写入 JSON 的 `gaps[]`。

> **稳定性保障**：
>
> | 机制 | 说明 |
> | --- | --- |
> | **按 feature 哈希门控** | 若该 feature 的 `design.json` 哈希与 `stages.design_review.features.<id>.design_hash` 一致且上次评审 `decision=passed`，则**跳过该 feature Agent** |
> | **Schema 强校验 + 重试** | 产出后 Ajv 校验；失败重试该 feature，**最多 2 次** |
> | **确定性 gap 保留** | bootstrap 写入的 blocking gap 不因 Agent `passed` 被覆盖 |

3. **`design-review-validate.cjs`（merge + finalize）**：
- 读取已有 `.pipeline/design-review-<feature_id>.json`（被跳过的 feature 沿用上次结果或仅含确定性 gap）。
- 合并 `outputs.gaps[]`（附 `feature_id`）与逐 feature `decision`；刷新 `released_groups[]` / `features.<id>.can_enter_codegen`（与步骤 2 组级放行规则一致）。
- **门闸（两级）**：
  - **feature 级**：含 `blocking` gap 或 `decision∈{failed,needs_design_fix}` → 该 feature `can_enter_codegen=false`；若属某 group，**整组**不得新增 release（已 release 的组若后验失败，写 `group_revoked` 日志，下游由编排器停止该组在途任务）。
  - **stage 级**：全部 `feature_ids[]` 已评审且 `outputs.released_groups[]` 覆盖全部 `dependency_groups[]` → `status=completed`、`outputs.decision=passed`、`validation.passed=true`；若仍有 feature 未 `passed` 且无在途 design/review（无法自动继续）→ `status=failed`、`decision=needs_fix`，退出码 **4**。
- `outputs.can_enter_codegen`：任一 group 已 release 即为 `true`（兼容下游 stage 启动条件）；**执行具体 feature 任务**时下游须检查 `features.<id>.can_enter_codegen`（见 [§3.1 复合编排](../std4.md#31-design--design-review-复合编排)）。
- 写 `outputs.blocking_count`、`outputs.warning_count`（`inputs.design_bundle_hash` / `phase_plan_hash` 已由 bootstrap 写入，此处无需重算）。
- 生成 `.pipeline/reports/design-review-summary.md`（含已 release / 待 release 的 group 表）。
- 失败时：`needs_design_fix` → `--from-stage=design --feature=`；仅评审 → `--from-stage=design-review --feature=`。

## 日志事件（design-review）

> 步骤 2 按 feature 并发：每轮调度打 `agent_batch_start` / `agent_batch_complete`；每个 feature 独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`，`meta.feature_id` 必填。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 步骤1：初始化/更新 | `file_created` / `file_updated` | INFO | `path`（stages.design_review），`zombie_features_reset`（list），`new_features_added`（list） |
| 步骤1：确定性预检 | `validation_pass` / `validation_fail` | INFO/ERROR | `feature_ids[]`, `deterministic_blocking_count`, `deterministic_warning_count` |
| 步骤1：bundle 哈希 | `hash_check` | INFO | `design_bundle_hash`, `stored_hash`, `computed_hash`, `hit` |
| 步骤1：整体跳过 Agent | `stage_skipped` | INFO | `reason: "design_bundle_hash matched, decision=passed"` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `effective_parallel` |
| 步骤2：组放行 | `group_released` | INFO | `group_id`, `feature_ids[]`, `released_groups_count` |
| 步骤2/3：组撤销 | `group_revoked` | WARN | `group_id`, `reason`（如 `blocking_gap_found`）, `downstream_tasks_stopped`（bool） |
| 步骤2：单 feature 评审完 | `feature_review_complete` | INFO | `feature_id`, `group_id`, `decision`, `group_all_passed`（bool） |
| 步骤2：批次开始 | `agent_batch_start` | INFO | `batch_id: "design-review-tick-<n>"`, `feature_ids[]`, `agents_total`, `agents_skipped[]`, `effective_parallel` |
| 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "design-review-agent-<feature_id>"`, `feature_id`, `prompt: "design-review.md"`, `input_files: ["designs/<feature_id>.design.json","prd-spec.md",...]` |
| 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "design_hash matched, prior passed"` |
| 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
| 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `decision`, `gaps_blocking`, `gaps_warning`, `output_files: ["design-review-<feature_id>.json"]` |
| 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 4`, `reason`, `timed_out` |
| 步骤2：批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：合并 | `file_updated` | INFO | `gaps_total`, `blocking_count`, `warning_count`, `per_feature_decisions` |
| 步骤3：门闸未通过 | `validation_fail` | ERROR | `decision: "needs_fix"`, `blocking_feature_ids[]`, `exit_code: 4` |
| 步骤3：门闸通过 | `validation_pass` | INFO | `decision: "passed"`, `can_enter_codegen: true` |
| 步骤3：写完成态 | `file_updated` | INFO | `status: "completed"`, `design_bundle_hash` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `decision`, `features_reviewed` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_feature_id` |

## 退出码（本 stage）

| 码 | 场景 | stages.design_review.status |
| ---: | --- | --- |
| 0 | 成功（批量）或 `--tick` 单轮完成 | `completed` / `running` |
| 0 | 全局 hash 命中整段跳过 | `completed`（不变） |
| 1 | 上游门闸未满足、缺少 `dependency_groups[]` | `failed` |
| 3 | 单 feature 评审 Agent 超时 | feature 级 `failed`；stage 级视全局 |
| 4 | blocking gap / `decision=needs_fix` / 组未全部 release | `failed` |
| 5 | 检测到 `stop.signal` | `stopped` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/design-review-<feature_id>.json` | 各 feature Agent 评审产出 |
| `.pipeline/stages.json` | `stages.design_review`：`outputs.released_groups[]`、`outputs.can_enter_codegen`、`features.<id>.can_enter_codegen`、`outputs.gaps[]` |
| `.pipeline/reports/design-review-summary.md` | 可选人话摘要（含 group 放行表） |

## 解锁

| 粒度 | 条件 | 效果 |
| --- | --- | --- |
| **group → 下游** | 组内全部 feature `decision=passed` 且无 blocking gap | `released_groups[]` 追加该组；组内所有 `features.<id>.can_enter_codegen=true`；`run-pipeline` 按 [§3.1](../std4.md#31-design--design-review-复合编排) 为该组 feature 同时启动 `codegen` 与 `create-ui-scenarios` **两条并行 track**（见 [§3.2 并行编排](../std4.md#32-codegen--create-ui-scenarios-并行编排)），组内多线程，两 track 之间无相互门闸 |
| **stage 完成** | 全部 group 已 release 且 `feature_ids[]` 均已评审 | `stages.design_review.status=completed`、`validation.passed=true` |
| **兼容门闸** | `outputs.can_enter_codegen=true` | 允许下游 stage **脚本启动**；实际处理范围以 `features.<id>.can_enter_codegen` 过滤 |

---
