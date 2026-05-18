# design 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [design 复合编排](../std3.md#31-design--design-review-复合编排) · [卡点速查](../std3.md#4-agent-卡点速查)

> 为 `prd-review` 分期计划中的每个 `feature_id` 产出可实现的 **`design.json`**，作为 codegen / create-ui-scenarios / design-review 的直接输入（**不使用**契约五件套）。
>
> **与 design-review 流水线化**：单个 feature 的 `design.json` 校验通过后**立即**进入 design-review 队列；**不必**等本期全部 feature 设计完成。下游以 **依赖组（group）** 为单位放行，见下文。

## 脚本

路径前缀 **`ai-std3/scripts/lib/`**：`design.cjs`（编排）、`design-bootstrap.cjs`（步骤 1）、`design-validate.cjs`（步骤 3）；步骤 2 为按 **feature** 并发的 Agent 池。与 `design-review.cjs` 复合编排时支持 **`--tick`**（由 `run-pipeline.cjs` 轮询）。

```bash
node ai-std3/scripts/lib/design.cjs --project=<业务项目根绝对路径> [--tick] [--feature=<feature_id>]
```

## 上游门闸

`stages.prd_review.status=completed` 且 `stages.prd_review.outputs.decision=passed` 且 `stages.prd_review.validation.passed=true`，且 `stages.prd_review.review.phase_plan` 非空。

## 依赖组（dependency group）

本期 `feature_ids[]` 内，按各 feature 的 `dependencies[]` 建**有向**依赖图：若 `A.dependencies` 含 `B`，则边 `B → A`（先完成 B 再设计 A）。

> **真源顺序**（与 [§真源分层](../std3.md#0-架构定位) 一致）：
> 1. **首选**：`stages.prd.outputs.features[].dependencies`（prd 聚合后的索引真源，跨端取并集）；
> 2. **补充**：已落盘 `docs/designs/<feature_id>.design.json` 中的 `dependencies[]`（design Agent 后期发现的新依赖）；
> 3. **合并规则**：两者**取并集**；若 design 新增了 prd 未声明的依赖，bootstrap 打 `dependency_added`（WARN）并要求该 id 在 `feature_ids[]` 内，否则退出码 **1**；
> 4. **冲突**（极少见，如 prd 声明了 design 中已移除的依赖）：以 design.json 为准并打 `dependency_overridden`（WARN）。

| 概念 | 规则 |
| --- | --- |
| **group** | 将上述有向图视为**无向图**取连通分量；每个分量一个 `group_id`（`group-<sha256前8位>`，由组内 `feature_id` 排序后稳定哈希） |
| **组内拓扑** | 组内 Kahn 拓扑序；调度时若无法一次拉起整组，**优先启动组内入度为 0（无未满足组内依赖）的 feature** |
| **组间** | 组与组之间无依赖边；可并行推进不同 group |
| **单 feature 组** | `dependencies[]` 为空或依赖均不在本期 `feature_ids[]` 内 → 独立 singleton group |

bootstrap 将 `inputs.dependency_groups[]` 写入 `stages.design`：

```json
{
  "group_id": "group-a1b2c3d4",
  "feature_ids": ["AUTH-LOGIN-001", "NOTE-CRUD-001"],
  "topo_order": ["AUTH-LOGIN-001", "NOTE-CRUD-001"]
}
```

循环依赖 → 退出码 **1**，`cycle_feature_ids[]`。

## 并发配置（feature 级线程池）

design 与后续 codegen 等 stage 均按 **feature** 派发 Agent。并发度由业务项目 **`docs/config.dev.json`** 控制，脚本取：

```
effective_parallel = min(
pipeline.stages.design.feature_max_parallel,
pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.design.feature_max_parallel` | `3` | **本 stage** 同时运行的 design Agent 上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | **全局天花板**（design / codegen / create-ui-scenarios 等凡按 feature 并发的 stage 均不得超过此值） |
| `timeouts.stages.design_s` | `1200` | 单个 feature 的 Agent 超时（秒），超时记该 feature `failed` |

配置示例（写入 `docs/config.dev.json`，由 [setup 的 `sync-config-env.cjs`](setup.md#处理逻辑) 从模板合并）：

```json
{
"pipeline": {
"autorun": {
"feature_max_parallel": 3
},
"stages": {
"design": {
"feature_max_parallel": 3
}
}
},
"timeouts": {
"stages": {
"design_s": 1200
}
}
}
```

> 实现要求：`design.cjs` 维护固定大小为 `effective_parallel` 的 Worker 池；**不按 feature 无限起线程**。依赖未满足的 feature 不入池；**组内**若剩余槽位不足以同时启动整组，按 `topo_order` **优先启动依赖端（入度 0 或组内依赖已 completed 的 feature）**，再启动被依赖方。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.prd_review.review.phase_plan[]` | 待设计 feature 来源；脚本展开为 `feature_ids[]`（去重并保持 `phase` 归属） |
| `stages.prd.outputs.features[]` | **索引真源**：`feature_id` / `client_targets[]` / `dependencies[]` 全部从此读取，**不**扫描 `docs/prd-*.json` |
| `stages.prd.outputs.client_targets[]` | 决定需加载哪些端的 PRD / feature_list |
| `<业务项目根绝对路径>/docs/prd-spec.md` | 总源头 |
| 各端 PRD 内容文件 | 仅加载该 feature 涉及的端；路径见 [prd § 映射](prd.md#client_target--文件与模板映射) |
| `<业务项目根绝对路径>/docs/feature_list-<client_target>.md` | 各端特性表 |
| `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、`timeouts.stages.design_s` |
| 环境变量 `AI_STD3_AGENT_BIN` | 外部 Agent 可执行路径（可选） |

**CLI 过滤**：`--feature=<feature_id>` 仅处理单个 feature（用于重跑失败项）；仍遵守依赖门闸（依赖 feature 须已有 `design.json` 或同次运行中先完成）。

## 处理逻辑

1. **`design-bootstrap.cjs`（bootstrap）**：
- 初始化 `stages.design` 骨架（若不存在），含 `inputs.feature_ids[]`、`inputs.dependency_groups[]`、`features.<feature_id>.status`（`pending`）、`features.<feature_id>.group_id`、`outputs.design_specs[]`。
- 从 `phase_plan` 展开 `feature_ids[]`，与 `stages.prd.outputs.features[]` 交叉校验；缺失则退出码 **1**。
- 计算 `dependency_groups[]`（见上节）与各 `features.<id>.group_id`。
- 计算 `phase_plan_hash`（`review.phase_plan` 稳定序列化后 SHA-256）与 `prd_spec_hash`（`docs/prd-spec.md`）。
- 若 `phase_plan_hash` 与 `stages.design.inputs.phase_plan_hash` 一致且 `stages.design.status=completed` 且全部目标 feature 的 `design.json` 哈希未变，则**跳过步骤 2**，直接进入步骤 3。
- 写 `stages.design.status=running`；日志记录 `effective_parallel`、`feature_ids[]`、`dependency_groups[]`、`groups_count`。

2. **Agent-Design（按 feature 并发，组感知 + 拓扑调度）**：
- 就绪条件：`dependencies[]` 中每个 id 已有有效 `docs/designs/<dep>.design.json`（或 `stages.design.features.<dep>.status=completed`）。
- 在全局 `effective_parallel` 限制下，按 **group 轮转 + 组内 topo_order** 取就绪 feature 入池（见实现要求）；**单 feature 完成并 Ajv 通过后**：
  - 写 `stages.design.features.<feature_id>.status=completed`、`design_hash`；
  - 追加/更新 `outputs.design_specs[]` 对应条目；
  - 打事件 `feature_design_ready`（`meta.feature_id`、`meta.group_id`），供 design-review **同轮或下一轮 `--tick`** 拉取（**不等待** design stage 整体 `completed`）。
- **`--tick` 模式**（复合编排默认）：调度一轮就绪 feature 的 Agent 后写回 `stages.json` 并退出码 **0**；`run-pipeline` 与 `design-review --tick` 交替调用直至全部 feature `completed` 或失败。
- **批量模式**（单独 `--from-stage=design`）：循环 `--tick` 直至无就绪 feature 且池中无在途 Agent，再进入步骤 3。
- 每个 Agent 按 **`ai-std3/prompts/design-spec.md`**（传入 `feature_id`）执行，仅产出 **`docs/designs/<feature_id>.design.json`**（若目录不存在则脚本预先创建 `docs/designs/`）。
- **单 feature 输入**：`prd-spec.md`、该 feature 在 `outputs.features[]` 中的元数据、所涉各端的 `prd-<client_target>.json` 与 `feature_list-<client_target>.md`、**已完成的依赖 feature** 的 `docs/designs/<dep>.design.json`（若无依赖则省略）。
- **单 feature 产出 JSON** 字段：

| 字段 | 说明 |
| --- | --- |
| `feature_id` | 与文件名一致，符合 prd 命名规则 |
| `client_target` | 主责端（`website` / `backend` / `mobile` / `admin` / …） |
| `client_targets` | 该 feature 涉及的全部端（与 `stages.prd.outputs.features[].client_targets` 一致） |
| `title` | 功能名称 |
| `phase` | `mvp` \| `standard` \| `complete` \| `future`（与 prd-review 分期一致） |
| `file_plan` | `{ "new_files": [{ "path", "role" }], "modify_files": [{ "path", "role" }] }` |
| `api_outline` | `[{ "method", "path", "summary" }]`（无 API 则 `[]`） |
| `data_outline` | 主要表/结构说明（字符串或对象数组） |
| `acceptance` | 验收标准，**至少 3 条**字符串 |
| `constraints` | 技术约束字符串数组 |
| `dependencies` | 依赖的 `feature_id[]`，须为 `feature_ids[]` 子集 |
| `risks` | 风险条目 |

示例：

```json
    {
      "feature_id": "NOTE-CRUD-001",
      "client_target": "backend",
      "client_targets": ["backend", "website", "mobile"],
      "title": "笔记 CRUD",
      "phase": "mvp",
      "file_plan": {
        "new_files": [
          { "path": "src/routes/notes.ts", "role": "API 路由" }
        ],
        "modify_files": []
      },
      "api_outline": [
        { "method": "GET", "path": "/api/notes", "summary": "列表" },
        { "method": "POST", "path": "/api/notes", "summary": "创建" }
      ],
      "data_outline": "notes(id, user_id, title, body, updated_at)",
      "acceptance": [
        "用户可创建笔记并持久化",
        "用户可编辑、删除自己的笔记",
        "列表分页返回正确 total"
      ],
      "constraints": ["须复用现有 JWT 中间件"],
      "dependencies": ["AUTH-LOGIN-001"],
      "risks": []
    }
```

> **稳定性保障**：
>
> | 机制 | 说明 |
> | --- | --- |
> | **按 feature 哈希门控** | 若 `docs/designs/<feature_id>.design.json` 存在且 SHA-256 等于 `stages.design.features.<feature_id>.design_hash`，则**跳过该 feature Agent**（`agent_skipped`） |
> | **Schema 强校验 + 重试** | 产出后立即 Ajv 校验 `design.json.schema.json`；失败则重试该 feature Agent，**最多 2 次** |
> | **依赖门闸** | `dependencies[]` 中任一 id 无对应 `design.json` 且 `features.<dep>.status≠completed` → 该 feature 不得入队 |
> | **循环依赖检测** | bootstrap 建图时若发现环 → 退出码 **1**，列出 `cycle_feature_ids[]` |
> | **feature 级下游触发** | 单 feature `completed` 即可被 design-review 评审；组级放行由 design-review 写入 `released_groups[]` |

3. **`design-validate.cjs`（validate + write）**：
- 遍历 `feature_ids[]`：文件存在、Ajv 通过、`feature_id` 与文件名一致、`acceptance.length >= 3`。
- 每个 `dependencies[]` 条目须在 `feature_ids[]` 内且对应 `design.json` 存在。
- 汇总 `outputs.design_specs[]`：`{ feature_id, client_target, phase, new_files_count, modify_files_count, design_hash }`。
- 若有 feature `failed` → `stages.design.status=failed`、`validation.passed=false`，退出码 **4**（可 `--feature=` 重跑）。
- 全部通过 → `status=completed`、`validation.passed=true`、`inputs.phase_plan_hash`、`inputs.prd_spec_hash`、更新各 `features.<id>.design_hash`。
- 可选 git commit+push（`config.dev.json.git.auto_commit=true`）。

## 日志事件（design）

> 步骤 2 按 **feature 并发**（受 `effective_parallel` 限制）：每 wave 打 `agent_batch_start` / `agent_batch_complete`；每个 feature 打独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`，`meta.feature_id` 必填。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 步骤1：初始化 | `file_created` / `file_skipped` | INFO | `path`（stages.design） |
| 步骤1：展开 phase_plan | `validation_pass` | INFO | `feature_ids[]`, `phase_plan_hash`, `groups_count`, `dependency_groups[]`, `effective_parallel` |
| 步骤2：单 feature 可评审 | `feature_design_ready` | INFO | `feature_id`, `group_id`, `design_hash` |
| 步骤1：循环依赖 | `validation_fail` | ERROR | `cycle_feature_ids[]`, `exit_code: 1` |
| 步骤1：整体跳过 | `stage_skipped` | INFO | `reason: "phase_plan_hash matched, all designs fresh"` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"` |
| 步骤2：wave 开始 | `agent_batch_start` | INFO | `batch_id: "design-wave-<n>"`, `wave_index`, `feature_ids[]`, `agents_total`, `effective_parallel` |
| 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "design-agent-<feature_id>"`, `feature_id`, `wave_index`, `prompt: "design-spec.md"`, `dependencies[]`, `client_targets[]` |
| 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "design_hash matched"` |
| 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
| 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `output_files: ["designs/<feature_id>.design.json"]`, `dependencies_count` |
| 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 4`, `reason`, `timed_out`（bool） |
| 步骤2：wave 结束 | `agent_batch_complete` | INFO | `batch_id`, `wave_index`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：校验通过 | `validation_pass` | INFO | `features_total`, `design_specs_count` |
| 步骤3：校验失败 | `validation_fail` | ERROR | `missing[]`, `failed_feature_ids[]` |
| 步骤3：写完成态 | `file_updated` | INFO | `status`, `phase_plan_hash`, `features_completed` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `features_total`, `effective_parallel` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_feature_id`（若有） |

## 退出码（本 stage）

| 码 | 场景 |
| ---: | --- |
| 0 | 成功；`--tick` 单轮调度完成；或 hash 跳过 |
| 1 | prd-review 门闸未满足、循环依赖、feature 不在索引真源 |
| 3 | 单 feature Agent 超时（`timeouts.stages.design_s`） |
| 4 | 校验失败或存在 `failed` feature（可 `--feature=` 重跑） |
| 5 | 检测到 `stop.signal` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `docs/designs/<feature_id>.design.json` | 每 feature 设计规格（下游真源） |
| `.pipeline/stages.json` | `stages.design`：`inputs.dependency_groups[]`、`features.<id>`（含 `group_id`）、`outputs.design_specs[]`、`validation.passed` |

## 解锁

| 粒度 | 条件 | 效果 |
| --- | --- | --- |
| **feature → design-review** | `stages.design.features.<feature_id>.status=completed` 且对应 `design.json` Ajv 通过 | 该 feature 可进入 design-review 队列（**无需** `stages.design.status=completed`） |
| **stage 完成** | 全部 `feature_ids[]` 为 `completed` 或 `failed`，无 `pending`/`running` | `stages.design.status=completed`；若存在 `failed` 则 `validation.passed=false` 且退出码 **4** |
| **group → 下游** | 由 design-review 在组内全部 feature `decision=passed` 后写入 `stages.design_review.outputs.released_groups[]` 与各 `features.<id>.can_enter_codegen` | 见 [design-review 解锁](design-review.md#解锁) |

---
