# prd-review 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [编排映射](../std4.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std4.md#4-agent-卡点速查)

> **AI 自动评审**（不设单独人工签审节点）。各端 Agent 独立产出 per-target JSON，脚本合并为全局 `prd-review-output.json` 并校验门闸后写入 `stages.prd_review`；人话结论写入 `.pipeline/reports/prd-implementation-summary.md`。

## 脚本

脚本根目录前缀 **`ai-std4/scripts/`**。

| 脚本 | 职责 |
| --- | --- |
| `stages/prd-review.cjs` | **编排入口**；步骤 2 为各端 Agent **并发** |
| `libs/prd-review-bootstrap.cjs` | 步骤 1：骨架、hash 门控 |
| `libs/prd-review-validate.cjs` | 步骤 3：合并、门闸、写 `stages.prd_review` |
| `libs/prd-implementation-report.cjs` | 生成 `prd-implementation-summary.md` |
| `libs/check-hash.cjs` | 文件哈希比对（复用） |

```bash
node ai-std4/scripts/stages/prd-review.cjs --project=<业务项目根绝对路径>
```

## 上游门闸

`stages.prd.status=completed` 且 `stages.prd.validation.passed=true`，且 `stages.prd.outputs.features[]` 非空。

## 输入

| 来源 | 要求 |
| --- | --- |
| `<业务项目根绝对路径>/output-stages/prd/prd-spec.md` | PRD 总源头 |
| 各端 PRD 内容文件 | `stages.prd.outputs.client_targets[]` 每一端；路径映射见 [prd § client_target 映射](prd.md#client_target--文件与模板映射)（如 `website` → `output-stages/prd/prd-web.json`） |
| `output-stages/prd/feature_list-<client_target>.md` | 各端特性表（`<client_target>` 为逻辑端名，与 prd 阶段一致） |
| `<业务项目根绝对路径>/.pipeline/stages.json` | `stages.prd.outputs.features[]`（跨端 feature 全集，评审覆盖门闸的真源） |
| `<业务项目根绝对路径>/docs/config.dev.json` | 部署/流水线配置（仅非敏感字段，供评审引用） |

## 处理逻辑

1. **`prd-review-bootstrap.cjs`（bootstrap）**：
- 判断 `stages.prd_review` 骨架是否存在；若不存在则初始化：
```json
    {
      "status": "started",
      "started_at": "<当前本地时间>",
      "completed_at": null,
      "inputs": {
        "prd_spec_hash": null,
        "requires_stage": "prd",
        "source_prd_spec": "<业务项目根绝对路径>/output-stages/prd/prd-spec.md",
        "feature_index_ref": "stages.prd.outputs.features",
        "per_target_hashes": {}
      },
      "outputs": {
        "decision": "pending",
        "can_enter_design": false,
        "current_phase": null,
        "duration_ms": null,
        "timed_out": false,
        "timeout_reason": null
      },
      "review": {
        "summary": "",
        "phase_plan": [],
        "deferred_features": [],
        "priority_changes": [],
        "cross_phase_dependencies": [],
        "config_change_suggestions": { "dev": [], "release": [] },
        "suggested_prd_spec_changes": []
      },
      "blocking_issues": [],
      "conditions": [],
      "validation": {
        "passed": false,
        "checked_at": null,
        "summary": null,
        "required_files": [],
        "missing_required_fields": [],
        "warnings": []
      }
    }
```
- 调用 `check-hash.cjs`：计算 `output-stages/prd/prd-spec.md` 的 SHA-256，与 `stages.prd_review.inputs.prd_spec_hash` 比对；若哈希一致 **且** `stages.prd_review.status=completed` **且** `outputs.decision=passed` **且** 各端 `per_target_hashes` 与当前各 `output-stages/prd/prd-<client_target>.json` SHA-256 均一致 **且** `.pipeline/prd-review-output.json` 与 `.pipeline/reports/prd-implementation-summary.md` 存在，则**整段跳过**（写 `stage_skipped` + 退出码 0）；否则写 `stages.prd_review.status=running`，对需重评的端继续步骤 2（各端 `per_target_hash` 命中且上次 `decision=passed` 的端单独跳过）。

2. **Agent-Review（各端评审，每端一个 Agent 并发）**：脚本按 `stages.prd.outputs.client_targets[]` 同时启动 N 个 Agent；每端 Agent 受 `config.dev.json` 的 `timeouts.stages.prd_review_s`（默认 300 s）约束，超时记该端 `agent_failed`，退出码 **4**；**每个 Agent 仅评审本端**，使用**该端专属提示词**（见下表），产出 **`<业务项目根绝对路径>/.pipeline/prd-review-<client_target>.json`**（Agent **不得**直接改写 `stages.json` 全文）。

| 端标识 | 提示词模板 | 产出文件 |
| --- | --- | --- |
| `web` / `website` / `frontend` | `ai-std4/prompts/prd-review-web.md` | `.pipeline/prd-review-<逻辑端名>.json`（如 `prd-review-website.json`；**不**强制 `-web` 后缀，与 `stages.prd.outputs.client_targets[]` 项一致） |
| `backend` / `server` / `api` | `ai-std4/prompts/prd-review-backend.md` | `.pipeline/prd-review-backend.json` |
| `mobile` / `ios` / `android` | `ai-std4/prompts/prd-review-mobile.md` | `.pipeline/prd-review-mobile.json` |
| `admin` | `ai-std4/prompts/prd-review-admin.md` | `.pipeline/prd-review-admin.json` |
| 其余端 | `ai-std4/prompts/prd-review-default.md` | `.pipeline/prd-review-<client_target>.json` |

**单端 Agent 输入**（每次调用仅读下列文件）：
- `<业务项目根绝对路径>/output-stages/prd/prd-spec.md`（全文，理解跨端背景）
- `<业务项目根绝对路径>/output-stages/prd/prd-<client_target>.json`
- `<业务项目根绝对路径>/output-stages/prd/feature_list-<client_target>.md`
- `stages.prd.outputs.features[]` 中 **`client_targets` 含本端** 的条目（本端评审范围；不得评审与它端无关的 feature）

**单端产出 JSON**（须满足 `docs/spec/std4/schemas/prd-review-client-output.schema.json`）示例：

```json
{
  "client_target": "website",
  "review": {
    "summary": "本端 PRD 评审结论（中文）",
    "feature_assessments": [
      {
        "feature_id": "AUTH-LOGIN-001",
        "phase": "mvp",
        "disposition": "include",
        "notes": "登录页与鉴权流程已对齐 prd-spec"
      },
      {
        "feature_id": "WEB-HOME-001",
        "phase": "standard",
        "disposition": "defer",
        "notes": "首页可延后至 standard"
      }
    ],
    "deferred_features": [
      { "feature_id": "WEB-HOME-001", "reason": "非 MVP 必需", "priority": "P2" }
    ],
    "blocking_issues": [],
    "suggested_prd_spec_changes": []
  },
  "outputs": {
    "decision": "passed",
    "features_reviewed": 2,
    "features_deferred": 1
  }
}
```

**单端 Agent 硬约束**：
- **`disposition`**：`include`（纳入分期）| `defer`（明确延期）；本端可见的每个 feature 必须有且仅有一条 `feature_assessments` 记录。
- **`phase`**：`mvp` | `standard` | `complete` | `future`（与 prd feature 枚举一致）；`disposition=include` 时必填。
- **`feature_id`**：须出现在本端 `prd-<client_target>.json` 的 `features[]` 或 `outputs.features[]` 且 `client_targets` 含本端；命名符合 prd 阶段规则。
- **禁止**：夹带密钥；改写 `prd-spec.md` / 各端 `prd-*.json` 正文（建议仅写入 `suggested_prd_spec_changes[]`）。
- **`outputs.decision`**：`passed` 时本端 `blocking_issues` 为空；`failed` 时列出阻塞项。各端完成后由编排器等待全部 Promise  settle，再进入步骤 3。

> **稳定性保障（各端 Agent）**：
>
> | 机制 | 说明 |
> | --- | --- |
> | **按端哈希门控** | 启动某端 Agent 前，计算 `output-stages/prd/prd-<client_target>.json` 的 SHA-256 与 `stages.prd_review.inputs.per_target_hashes.<client_target>` 比对；若与上次评审一致且该端上次 `decision=passed`，则**跳过该端 Agent** |
> | **Schema 强校验 + 重试** | 单端 JSON 产出后立即 Ajv 校验 `prd-review-client-output.schema.json`；失败则带错误重试该端，**最多 2 次**；仍失败则记该端 `failed`，整 stage 退出码 **4** |
> | **Prompt 输出格式锁定** | 各端模板末尾附 `## 输出约束`，锁定 `feature_assessments[]` 字段名与 `disposition` 枚举 |

3. **`prd-review-validate.cjs`（merge + validate + write）**：
- **合并各端产出**：读取全部 `.pipeline/prd-review-<client_target>.json`，合成 **`<业务项目根绝对路径>/.pipeline/prd-review-output.json`**（全局形态，供门闸与 stages 消费）：
- `review.summary`：按端拼接各端 `review.summary`（Markdown 小节标题为端名）。
- `review.phase_plan[]`：将各端 `disposition=include` 的 feature 按 `phase` 分组；同一 `feature_id` 跨端出现时，`phase` 取**最先可交付**（`mvp` < `standard` < `complete` < `future`）；`goal` / `exit_criteria` 由脚本从各端 `notes` 与 `prd-spec.md` 提炼生成（每 phase 至少 1 条）。
- `review.deferred_features[]`：合并各端 `defer` 项并去重；若某 feature 在一端 `include`、另一端 `defer`，记为**冲突**，`outputs.decision=failed`。
- `outputs.decision`：仅当**所有端** `outputs.decision=passed` 且合并无冲突时为 `passed`。
- `blocking_issues` / `conditions`：合并各端数组；全局 `passed` 时均为 `[]`。
- 对合成后的 `prd-review-output.json` 用 Ajv 校验 `prd-review-output.schema.json`。
- **覆盖门闸**：以 `stages.prd.outputs.features[].feature_id` 为全集：
- 每个 id 须在 `phase_plan` 或 `deferred_features` 中出现且仅出现一次；
- `phase_plan` 中每个 id 须存在于全集；
- `phase_plan[*].phase` 须为合法枚举；
- `phase_plan[*].feature_ids` 非空，`goal` / `exit_criteria` 非空。
- **交叉校验**：各 `feature_id` 须能在至少一个 `output-stages/prd/feature_list-<client_target>.md` 或对应 `output-stages/prd/prd-<client_target>.json` 的 `features[]` 中找到（与 prd 产出一致）。
- `outputs.decision=failed` → 写 `stages.prd_review.outputs.decision=failed`、`validation.passed=false`，退出码 **4**，提示重跑 `--from-stage=prd` 或 `--from-stage=prd-review`。
- `outputs.decision=passed` → 合并 JSON 入 `stages.prd_review`：`status=completed`、`validation.passed=true`、`inputs.prd_spec_hash`（prd-spec.md 哈希）、`inputs.per_target_hashes`（各端 `prd-<client_target>.json` 哈希）、`outputs.decision=passed`、`outputs.can_enter_design=true`、`outputs.current_phase`（取 `phase_plan[0].phase`）、`review.*`；调用 `prd-implementation-report.cjs` 生成 `.pipeline/reports/prd-implementation-summary.md`（顶部含 **「AI 评审门闸结果」** 节）。
- 阶段完成后：`git.auto_commit` / `git.allow_push` 驱动 commit 与 push（见 [git-config.md](../git-config.md)）。

## 日志事件（prd-review）

> 步骤 2 按端并发时，**每个 Agent 独立一行** `agent_start` / `agent_complete` / `agent_failed`，`agent_id` 与 `client_target` 一一对应，便于 `run-dash` 与 report 按端过滤。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 步骤1：初始化骨架 | `file_created` / `file_updated` | INFO | `path`（stages.json 中 stages.prd_review），首次 `file_created`；已存在 `file_updated` |
| 步骤1：全局哈希比对 | `hash_check` | INFO | `file`（prd-spec.md）, `stored_hash`, `computed_hash`, `hit` |
| 步骤1：按端哈希比对 | `hash_check` | INFO | `client_target`, `file`（prd-<client_target>.json）, `stored_hash`, `computed_hash`, `hit`, `skip_agent`（bool） |
| 全局哈希命中，整段 stage 跳过 | `stage_skipped` | INFO | `reason: "prd_spec_hash and all per_target_hashes matched, output files exist"`, `exit_code: 0` |
| 步骤1：写 running | `file_updated` | INFO | `path`（stages.json）, `status: "running"` |
| 步骤2：并发批次开始 | `agent_batch_start` | INFO | `batch_id: "prd-review-agents"`, `client_targets[]`, `agents_total`, `agents_skipped[]` |
| 步骤2：单端 Agent 启动 | `agent_start` | INFO | `agent_id: "prd-review-agent-<client_target>"`, `client_target`, `prompt`（如 `prd-review-web.md`）, `input_files: ["prd-spec.md","prd-<client_target>.json","feature_list-<client_target>.md"]`, `features_in_scope[]` |
| 步骤2：单端 Agent 跳过 | `agent_skipped` | INFO | `agent_id`, `client_target`, `reason: "per_target_hash matched"` |
| 步骤2：单端 schema 失败重试 | `agent_retry` | WARN | `agent_id`, `client_target`, `attempt`, `reason`, `invalid_fields[]` |
| 步骤2：单端 Agent 完成 | `agent_complete` | INFO | `agent_id`, `client_target`, `duration_ms`, `output_files: ["prd-review-<client_target>.json"]`, `decision`, `features_reviewed`, `features_deferred` |
| 步骤2：单端 Agent 失败 | `agent_failed` | ERROR | `agent_id`, `client_target`, `exit_code: 4`, `reason`, `blocking_issues_count` |
| 步骤2：并发批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：合并各端产出 | `file_created` | INFO | `path`（.pipeline/prd-review-output.json）, `merged_from[]`（各端 json 路径） |
| 步骤3：合并冲突 | `validation_fail` | ERROR | `conflict_feature_ids[]`, `details`（端间 include/defer 不一致） |
| 步骤3：全局 schema 失败 | `validation_fail` | ERROR | `missing[]`, `invalid[]`, `schema: "prd-review-output.schema.json"` |
| 步骤3：覆盖门闸失败 | `validation_fail` | ERROR | `uncovered_feature_ids[]`, `duplicate_feature_ids[]`, `unknown_feature_ids[]` |
| 步骤3：校验通过 | `validation_pass` | INFO | `decision: "passed"`, `phase_plan_phases[]`, `features_in_plan`, `features_deferred`, `per_target_decisions`（`{ "<client_target>": "passed" }`） |
| 步骤3：写完成态 | `file_updated` | INFO | `path`（stages.json）, `status: "completed"`, `prd_spec_hash`, `per_target_hashes`, `current_phase` |
| 步骤3：生成报告 | `file_created` | INFO | `path`（.pipeline/reports/prd-implementation-summary.md） |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `decision`, `phase_count`, `client_targets_reviewed[]` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_client_target`（若有） |

## 退出码（本 stage）

| 码 | 场景 | stages.prd_review.status |
| ---: | --- | --- |
| 0 | 成功（含 hash 跳过） | `completed` |
| 0 | 全局 hash 命中整段跳过 | `completed`（不变） |
| 1 | prd 门闸未满足、缺少 `features[]`、`stages.json` 写入失败 | `failed` |
| 3 | 某端 Agent 超时 | `failed` |
| 4 | 任一端 Agent 失败、合并冲突、覆盖门闸或 schema 失败 | `failed` |
| 5 | 检测到 `stop.signal` | `stopped` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/prd-review-<client_target>.json` | 各端 Agent 原始产出（校验通过后保留） |
| `.pipeline/prd-review-output.json` | 脚本合并后的全局评审 JSON（门闸真源） |
| `.pipeline/stages.json` | `stages.prd_review` 完成态：`outputs.decision`、`review.phase_plan[]`、`review.deferred_features[]` |
| `.pipeline/reports/prd-implementation-summary.md` | 人话版分期摘要与门闸结论 |

## 解锁

`stages.prd_review.status=completed` 且 `stages.prd_review.outputs.decision=passed` 且 `stages.prd_review.validation.passed=true` → 可运行 `design`。

---
