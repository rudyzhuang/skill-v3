# create-ui-scenarios 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [design 复合编排](../std3.md#31-design--design-review-复合编排) · [codegen 并行编排](../std3.md#32-codegen--create-ui-scenarios-并行编排) · [卡点速查](../std3.md#4-agent-卡点速查)

> 按 **feature** 派发 Agent，从 `design.json` 的 `acceptance[]` / `api_outline[]` / `client_target` 派生**可执行的 UI 测试用例 YAML**，供 [ui_e2e](ui_e2e.md) 消费。
>
> **与 codegen 并行**：本 stage **不**是 codegen 的硬前置；design-review 释放某 group 后，组内 feature **同时**进入 codegen 与 create-ui-scenarios **两条独立 track**；只要在 `ui_e2e` 启动前就绪即可（见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)）。

## 脚本

路径前缀 **`ai-std3/scripts/lib/`**：`create-ui-scenarios.cjs`、`create-ui-scenarios-bootstrap.cjs`、`create-ui-scenarios-validate.cjs`；步骤 2 为按 **feature** 并发的 Agent 池；与 `codegen.cjs` 复合编排时支持 **`--tick`**。

```bash
node ai-std3/scripts/lib/create-ui-scenarios.cjs --project=<业务项目根绝对路径> [--tick] [--feature=<feature_id>]
```

> **不**评审、**不**改写 `design.json` / `docs/contracts/`；只产出 `docs/ui-scenarios/<feature_id>.scenarios.yaml`。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.design_review.outputs.can_enter_codegen=true`（任一 group 已 release，与 codegen 同级） |
| **单 feature 入队** | `stages.design_review.features.<feature_id>.can_enter_codegen=true` 且 `docs/designs/<feature_id>.design.json` 存在并 Ajv 通过 |

> 与 codegen 共用同一组 feature 级释放条件；**不**互相阻塞。
>
> **下游对本 stage 的依赖**：仅 `ui_e2e` 真正消费 `docs/ui-scenarios/<feature_id>.scenarios.yaml`；`codegen` Agent 可选读以理解验收边界，但**不**作硬门闸。详见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)。

## 并发配置（feature 级线程池）

模型与 `design` / `design-review` / `codegen` 完全一致，并发度取自业务项目 **`docs/config.dev.json`**：

```
effective_parallel = min(
  pipeline.stages.create_ui_scenarios.feature_max_parallel,
  pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.create_ui_scenarios.feature_max_parallel` | `3` | 本 stage 同时运行的 Agent 上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | **全局天花板**（design / design-review / codegen / create-ui-scenarios 等凡按 feature 并发的 stage 均不得超过此值） |
| `timeouts.stages.create_ui_scenarios_s` | `600` | 单 feature Agent 超时（秒），超时记该 feature `failed` |

配置示例：

```json
{
  "pipeline": {
    "stages": {
      "create_ui_scenarios": {
        "feature_max_parallel": 3
      }
    }
  },
  "timeouts": {
    "stages": {
      "create_ui_scenarios_s": 600
    }
  }
}
```

> 实现要求：固定大小 Worker 池，**禁止**按 feature 无限制起线程。Agent **仅依赖 design.json 已就绪**（feature 级），与 codegen Agent **可同时进行**，合计占用须遵守 `pipeline.autorun.feature_max_parallel` 全局限额。组内若槽位不足，按 `dependency_groups[].topo_order` **优先生成依赖端 feature** 的场景（与 design / design-review 一致，便于报告关联）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.design.outputs.design_specs[]` | 已就绪的 feature 列表（与 `stages.design.features.<id>.status=completed` 一致） |
| `stages.design_review.outputs.released_groups[]` | 已 release 的 group / `features.<id>.can_enter_codegen` |
| `stages.prd.outputs.features[]` | feature 元数据（`client_targets`、优先级，与 `design.json.client_targets` 交叉校验） |
| `<业务项目根绝对路径>/docs/designs/<feature_id>.design.json` | 场景派生**唯一**真源（`acceptance[]` / `api_outline[]` / `client_target` / `client_targets[]`） |
| `<业务项目根绝对路径>/docs/config.dev.json` | `ui_e2e.enabled`、`deploy.services.*.url`（`{base_url}` 占位真源）、并发上限、`timeouts.stages.create_ui_scenarios_s` |

**CLI 过滤**：`--feature=<feature_id>` 仅处理单个 feature（用于失败后重跑）；仍遵守上游门闸。

**`ui_e2e.enabled=false` 时的行为**：bootstrap 直接 `status=skipped`、`reason="ui_e2e.enabled=false"`、退出码 0，**不**派发 Agent，**不**阻塞 codegen 链路。

## 处理逻辑

1. **`create-ui-scenarios-bootstrap.cjs`（bootstrap + 跳过/降级）**：
   - 初始化 `stages.create_ui_scenarios` 骨架（若不存在），含 `features.<feature_id>.{status, group_id, scenarios_hash, design_hash, scenarios_count}`、`outputs.scenario_files[]`、`outputs.skipped_features[]`、`outputs.released_groups_seen[]`、`outputs.decision=pending`。
   - 若 `docs/config.dev.json.ui_e2e.enabled=false` → 写 `status=skipped`，`outputs.summary="ui_e2e disabled"`，退出 0。
   - 计算 `release_bundle_hash`（**当前** `features.<id>.can_enter_codegen=true` 的 feature_id 排序后拼接 SHA-256）与 `design_bundle_hash`（当前已就绪 feature 的 `design.json` 按 `feature_id` 排序拼接 SHA-256）。
   - 与 `stages.create_ui_scenarios.inputs.release_bundle_hash` / `inputs.design_bundle_hash` 对比；若 hash 命中且全部目标 feature 已 `status=completed` → 整体跳过步骤 2，直接进入步骤 3（`stage_skipped`）。否则按 feature 增量调度（hash 命中且上次 `completed` 的单 feature 跳过 Agent）。
   - **确定性预检**（不调用 Agent，命中则该 feature `blocking`，**不**入池）：
     - `design.json.acceptance.length < 1` → `blocking`（无验收点无法生成场景）；
     - `design.json.client_target` ∉ `{website, admin, mobile, ios, android, backend}` 且 `client_targets[]` 无前端类目 → 标 `skipped`（`reason="non-UI client_target"`，写入 `outputs.skipped_features[]`，**不**派发 Agent）；
     - `design.json.client_target ∈ {backend}` 且 `client_targets[]` 内无任何 `{website, admin, mobile, ios, android}` → 同上 `skipped`（纯后端 feature 无需 UI 场景）。
   - 写 `stages.create_ui_scenarios.status=running`；日志记录 `effective_parallel`、`pending_feature_ids[]`、`skipped_feature_ids[]`。

2. **Agent-CreateUIScenarios（按 feature 并发，组感知）**：
   - 每轮 `--tick` 从「`design_review.features.<id>.can_enter_codegen=true` 且 `create_ui_scenarios.features.<id>` 未 `completed`/`failed`/`skipped`」集合中取就绪 feature（**确定性预检通过**）入池。
   - 按 `effective_parallel` 与全局限额并发启动 Agent；每个 Agent **仅生成一个 feature** 的 `docs/ui-scenarios/<feature_id>.scenarios.yaml`，按 **`ai-std3/prompts/create-ui-scenarios.md`** 执行（**不得**修改 `design.json`，**不得**写其它路径）。
   - 单 feature 落盘后：脚本立即 Ajv 校验 `ui-scenarios.yaml.schema.json`；通过 → 写 `features.<feature_id>.{status: completed, scenarios_hash, scenarios_count, design_hash}` 与 `outputs.scenario_files[]`；打事件 `feature_scenarios_ready`（`meta.feature_id`、`meta.group_id`、`meta.scenarios_count`）。
   - **`--tick` 模式**（与 codegen 并行编排默认）：调度一轮后写回 `stages.json` 并退出 **0**；编排器与 `codegen --tick` 交替调用（见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)）直至全部目标 feature `completed` / `failed` / `skipped`。
   - **批量模式**（单独 `--from-stage=create-ui-scenarios`）：循环 `--tick` 直至无在途 Agent 且无待调度 feature，再进入步骤 3。

   **单 feature 输入**（每次 Agent 调用仅读下列文件）：
   - `<业务项目根绝对路径>/docs/designs/<feature_id>.design.json`
   - 该 feature 在 `stages.prd.outputs.features[]` 中的元数据（`client_targets[]` 与 `name`）
   - `<业务项目根绝对路径>/docs/config.dev.json`（仅取 `deploy.services.*.url` 用于在示例中渲染 `{base_url}` 占位提示；Agent **不得**硬编码真实 URL）

   **单 feature 产出 YAML**（须满足 `docs/spec/std3/schemas/ui-scenarios.yaml.schema.json`）：

   ```yaml
   feature_id: NOTE-CRUD-001
   client_target: website            # website | admin | mobile（与 design.json.client_target 一致或属 client_targets[]）
   scenarios:
     - id: NOTE-CRUD-001-smoke-001   # 必须以 <feature_id>- 前缀；全局唯一
       title: 列表页可访问
       platform: web                  # web | android | ios
       steps:
         - action: navigate
           url: "{base_url}/"
         - action: snapshot
       expect:
         - type: text_present
           value: "笔记"              # 关键词从 acceptance[] 提取，禁止硬编码业务无关字符串
     - id: NOTE-CRUD-001-form-submit-001
       title: 创建笔记表单提交
       platform: web
       steps:
         - action: navigate
           url: "{base_url}/notes/new"
         - action: type
           selector_hint: "title 输入框"
           value: "示例标题"
         - action: click
           selector_hint: "提交按钮"
       expect:
         - type: url_contains
           value: "/notes/"
         - type: text_present
           value: "示例标题"
   ```

   **Agent 硬约束**：
   - **平台映射**：`web` 只能搭配 `website` / `admin`；`android` / `ios` 只能搭配 `mobile`；不允许跨端混搭。
   - **场景 ID 规则**：`<feature_id>-<kind>-<NNN>`（如 `-smoke-001`、`-form-submit-001`），全局唯一，正则 `^[A-Z][A-Z0-9-]*-[0-9]{3}$`。
   - **覆盖度**：每个 feature **至少** 1 条 `smoke` 场景 + 每条 `acceptance[]` 至少 1 条对应场景（最多上限 `pipeline.stages.create_ui_scenarios.max_scenarios_per_feature`，默认 `10`，超出由脚本截断并 `agent_retry`）。
   - **`expect[]`**：每个场景 **≥ 1** 条；web 场景必须至少含 `text_present` 或 `url_contains` 之一（**禁止**只检查 HTTP 状态码）。
   - **`expect.value`**：优先从 `design.json.acceptance[]` 中提取**可观测中文/英文关键词**；Agent 不得编造业务文案。
   - **占位符**：URL 仅可用 `{base_url}`、`{test_user}`、`{test_password}`；**禁止**硬编码真实域名/IP。
   - **`steps[].action`** 限定枚举：`navigate` / `click` / `type` / `select` / `hover` / `snapshot` / `wait` / `back`；不可发明新动作。
   - **`selector_hint`**：用人话描述目标元素（如"提交按钮"、"标题输入框"），由 `ui_e2e` 阶段 Browser MCP / Dart MCP 自行解析；**禁止**写 XPath / CSS 选择器（避免脆性）。
   - **禁止**：改写 `design.json`、写其它路径、调用网络/MCP（生成阶段为纯文本派生）。

   > **稳定性保障**：
   >
   > | 机制 | 说明 |
   > | --- | --- |
   > | **按 feature 哈希门控** | 若 `docs/ui-scenarios/<feature_id>.scenarios.yaml` 存在且 SHA-256 等于 `stages.create_ui_scenarios.features.<id>.scenarios_hash`，且对应 `design.json.SHA-256 == features.<id>.design_hash`，则**跳过该 feature Agent**（`agent_skipped`） |
   > | **Schema 强校验 + 重试** | 产出后立即 YAML 解析 + Ajv 校验；失败则重试该 feature Agent，**最多 2 次**（`agent_retry`，meta 含 `invalid_fields[]`） |
   > | **确定性 gap 保留** | bootstrap 写入的 `skipped` / `blocking` 不因 Agent 产出被覆盖 |
   > | **超时单 feature 失败** | 单 feature Agent 超过 `timeouts.stages.create_ui_scenarios_s` → `agent_failed`、`timed_out:true`；**不**影响其它 feature 与 codegen track |

3. **`create-ui-scenarios-validate.cjs`（merge + finalize）**：
   - 遍历目标 feature_ids（=已 release 且未 skip 的集合）：YAML 存在、Ajv 通过、`feature_id` 与文件名一致、`scenarios[].id` 全局唯一、平台与 `client_target` 匹配。
   - 汇总 `outputs.scenario_files[]`：`{ feature_id, group_id, path, scenarios_count, scenarios_hash }`；`outputs.skipped_features[]`：`{ feature_id, reason }`。
   - 计算 `outputs.coverage`：`{ total_features, scenarios_generated, scenarios_skipped, acceptance_covered_ratio }`。
   - **门闸（两级）**：
     - **feature 级**：YAML 不合规或 Agent 重试仍失败 → `features.<id>.status=failed`；该 feature **不**阻断 codegen（已并行进行）；但其 `ui_e2e` 阶段会 `skipped`（无场景文件可消费），并由 [report](report.md) 标记 `ui_coverage_warning`。
     - **stage 级**：全部 release 中的 feature 已 `completed` / `skipped` / `failed`（无 `pending`/`running`）→ `status=completed`（即使部分 `failed`）；若全部 release 中的 feature 都 `failed` → `status=failed`、退出码 **4**。
   - 写 `inputs.release_bundle_hash`、`inputs.design_bundle_hash`、`outputs.decision`（`passed` / `partial` / `failed`）、`validation.passed`。
   - 生成 `.pipeline/reports/create-ui-scenarios-summary.md`（每 feature 一行：场景数、覆盖率、是否跳过）。
   - 失败时：`--from-stage=create-ui-scenarios --feature=<id>` 重生该 feature；或修 `design.json.acceptance` 后回到 `design`。

## 日志事件

> 步骤 2 按 feature 并发：每轮调度打 `agent_batch_start` / `agent_batch_complete`；每个 feature 独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`，`meta.feature_id` 必填。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间）, `parallel_with: ["codegen"]` |
| 步骤1：初始化 | `file_created` / `file_skipped` | INFO | `path`（stages.create_ui_scenarios） |
| 步骤1：禁用跳过 | `stage_skipped` | INFO | `reason: "ui_e2e disabled"`, `exit_code: 0` |
| 步骤1：确定性预检 | `validation_pass` / `validation_fail` | INFO/ERROR | `pending_feature_ids[]`, `skipped_feature_ids[]`, `blocking_feature_ids[]` |
| 步骤1：bundle 哈希 | `hash_check` | INFO | `release_bundle_hash`, `design_bundle_hash`, `stored_hash`, `computed_hash`, `hit` |
| 步骤1：整体跳过 Agent | `stage_skipped` | INFO | `reason: "release_bundle_hash matched, all scenarios fresh"` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `effective_parallel` |
| 步骤2：单 feature 就绪 | `feature_scenarios_ready` | INFO | `feature_id`, `group_id`, `scenarios_count`, `scenarios_hash` |
| 步骤2：批次开始 | `agent_batch_start` | INFO | `batch_id: "create-ui-scenarios-tick-<n>"`, `feature_ids[]`, `agents_total`, `agents_skipped[]`, `effective_parallel` |
| 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "create-ui-scenarios-agent-<feature_id>"`, `feature_id`, `prompt: "create-ui-scenarios.md"`, `input_files: ["designs/<feature_id>.design.json"]`, `client_target` |
| 步骤2：单 feature 跳过（hash 命中） | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "scenarios_hash + design_hash matched"` |
| 步骤2：单 feature 跳过（非 UI feature） | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "non-UI client_target"` |
| 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
| 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `scenarios_count`, `output_files: ["ui-scenarios/<feature_id>.scenarios.yaml"]` |
| 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 4`, `reason`, `timed_out`（bool） |
| 步骤2：批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：合并 | `file_updated` | INFO | `scenario_files_count`, `scenarios_total`, `skipped_features_count`, `failed_features_count` |
| 步骤3：门闸未通过 | `validation_fail` | ERROR | `decision: "failed"`, `failed_feature_ids[]`, `exit_code: 4` |
| 步骤3：门闸通过 | `validation_pass` | INFO | `decision: "passed" \| "partial"`, `coverage` |
| 步骤3：写完成态 | `file_updated` | INFO | `status: "completed"`, `release_bundle_hash` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `features_total`, `scenarios_total` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_feature_id`（若有） |

## 退出码（本 stage）

| 码 | 场景 |
| ---: | --- |
| 0 | 成功；`ui_e2e.enabled=false` 整段 `skipped`；hash 跳过 |
| 1 | 上游门闸未满足 |
| 3 | 单 feature Agent 超时 |
| 4 | 全部 release feature 均 `failed` 或校验失败 |
| 5 | 检测到 `stop.signal` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | 可执行 UI 场景（每 feature 一文件），`ui_e2e` 阶段直接消费 |
| `.pipeline/stages.json` | `stages.create_ui_scenarios`：`features.<id>`（含 `group_id` / `scenarios_hash`）、`outputs.scenario_files[]`、`outputs.skipped_features[]`、`outputs.coverage`、`validation.passed` |
| `.pipeline/reports/create-ui-scenarios-summary.md` | 每 feature 一行人话摘要（场景数、覆盖率、跳过原因） |

## 解锁

| 粒度 | 条件 | 效果 |
| --- | --- | --- |
| **feature → ui_e2e** | `stages.create_ui_scenarios.features.<id>.status=completed` 且对应 YAML Ajv 通过 | 该 feature 进入 ui_e2e 队列（若 `ui_e2e.enabled=true`） |
| **stage 完成** | 已 release 的全部 feature 已 `completed` / `skipped` / `failed`（无在途） | `stages.create_ui_scenarios.status=completed`（即使部分 `failed`，整体仍 `partial`） |
| **与 codegen 关系** | **无相互门闸**（见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)） | 同 group 内 feature 同时进入 codegen 与 create-ui-scenarios；codegen 完成不等待场景，反之亦然 |
| **与 smoke/ui_e2e 关系** | `ui_e2e` 启动前必须 **本 stage 已 `completed` 或 `skipped`** | 由 `run-pipeline.cjs` 在进入 `ui_e2e` 前确认（属编排级 join），与场景 hash 一并校验 |

---
