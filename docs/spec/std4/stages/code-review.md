# code-review 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [编排映射](../std4.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std4.md#4-agent-卡点速查)

> 按 **feature** 派发 Agent，对各 feature 的 codegen 产出（worktree 内变更集）做**创造性评审**：与 `design.json` 对齐、`acceptance[]` 覆盖、`file_plan` 边界、基础安全、测试存在性。每 feature Agent 产出 `.pipeline/code-review-<feature_id>.json`，脚本做确定性预检 + **feature 级**合并；任一 feature `critical_issues > 0` 即 stage `failed`，回 codegen 修复。
>
> **不**合并代码到主干、**不**修改 worktree 文件；只读评审 + 写评审 JSON。

## 脚本

脚本根目录前缀 **`ai-std4/scripts/`**：`stages/code-review.cjs`（编排入口，内部循环直至全部 feature 终态）、`libs/code-review-bootstrap.cjs`、`libs/code-review-validate.cjs`。

```bash
node ai-std4/scripts/stages/code-review.cjs --project=<业务项目根绝对路径> [--feature=<feature_id>]
```

> 与 [design-review](design-review.md) 同款 review-stage 结构（bootstrap → 并发 Agent → validate），但 **不**跨 stage 并行（上游 codegen 已 `completed`），故**不**提供 `--tick`，单次 `code-review.cjs` 运行内部自循环直至全部 feature 终态。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.codegen.status=completed`（含 `validation.passed=true`；若 codegen 内任一 feature `failed` → codegen 整体 `failed`，本 stage **不**启动） |
| **单 feature 入队评审** | `stages.codegen.features.<feature_id>.status=completed` 且 `stages.codegen.features.<id>.commit` 非空且对应 worktree HEAD == 该 commit |

> 评审对象是 worktree（`features/v3-<feature_id>` 分支），**不**等 `merge_push`，确保不通过的代码无法进主干。

## 并发配置（feature 级线程池）

与 `design` / `design-review` / `codegen` / `create-ui-scenarios` 完全一致，并发度取自业务项目 **`docs/config.dev.json`**：

```
effective_parallel = min(
  pipeline.stages.code_review.feature_max_parallel,
  pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.code_review.feature_max_parallel` | `3` | 本 stage 同时运行的 code-review Agent 上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | **全局天花板**（与 design / codegen 等共用） |
| `timeouts.stages.code_review_s` | `600` | 单 feature 评审 Agent 超时（秒），超时记该 feature `failed`、`timed_out=true`、`exit_code: 3` |
| `pipeline.stages.code_review.max_retries` | `2` | 单 feature Agent 因 schema 校验失败 / 进程异常的最大重试次数 |

配置示例：

```json
{
  "pipeline": {
    "stages": {
      "code_review": {
        "feature_max_parallel": 3,
        "max_retries": 2
      }
    }
  },
  "timeouts": {
    "stages": {
      "code_review_s": 600
    }
  }
}
```

> 实现要求：固定大小 Worker 池，**禁止**按 feature 无限制起线程。code-review 为**只读**评审任务，不修改 worktree，不依赖外部网络；超时即视为 Agent 失败（**不**走 codegen 那种 hang/resume 复杂流程，直接重试或失败）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.codegen.outputs.feature_artifacts[]` | 已完成 codegen 的 feature 列表（`feature_id` / `commit` / `branch` / `worktree_path` / `files_changed_count` 等） |
| `stages.codegen.features.<feature_id>` | 单 feature 详细：`commit` / `files_changed[]` / `attempts_used` / `hang_history[]` / `design_hash`（评审上下文：评审中可参考"该 feature 曾卡死 N 次"，但**不得**因此放宽标准） |
| `<业务项目根绝对路径>/.pipeline/worktrees/v3-<feature_id>/` | 评审对象：worktree HEAD（与 `features.<id>.commit` 一致） + `git diff <base_commit>..HEAD` 变更集 |
| `<业务项目根绝对路径>/docs/designs/<feature_id>.design.json` | 对齐基准（`file_plan` / `api_outline` / `acceptance` / `constraints` / `dependencies`） |
| `<业务项目根绝对路径>/docs/ui-scenarios/<feature_id>.scenarios.yaml` | 可选（若已就绪）：核对验收点是否能映射到代码路径 |
| `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、`timeouts.stages.code_review_s`、`max_retries` |
| `inputs/config.env` → `CURSOR_API_KEY` | `@cursor/sdk` |

**CLI 过滤**：`--feature=<feature_id>` 仅重评单个 feature（用于失败重跑）；仍遵守上游门闸。

> 兼容旧约定：环境变量 `AI_STD4_CODE_REVIEW_JSON` 或 CLI `--code-review-json=<path>` **已弃用**（v3 全面走 per-feature Agent 派发，不再接受 stage 级单文件覆盖）；若检测到，打 `WARN` 并忽略。

## 处理逻辑

1. **`code-review-bootstrap.cjs`（bootstrap + 确定性预检）**：
   - 从 `stages.codegen.outputs.feature_artifacts[]` 收集目标 feature 集合（`feature_id` / `commit` / `branch` / `worktree_path` / `design_hash`）。
   - **先读旧值**：读取 `stages.code_review.inputs.review_bundle_hash`（骨架不存在则为 `null`）。
   - **计算新值**：`review_bundle_hash_new` = 按 `feature_id` 字典序排列各 feature 的 `${feature_id}:${commit}:${design_hash}` 字符串组成列表，对该列表做 `JSON.stringify + SHA-256`（hash-of-hashes 方式，与其他 stage 一致）。
   - **hash 门控（全段跳过）**：若 `review_bundle_hash_new == 旧值` **且** `stages.code_review.status=completed` **且** 全部目标 feature `decision ≠ failed` → **整段跳过**（写 `stage_skipped`，退出码 0，不进入步骤 2 / 步骤 3）。
   - **骨架处理 + 写入新值**（非跳过路径）：
     - 若骨架**不存在**：初始化 `stages.code_review`，含 `inputs.review_bundle_hash = review_bundle_hash_new`、`features.<feature_id>.{status=pending, group_id, commit_reviewed=null, review_hash=null, decision=pending, critical_issues=0, warnings=0, duration_ms=0, attempts_used=0, last_error=null}`、`outputs.feature_reviews[]`、`outputs.decision=pending`、`outputs.critical_issues_total=0`、`outputs.warnings_total=0`、`outputs.failed_features[]`、`outputs.skipped_features[]`。
     - 若骨架**已存在**：写入 `inputs.review_bundle_hash = review_bundle_hash_new`；将 `status=running` 的 feature 重置为 `pending`（zombie 重置）；`status=completed` / `failed` / `skipped` 的 feature 状态保留；新增 feature 初始化为 `pending`。
   - **确定性预检**（不调用 Agent，命中则记录为 `deterministic_issues[]`，作为 Agent 输入注入提示词，并直接计入最终 `issues[]`，不被 Agent `passed` 结论覆盖）：
     - worktree HEAD ≠ `features.<id>.commit` → 该 feature `blocking`（`critical`），`reason: "worktree HEAD drifted"`，**不**入池（先纠正 codegen）；
     - `git diff --name-only <base>..HEAD` 结果集 ⊄ `design.json.file_plan.new_files ∪ modify_files` 的并集 → 越界文件登记 `severity=warning`、`category=file_plan`（可在 `pipeline.stages.code_review.file_plan_strict=true` 时升级为 `critical`）；
     - `files_changed[].length == 0`（codegen commit 空变更）→ `critical`，`reason: "empty commit"`，**不**入池；
     - `design.json.api_outline[].path` 未在 `files_changed[]` 任一文件中粗略命中（`grep -F` 路径字符串）→ `severity=warning`、`category=api_outline`（Agent 进一步确认）；
     - codegen 阶段 `hang_history[].length > 0` → 标 `info` 级提示（不阻塞，仅提示评审 Agent 关注稳定性），**不**作为 issue 计入。
   - 写 `stages.code_review.status=running`；日志记录 `effective_parallel`、`pending_feature_ids[]`、`zombie_features_reset[]`、`deterministic_blocking_count`、`deterministic_warning_count`。

2. **Agent-CodeReview（按 feature 并发）**：
   - 编排器维护固定大小 `effective_parallel` 的 Worker 池；从「`features.<id>` 未 `passed`/`failed`/`skipped` 且**无 deterministic blocking gap**」集合中取就绪 feature 入池。
   - 每个 Agent **仅评审一个 feature**，按 **`ai-std4/prompts/code-review-agent.md`** 执行，产出 **`<业务项目根绝对路径>/.pipeline/code-review-<feature_id>.json`**（**不得**修改 worktree、`design.json`、`stages.json`）。
   - 单 feature 评审落盘后：
     - 立即 Ajv 校验 `code-review-feature-output.schema.json`；失败 → 重试该 feature Agent（**最多 `max_retries` 次**，`agent_retry`，meta 含 `invalid_fields[]`）；超出仍失败 → `features.<id>.status=failed`、`exit_code: 4`。
     - 校验通过 → 合并 `deterministic_issues[]` 入产出 `review.issues[]`（去重：相同 `(category, file, line)` 取 Agent 版优先，但严重度取**两者最大值**）；
     - 重算 `critical_issues` / `warnings`（含确定性 + Agent 双方）；按下表派生 `decision`（**以脚本派生为准**，覆盖 Agent 自报）：

       | 派生条件 | `decision` |
       | --- | --- |
       | `critical_issues > 0` | `failed` |
       | `critical_issues == 0` 且 `warnings > 0` | `passed_with_warnings` |
       | `critical_issues == 0` 且 `warnings == 0` 且 `checklist_failed == 0` | `passed` |
       | 其它（如 checklist 失败但无 issues）| `passed_with_warnings` |
     - 写 `features.<feature_id>.{decision, critical_issues, warnings, commit_reviewed, review_hash, duration_ms, attempts_used}`；打事件 `feature_review_complete`（`meta.feature_id` / `meta.decision` / `meta.critical_issues` / `meta.warnings`）。
   - 单 feature **超时**（壁钟 > `timeouts.stages.code_review_s`）：先 SIGINT，等 5s 后 SIGKILL；视为 Agent 失败；若 `attempts_used < max_retries` → 重试；否则 `features.<id>.status=failed`、`timed_out=true`、`exit_code: 3`。
   - 循环调度直至**无在途 Agent 且无待入池 feature**，进入步骤 3。

   **单 feature 输入**（每次 Agent 调用范围）：
   - `<worktree_path>` 下全部源码（HEAD 状态，pinned 到 `features.<id>.commit`）；
   - `git diff <base_commit>..HEAD` 完整 patch（由脚本预生成 `.pipeline/code-review-<feature_id>.diff` 文件供 Agent 读，避免 Agent 反复执行 git）；
   - `docs/designs/<feature_id>.design.json`；
   - 可选 `docs/ui-scenarios/<feature_id>.scenarios.yaml`；
   - 注入 prompt 的 `deterministic_issues[]`（脚本预先发现的越界/缺失项，要求 Agent 在 `issues[]` 中**复述并扩充**，不得忽略）；
   - 注入 prompt 的 codegen 上下文摘要（`commit` / `files_changed_count` / `attempts_used` / `hang_kinds[]`），仅供参考。

   **单 feature 产出 JSON**（须满足 `code-review-feature-output.schema.json`）示例：

   ```json
   {
     "feature_id": "NOTE-CRUD-001",
     "review": {
       "summary": "实现整体覆盖 design.json；存在 1 个 warning：tests/notes.test.ts 仅覆盖创建路径。",
       "checklist": [
         { "item": "API 端点与 design.api_outline 一致",       "status": "passed" },
         { "item": "acceptance AC1 已实现并测试",              "status": "passed" },
         { "item": "acceptance AC2 已实现并测试",              "status": "passed" },
         { "item": "acceptance AC3 已实现并测试",              "status": "passed" },
         { "item": "无硬编码密钥/敏感信息",                    "status": "passed" },
         { "item": "无明显 SQL 注入 / XSS 风险",               "status": "passed" },
         { "item": "包含单元测试",                             "status": "passed" },
         { "item": "包含集成测试",                             "status": "passed" },
         { "item": "实现文件均在 design.file_plan 范围内",    "status": "passed" }
       ],
       "issues": [
         {
           "severity": "warning",
           "category": "test_coverage",
           "file": "tests/notes.test.ts",
           "line": null,
           "message": "仅覆盖 POST /api/notes 路径；GET / PUT / DELETE 缺少集成测试",
           "suggested_fix": "补充 GET、PUT、DELETE 的集成测试"
         }
       ]
     },
     "outputs": {
       "decision": "passed_with_warnings",
       "critical_issues": 0,
       "warnings": 1,
       "checklist_passed": 9,
       "checklist_failed": 0
     }
   }
   ```

   **Agent 硬约束**：
   - 评审维度（**checklist 必含**全部 9 项）：
     1. 实际变更文件均在 `design.file_plan` 范围内（`new_files` ∪ `modify_files`）；
     2. API 实现与 `api_outline[]` 一致（方法 + 路径全覆盖）；
     3. `acceptance[]` 每条均有可识别的代码实现路径与测试；
     4. 包含单元测试（codegen Agent 强约束的内嵌测试）；
     5. 包含集成测试（覆盖至少一条业务链路）；
     6. 无硬编码密钥 / 数据库口令 / 测试用户密码；
     7. 无明显 SQL 注入 / XSS / 命令注入风险；
     8. 无明显未处理异常 / 静默 swallow；
     9. `constraints[]` 中的技术约束（如"复用现有 JWT 中间件"）已遵守。
   - `outputs.decision`：`passed` | `passed_with_warnings` | `failed`（**Agent 自报的 decision 仅作参考；脚本依 `critical_issues` / `warnings` 重派**，见步骤 2 表）。
   - `issues[*].severity`：`critical` | `warning` | `info`；`critical` 用于以下场景：硬编码密钥/口令、明显安全漏洞、API 端点缺失或与 `api_outline` 严重不符、acceptance 完全未实现。
   - `issues[*].category`：`file_plan` | `api_outline` | `acceptance` | `security` | `consistency` | `test_coverage` | `other`。
   - **禁止**：修改 worktree 文件、`design.json`、`stages.json`、`.pipeline/`（评审 JSON 由脚本写入路径，Agent 仅向 stdout 输出 JSON 或写入指定输出文件）；调用网络；执行任意 shell（仅允许通过 prompt 内置工具读 worktree 文件）。
   - **禁止虚报**：不得为了 `passed` 而省略已知 issue；deterministic_issues[] 中的项目**必须**全部复述（脚本会校验并触发 retry 若遗漏 ≥ 1 项）。

   > **稳定性保障**：
   >
   > | 机制 | 说明 |
   > | --- | --- |
   > | **按 feature 哈希门控** | `review_hash = SHA-256(<code-review-<feature_id>.json 文件内容>)`；若 `commit_reviewed == features.<id>.commit` 且当前文件 SHA-256 == `review_hash` 且上次 `decision != failed` → 跳过该 feature Agent（`agent_skipped`） |
   > | **Schema 强校验 + 重试** | 产出后 Ajv 校验；失败重试该 feature，**最多 `max_retries` 次** |
   > | **确定性 issue 保留** | bootstrap 写入的 `deterministic_issues[]` 不因 Agent `passed` 被覆盖；缺漏 ≥1 项触发 retry |
   > | **decision 派生** | 脚本以 `critical_issues` / `warnings` 派生最终 `decision`，覆盖 Agent 自报，避免 Agent 自我宽松 |
   > | **超时硬上限** | 单 feature Agent 壁钟 > `timeouts.stages.code_review_s` → SIGINT/SIGKILL，按失败 + 重试处理 |

3. **`code-review-validate.cjs`（merge + finalize）**：
   - 遍历目标 feature_ids：每个 feature 必须 `features.<id>.status ∈ {completed, failed, skipped}` 且对应 `.pipeline/code-review-<feature_id>.json` Ajv 通过（或 hash 跳过时沿用上次结果）。
   - 汇总 `outputs.feature_reviews[]`：`{ feature_id, group_id, decision, critical_issues, warnings, checklist_passed, checklist_failed, issues_summary, commit_reviewed }`。
   - 合并全局统计：`outputs.critical_issues_total = Σ features.*.critical_issues`、`outputs.warnings_total = Σ features.*.warnings`、`outputs.failed_features[] = features.<id>.decision=failed 的 id 列表`。
   - **门闸（两级）**：
     - **feature 级**：`decision=failed`（含 deterministic critical / Agent critical / 多次重试失败 / 超时）→ `features.<id>.status=failed`，记 `last_error`；
     - **stage 级**：存在任何 `features.<id>.decision=failed` 或 `outputs.critical_issues_total > 0` → `stages.code_review.status=failed`、`outputs.decision=failed`、`validation.passed=false`，退出码 **4**（按卡点速查走 `--from-stage=codegen --feature=<id>` 修代码或 `--from-stage=code-review --feature=<id>` 重评）；
     - 全部 `decision ∈ {passed, passed_with_warnings}` → `stages.code_review.status=completed`、`outputs.decision`（`passed` 当且仅当 **全部** feature `passed`；任一 `passed_with_warnings` → 整体 `passed_with_warnings`）、`validation.passed=true`。
   - 写 `outputs.decision`、`outputs.critical_issues_total` / `warnings_total`（`inputs.review_bundle_hash` 已由 bootstrap 写入，此处无需重算）。
   - 生成 `.pipeline/reports/code-review-summary.md`（每 feature 一行：decision、critical/warnings、checklist 通过率、关键 issue 摘要；含 stage 级总计与失败 feature 列表）。

## 日志事件

> 步骤 2 按 feature 并发：每轮调度打 `agent_batch_start` / `agent_batch_complete`；每个 feature 独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped` / `agent_retry`，`meta.feature_id` 必填。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 步骤1：初始化/更新 | `file_created` / `file_updated` | INFO | `path`（stages.code_review），`zombie_features_reset[]` |
| 步骤1：确定性预检 | `validation_pass` / `validation_fail` | INFO/ERROR | `feature_ids[]`, `deterministic_blocking_count`, `deterministic_warning_count`, `out_of_plan_files[]`, `empty_commit_features[]` |
| 步骤1：bundle 哈希 | `hash_check` | INFO | `review_bundle_hash`, `stored_hash`, `computed_hash`, `hit` |
| 步骤1：整段跳过 | `stage_skipped` | INFO | `reason: "review_bundle_hash matched, prior decision retained"`, `exit_code: 0` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `effective_parallel`, `pending_feature_ids[]`, `zombie_features_reset[]` |
| 步骤1：diff 预生成 | `file_created` | INFO | `feature_id`, `path: ".pipeline/code-review-<feature_id>.diff"`, `size_bytes` |
| 步骤2：单 feature 评审完 | `feature_review_complete` | INFO | `feature_id`, `decision`, `critical_issues`, `warnings`, `checklist_passed`, `checklist_failed` |
| 步骤2：批次开始 | `agent_batch_start` | INFO | `batch_id: "code-review-batch-<n>"`, `feature_ids[]`, `agents_total`, `agents_skipped[]`, `effective_parallel` |
| 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "code-review-agent-<feature_id>"`, `feature_id`, `prompt: "code-review-agent.md"`, `input_files: ["worktrees/v3-<feature_id>/", "code-review-<feature_id>.diff", "designs/<feature_id>.design.json"]`, `deterministic_issues_count` |
| 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "commit_reviewed + review_hash matched, prior decision retained"` |
| 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
| 步骤2：deterministic 遗漏重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `reason: "missing deterministic_issues"`, `missing_issue_keys[]` |
| 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `decision`, `critical_issues`, `warnings`, `output_files: ["code-review-<feature_id>.json"]` |
| 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 3 \| 4`, `reason`, `timed_out`（bool）, `attempts_used` |
| 步骤2：批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：合并 | `file_updated` | INFO | `feature_reviews_count`, `critical_issues_total`, `warnings_total`, `failed_features_count` |
| 步骤3：门闸未通过 | `validation_fail` | ERROR | `decision: "failed"`, `failed_feature_ids[]`, `critical_issues_total`, `exit_code: 4` |
| 步骤3：门闸通过 | `validation_pass` | INFO | `decision: "passed" \| "passed_with_warnings"`, `critical_issues_total: 0`, `warnings_total` |
| 步骤3：写完成态 | `file_updated` | INFO | `status: "completed"`, `decision`, `critical_issues_total` |
| 步骤3：生成报告 | `file_created` | INFO | `path: ".pipeline/reports/code-review-summary.md"` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `decision`, `critical_issues_total` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_feature_id`（若有） |

## 退出码（本 stage）

| 码 | 场景 | stages.code_review.status |
| ---: | --- | --- |
| 0 | 全部 feature `passed` 或 `passed_with_warnings` | `completed` |
| 0 | 全局 hash 命中整段跳过 | `completed`（不变） |
| 1 | codegen 未完成或上游门闸未满足 | `failed` |
| 3 | 单 feature 评审 Agent 超时（超出重试次数） | feature 级 `failed`；stage 级视全局 |
| 4 | `outputs.decision=failed` 或存在 `critical_issues` | `failed` |
| 5 | 检测到 `stop.signal` | `stopped` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/code-review-<feature_id>.json` | 各 feature Agent 评审产出（含 deterministic + Agent 合并后的 `issues[]`） |
| `.pipeline/code-review-<feature_id>.diff` | 脚本预生成的 git patch（评审输入；评审结束后保留供 report / 复查） |
| `.pipeline/stages.json` | `stages.code_review`：`features.<id>`（含 `commit_reviewed` / `review_hash` / `decision` / `critical_issues` / `warnings`）、`outputs.feature_reviews[]`、`outputs.decision`、`outputs.critical_issues_total` / `warnings_total`、`outputs.failed_features[]`、`validation.passed` |
| `.pipeline/reports/code-review-summary.md` | 人话摘要（每 feature 一行 + stage 级总计 + 失败 feature 列表与关键 issue 摘要） |

## 解锁

| 粒度 | 条件 | 效果 |
| --- | --- | --- |
| **feature → merge_push** | `features.<id>.decision ∈ {passed, passed_with_warnings}` | 该 feature 允许进入 merge_push（实际 push 由 stage 级门闸控制） |
| **stage 完成** | 全部 `features.<id>.status ∈ {completed, failed, skipped}`（无在途 Agent） | `stages.code_review.status=completed`（全部通过）或 `failed`（任一 `decision=failed`） |
| **→ merge_push** | `stages.code_review.status=completed` 且 `stages.code_review.outputs.decision ≠ failed`（即 `passed` 或 `passed_with_warnings`） | 可运行 `merge_push`；`passed_with_warnings` 时 `merge_push` 仍可推送，warnings 仅在 report 中体现 |

---
