# prd 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [编排映射](../std4.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std4.md#4-agent-卡点速查)

> 从 req.md 生成 prd-spec 与各端 prd.json，并把所有 feature **聚合写入 `stages.prd.outputs.features[]`** 作为流水线索引真源。

## 真源分层（重要）

| 层 | 文件 | 角色 | 谁会读 |
| --- | --- | --- | --- |
| **内容真源** | `docs/prd-spec.md`、`docs/prd-<client_target>.json` | feature 的完整定义：`description`、`acceptance`、`api_calls`、端内字段等 | Agent（prd-review / design / design-review / codegen 等） |
| **索引真源** | `stages.prd.outputs.features[]` | feature 全集摘要 + 跨端归属 + 依赖图 | 所有 stage **脚本**（prd-review 门闸、design bootstrap、依赖组、调度器） |
| **执行态** | `stages.<stage>.features.<feature_id>` | 每 stage 的逐 feature 状态（pending/completed、group_id、can_enter_codegen 等） | 当前 stage 自己与下游编排 |

> **约束**：脚本一律读「索引真源」，不许重复扫各端 `prd-*.json`；Agent 读「内容真源」。两者由 `prd-validate.cjs` 步骤 4 **聚合**时保证一致，若不一致退出码 **4**。

## 脚本

脚本根目录前缀 **`ai-std4/scripts/`**。

| 脚本 | 职责 |
| --- | --- |
| `stages/prd.cjs` | **编排入口**（`run-pipeline` 调用） |
| `libs/prd-bootstrap.cjs` | 步骤 1：初始化 `stages.prd`、hash 门控、拷贝 prd-spec 模板 |
| `libs/prd-validate.cjs` | 步骤 4：校验、聚合 `features[]`、写完成态 |
| `libs/check-hash.cjs` | 计算文件 SHA-256 并与 `stages.*.inputs` 中存储值比对（各 stage 复用） |

```bash
node ai-std4/scripts/stages/prd.cjs --project=<业务项目根绝对路径>
```

### `client_target` → 文件与模板映射

`prd-spec.md` 的「客户端目标」行使用**逻辑端名**（如 `website`、`backend`）；落盘文件名与 schema 按下表**规范化**（脚本在 Agent-B 前解析）：

| 逻辑端名（`client_targets[]`） | 内容文件 | JSON Schema | 拷贝模板 |
| --- | --- | --- | --- |
| `website`、`web`、`frontend` | `docs/prd-web.json` | `prd-web.json.schema.json` | `prd-web.json.template` |
| `admin` | `docs/prd-admin.json` | `prd-admin.json.schema.json` | `prd-admin.json.template` |
| `backend`、`api` | `docs/prd-backend.json` | `prd-backend.json.schema.json` | `prd-backend.json.template` |
| `mobile` | `docs/prd-mobile.json` | `prd-mobile.json.schema.json` | `prd-mobile.json.template` |
| 其它未知端 | `docs/prd-<client_target>.json` | `prd-default.json.schema.json` | `prd-default.json.template` |

`stages.prd.outputs.client_targets[]` 与 `sources` 键使用**逻辑端名**；`sources` 的值指向实际上述**内容文件路径**。

## 上游门闸

setup 通过（`stages.setup.status=completed`）且 `stages.setup.validation.passed=true`。

## 输入

| 来源 | 要求 |
| --- | --- |
| `<业务项目根绝对路径>/inputs/req.md` | 必填项已齐全 |
| `<业务项目根绝对路径>/docs/config.env` | 云平台鉴权 |
| `<业务项目根绝对路径>/docs/config.<dev|release>.json` | 云平台部署配置 |
| `<业务项目根绝对路径>/.pipeline/stages.json` | setup stage 的输出 |

## 处理逻辑

1. **`prd-bootstrap.cjs`（bootstrap）**：
- 判断 `<业务项目根绝对路径>/.pipeline/stages.json` 文件的 `stages.prd` 的骨架是否存在，
若不存在，则在既有 `.pipeline/stages.json` 上**增量**写入 `stages.prd` 骨架（**不**覆盖 `stages.setup`）；`outputs.config_*` 从 `stages.setup.outputs` 复制；**同时立即计算** `inputs/req.md` SHA-256 并写入 `inputs.req_hash`（不等到步骤 4）。模板字段参考 [`stages.json.template`](../templates/stages.json.template) 与 [`stages.json.schema.json`](../schemas/stages.json.schema.json) 的 `prdStage`：
```json
{
    "status": "started",
    "started_at": "<当前本地时间>",
    "completed_at": null,
    "inputs": {
        "req_hash": "<req.md SHA-256>",
        "prd_spec_hash": null,
        "source_req": "<业务项目根绝对路径>/inputs/req.md",
        "raw_input_refs": []
    },
    "outputs": {
        "config_dev": null,
        "config_release": null,
        "config_env": null,
        "client_targets": [],
        "features": [],
        "features_hash": null,
        "features_total": 0,
        "duration_ms": null,
        "timed_out": false,
        "timeout_reason": null
    },
    "validation": {
        "passed": false,
        "checked_at": null,
        "summary": null,
        "required_files": [],
        "missing_required_fields": [],
        "warnings": []
    },
    "generated_files": [],
    "blocking_issues": [],
    "git_sync": {
        "initial_pushed_at": null,
        "docs_pipeline_pushed_at": null,
        "last_commit": null,
        "last_push_status": null
    }
}
```
若存在，则调用脚本 `check-hash.cjs`：先读取 `stages.prd.inputs.req_hash` 旧值，再计算 `<业务项目根绝对路径>/inputs/req.md` 当前 SHA-256，比对确定 hit/miss，然后将新值**覆盖写入** `stages.prd.inputs.req_hash`（无论 hit/miss，确保下次比对正确）；
  - 若 `req_hash` 命中（与旧值一致）**且** `stages.prd.status=completed`：**整段 stage 跳过**（写 `stage_skipped` 日志 + 退出码 0），不执行步骤 2～4；
  - 若 `req_hash` 命中 **且** `prd-spec.md` 已存在 **且** `status ≠ completed`：跳过 Agent-A（写 `agent_skipped`），写 `stages.prd.status=running`，继续步骤 3（Agent-B 按端检查）；
  - 否则（req_hash miss 或 prd-spec.md 不存在）：继续执行步骤 2（Agent-A 全量运行）。

- 判断 `<业务项目根绝对路径>/docs/prd-spec.md` 是否存在；若不存在，从 [`prd-spec.md.template`](../templates/prd-spec.md.template) 拷贝。

2. **Agent-A（补全 prd-spec，单次调用）**：脚本写 `stages.prd.status=running` 后启动，按 `ai-std4/prompts/prd-spec-author.md` 提示词执行：
- 同时精读 `<业务项目根绝对路径>/inputs/req.md`（需求原文）与已存在的 `<业务项目根绝对路径>/docs/prd-spec.md`（现有草稿，若为空模板则视为全新），**增量补全** prd-spec，产出 **`<业务项目根绝对路径>/docs/prd-spec.md`**（中文、含 `## 客户端目标` 列表与 `## 核心功能` 表）。
- **超时**：受 `config.dev.json` 的 `timeouts.stages.prd_s`（默认 300 s）约束；超时退出码 **3**。
- Agent-A 完成后退出；脚本立即计算 `prd-spec.md` SHA-256 并写入 `stages.prd.inputs.prd_spec_hash`（供步骤 3 Agent-B 按端跳过使用）；再从 prd-spec.md 解析 `client_targets[]` 列表，准备并发调用 Agent-B。

3. **Agent-B（各端 prd.json，每端一个 Agent 并发）**：脚本按 `client_targets[]` 同时启动 N 个 Agent，每个 Agent 仅处理自己的端，按 `ai-std4/prompts/prd-client-author.md` 提示词执行：
- 精读 `docs/prd-spec.md` 与当前端内容文件（见上表「内容文件」列；若不存在，脚本按映射从对应 `.template` 拷贝，未知端用 `prd-default.json.template`），**增量补全**该端 prd.json，字段：

> **`feature_id` 命名规则**（与 v3 prd-spec 保持一致）：
>
> | 场景 | 格式 | 第一段规则 | 示例 |
> | --- | --- | --- | --- |
> | **单端 feature**（只涉及一个 client target） | `<TARGET>-<AREA>-NNN` | 用**端名前缀**（`WEB`、`ADMIN`、`BACKEND`、`MOB`） | `WEB-AUTH-001`、`BACKEND-NOTE-001` |
> | **跨端 feature**（涉及多个 client target） | `<DOMAIN>-<AREA>-NNN` | 用**业务领域词**（`AUTH`、`ORDER`、`NOTE`、`BILLING`），**禁止**用端名 | `AUTH-LOGIN-001`、`NOTE-CRUD-001` |
>
> - `NNN`：三位数字序号，从 `001` 递增，项目内全局唯一
> - 全大写，段间用 `-` 分隔；`<AREA>` 可省略为两段（如 `AUTH-001`，但三段可读性更好）
> - 同一 `feature_id` 跨端一致，不得在不同端的 `prd-*.json` 中出现同义但不同名的 ID

```json
    {
    "client_target": "web",
    "project_name": "...",
    "features": [
        {
        "feature_id": "AUTH-LOGIN-001",
        "name": "用户登录/注册",
        "priority": "P0",
        "phase": "mvp",
        "description": "...",
        "acceptance": ["..."],
        "api_calls": ["POST /api/auth/login"]
        },
        {
        "feature_id": "WEB-HOME-001",
        "name": "首页展示",
        "priority": "P1",
        "phase": "mvp",
        "description": "...",
        "acceptance": ["..."],
        "api_calls": ["GET /api/notes"]
        }
    ],
    "deploy": { "domain": "...", "service_type": "..." },
    "auth": { "type": "jwt|session|none", "notes": "..." },
    "constraints": ["..."]
    }
```
- 同时产出 **`<业务项目根绝对路径>/docs/feature_list-<client_target>.md`**（Markdown 表，每行一个 feature_id，含名称、优先级、阶段）。
- 若该端为 **backend/api**：在 `prd-backend.json` 的 `deploy.api` / `deploy.resources[]` 中声明云资源需求（Workers/D1/R2 等，**不含密钥**）；**不**直接维护完整 `config.dev.json`（由步骤 3b 推断）。
- 各端 Agent-B 超时同受 `config.dev.json` 的 `timeouts.stages.prd_s` 约束；单端超时不影响其他端，该端记 `agent_failed`，退出码 **4**（全部端完成后汇总失败）。
- 所有 Agent-B 全部完成后，执行 **步骤 3b**。

**3b. `infer-deploy-services`（`libs/infer-deploy-services.cjs`）**

- 读取 `prd-spec`、各 `prd-*.json`（权重 backend）、`docs/templates/deploy-services.catalog.json`。
- 规则 + `deploy.resources[]` 显式声明 → merge `docs/config.dev.json` → `deploy.services[]`（含 `requires_artifact`、`status: draft`、 `resource_config`）。
- 云资源写入 config 为 **draft**；**prd-review 通过**后激活；**deploy** 先 provision `d1`/`r2`/`kv`/`queues`/`durable_objects` 再部署 `workers`/`pages`（见 [deploy](deploy.md)）。
- 失败 → prd 退出码 **1**。

**3c. prd-review 通过后激活 deploy 服务**

- `prd-review.cjs` 在 `decision=passed` 时调用 `activate-deploy-services.cjs`：`deploy.services[].status` 由 `draft` → `active`。

4. **`prd-validate`（validate + write）**（原步骤 4，编号顺延）：

> **稳定性保障（防止每次 Agent 输出漂移）**：
>
> | 机制 | 作用于 | 说明 |
> | --- | --- | --- |
> | **输入哈希门控** | Agent-A / Agent-B | Agent-A 跳过条件（bootstrap 中）：`req.md` SHA-256 命中 **且** `prd-spec.md` 已存在；Agent-B 各端跳过条件（步骤 3 启动前）：`prd-spec.md` SHA-256 命中（对比 `prd_spec_hash`）**且** 该端 `docs/prd-<client_target>.json` 通过 Ajv schema 校验 **且** `docs/feature_list-<client_target>.md` 已存在（写 `agent_skipped`）；全部端均跳过时直接进入步骤 4 |
> | **增量写保护** | Agent-A / Agent-B | Prompt 模板明确要求：**只填写占位符或新增缺失字段，禁止删除或修改已有非空内容**；Agent 产出后由脚本做 diff，若发现已有非空字段被清空则拒绝写入并重试 |
> | **Schema 强校验 + 重试** | Agent-B | 每个端的 prd.json 产出后立即用 Ajv 校验 schema（必填字段、类型、`features[]` 非空）；校验失败则带错误提示**重试该端 Agent，最多 2 次**；仍失败退出码 **4** |
> | **Prompt 输出格式锁定** | Agent-A / Agent-B | 提示词模板末尾附 `## 输出约束` 节，逐字要求输出格式（文件路径、必填节名称、JSON 字段名），Agent 不得自行增删顶层结构 |

（下列为 validate 步骤明细，编排上紧接 3b。）

**`prd-validate.cjs`（validate + write）**：
- 校验 `docs/prd-spec.md` 存在、含 `## 客户端目标` H2、每个 `client_target` 对应的 `docs/prd-<client_target>.json` 与 `docs/feature_list-<client_target>.md` 存在。
- 校验 `docs/config.dev.json` 存在且合法 JSON，无明文密钥（forbidden key 扫描）。
- **聚合 features → 索引真源**：遍历所有 `docs/prd-<client_target>.json` 的 `features[]`，按 `feature_id` **去重合并**写入 **`stages.prd.outputs.features[]`**。每条记录字段与合并规则：

| 字段 | 来源 / 合并规则 |
| --- | --- |
| `feature_id` | 端内 `feature_id`，符合 [§命名规则](#`feature_id`-命名规则)；同 id 跨端合并为一条 |
| `name` | 取**首次出现**值；不同端值不一致 → `validation.warnings[]` 追加 |
| `priority` | 取**最高级**（P0 > P1 > P2 > P3） |
| `phase` | 取**最先可交付**：`mvp` < `standard` < `complete` < `future` |
| `description` | 取**最长非空**值（仅作摘要，不替代各端原文） |
| `client_targets` | 各端 `client_target` **并集**，排序后写入 |
| `dependencies` | 各端 `features[].dependencies[]` **并集去重**；任一 id 不在最终 `features[]` 内 → `validation_fail`，退出码 **4** |
| `sources` | `{ "<client_target>": "docs/prd-<client_target>.json" }`，标记内容真源位置 |

示例：

```json
{
  "feature_id": "AUTH-LOGIN-001",
  "name": "用户鉴权",
  "priority": "P0",
  "phase": "mvp",
  "description": "支持手机号/邮箱登录与 JWT 鉴权",
  "client_targets": ["backend", "mobile", "website"],
  "dependencies": [],
  "sources": {
    "backend": "docs/prd-backend.json",
    "mobile":  "docs/prd-mobile.json",
    "website": "docs/prd-web.json"
  }
}
```

> **写入顺序（保证幂等）**：先按 `phase`（mvp→future）再按 `priority`（P0→P3）再按 `feature_id` 字典序，便于哈希命中跳过。
>
> **冲突一致性校验**（聚合时立即校验）：
> - 同一 `feature_id` 在不同端 `priority` 差异超过两级（如 P0 vs P3）→ 写入 `blocking_issues[]`，`validation.passed=false`，退出码 **4**；
> - 同一 `feature_id` 在不同端 `phase` 跨度过大（如 `mvp` vs `future`）→ 同上；
> - `dependencies[]` 含未知 id、自身、或形成自环 → 同上（环检测完整版在 design bootstrap，自环必须在此拦截）；
> - 命名违反规则（单端使用跨端前缀，或反之）→ `warning`，记入 `validation.warnings[]`（不阻断，除非团队后续收紧策略）。

- 通过后写 `stages.prd`：`status=completed`、`validation.passed=true`、`inputs.req_hash`（req.md SHA-256，bootstrap 已写，此处确认一致）、`inputs.prd_spec_hash`（prd-spec.md SHA-256，Agent-A 完成后已写，此处确认一致）、`outputs.client_targets[]`、`outputs.features[]`（跨端聚合结果，**索引真源**）、`outputs.features_hash`（按 `feature_id` 升序后，每条 feature 仅取 `feature_id/name/priority/phase/description/client_targets/dependencies/sources` 八字段，`JSON.stringify` 序列化后的 SHA-256；下游 stage 命中跳过用）、`outputs.features_total`。
- 阶段完成后：`git.auto_commit` / `git.allow_push` 驱动 commit 与 push（见 [git-config.md](../git-config.md)）。

## 日志事件（prd）

> 步骤 3 **Agent-B 按端并发**时：须先打 `agent_batch_start`，每端各打一行 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`（`agent_id` 与 `client_target` 一一对应），批次结束打 `agent_batch_complete`，便于 `run-dash` 按端过滤与排障。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 步骤1：初始化骨架 | `file_created` / `file_skipped` | INFO | `path`（stages.json 中 stages.prd）, `from_template: true` |
| 步骤1：req 哈希比对 | `hash_check` | INFO | `file`（req.md）, `stored_hash`, `computed_hash`, `hit`, `updated_stored: true`（bootstrap 立即将 computed_hash 写入 stages.prd.inputs.req_hash）, `skip_agent_a`（bool） |
| 步骤1：整段跳过（req_hash 命中且 status=completed） | `stage_skipped` | INFO | `reason: "req_hash matched, status=completed"`, `exit_code: 0` |
| 步骤1：拷贝 prd-spec 模板 | `file_created` / `file_skipped` | INFO | `path`（prd-spec.md）, `from_template: true` |
| 步骤2：写 running | `file_updated` | INFO | `path`（stages.json）, `status: "running"` |
| 步骤2：Agent-A 启动 | `agent_start` | INFO | `agent_id: "prd-agent-a"`, `prompt: "prd-spec-author.md"`, `input_files: ["req.md","prd-spec.md"]` |
| 步骤2：Agent-A 跳过 | `agent_skipped` | INFO | `agent_id: "prd-agent-a"`, `reason: "req_hash matched, prd-spec exists"` |
| 步骤2：Agent-A 完成 | `agent_complete` | INFO | `agent_id: "prd-agent-a"`, `duration_ms`, `output_files: ["prd-spec.md"]`, `client_targets_parsed[]` |
| 步骤2：Agent-A 失败 | `agent_failed` | ERROR | `agent_id: "prd-agent-a"`, `exit_code: 4`, `reason` |
| 步骤2：prd-spec 哈希比对 | `hash_check` | INFO | `file`（prd-spec.md）, `stored_hash`, `computed_hash`, `hit`（相对 `prd_spec_hash`） |
| 步骤3：并发批次开始 | `agent_batch_start` | INFO | `batch_id: "prd-agent-b"`, `client_targets[]`, `agents_total`, `agents_skipped[]` |
| 步骤3：单端拷贝 prd 模板 | `file_created` / `file_skipped` | INFO | `client_target`, `path`（prd-<client_target>.json）, `from_template`（专属模板名或 `prd-default`） |
| 步骤3：单端 Agent-B 启动 | `agent_start` | INFO | `agent_id: "prd-agent-b-<client_target>"`, `client_target`, `prompt: "prd-client-author.md"`, `input_files: ["prd-spec.md","prd-<client_target>.json"]`, `template`（所用 json.template 名） |
| 步骤3：单端 Agent-B 跳过 | `agent_skipped` | INFO | `agent_id`, `client_target`, `reason: "prd_spec_hash matched, target files exist"` |
| 步骤3：单端 schema 校验失败 | `agent_retry` | WARN | `agent_id`, `client_target`, `attempt`, `reason`, `invalid_fields[]`, `schema`（如 `prd-web.json.schema.json`） |
| 步骤3：单端 diff 保护拒绝 | `agent_retry` | WARN | `agent_id`, `client_target`, `reason: "existing non-empty fields cleared"`, `cleared_fields[]` |
| 步骤3：单端 Agent-B 完成 | `agent_complete` | INFO | `agent_id`, `client_target`, `duration_ms`, `output_files: ["prd-<client_target>.json","feature_list-<client_target>.md"]`, `features_count` |
| 步骤3：单端 Agent-B 失败 | `agent_failed` | ERROR | `agent_id`, `client_target`, `max_attempts: 2`, `last_error`, `exit_code: 4` |
| 步骤3：并发批次结束 | `agent_batch_complete` | INFO | `batch_id: "prd-agent-b"`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
| 步骤3：backend 写 config.dev | `file_updated` | INFO | `client_target: "backend"`, `path`（config.dev.json）, `fields_written: ["domain","deploy.services","smoke.checks"]` |
| 步骤4：校验通过 | `validation_pass` | INFO | `checks: ["prd-spec.md","prd-<client_target>.json×N","feature_list-<client_target>.md×N","config.dev.json"]` |
| 步骤4：feature 聚合 | `file_updated` | INFO | `path`（stages.json `outputs.features`）, `features_total`, `features_hash`, `client_targets[]` |
| 步骤4：聚合冲突 | `validation_fail` | ERROR | `conflicts[]: [{ feature_id, field, values }]`, `blocking_count`, `warning_count` |
| 步骤4：依赖未知 id | `validation_fail` | ERROR | `feature_id`, `unknown_dependencies[]`, `exit_code: 4` |
| 步骤4：校验失败 | `validation_fail` | ERROR | `missing[]`, `invalid[]` |
| 步骤4：写完成态 | `file_updated` | INFO | `path`（stages.json）, `status: "completed"`, `req_hash`, `prd_spec_hash`, `client_targets[]`, `features_total`, `features_hash` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `client_targets[]`, `features_total` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_client_target`（步骤 3 失败时必填） |

## 退出码（本 stage）

| 码 | 场景 | stages.prd.status |
| ---: | --- | --- |
| 0 | 成功（含 Agent 跳过后校验通过）| `completed` |
| 0 | req_hash 命中且 status=completed（整段跳过） | `completed`（不变） |
| 1 | 缺少 setup 产物、门闸未满足、`stages.json` 写入失败 | `failed` |
| 3 | Agent-A 或任一 Agent-B 超时 | `failed` |
| 4 | Agent/Schema/聚合/依赖校验失败；`blocking_issues` 非空 | `failed` |
| 5 | 检测到 `stop.signal` | `stopped` |

与 [std4 全局退出码表](../std4.md#退出码) 一致。

## 输出

| 路径 | 说明 |
| --- | --- |
| `docs/prd-spec.md` | PRD 总源头 |
| `docs/prd-<client_target>.json` | 各端结构化 PRD（AI 直接消费） |
| `docs/feature_list-<client_target>.md` | 特性表（feature_id、名称、优先级、阶段、涉及端） |
| `docs/config.dev.json` | 部署/smoke 配置初稿 |
| `.pipeline/stages.json` | `stages.prd` 完成态：`outputs.features[]`（**索引真源**，含 `feature_id` / `name` / `priority` / `phase` / `description` / `client_targets[]` / `dependencies[]` / `sources`）、`outputs.features_hash`、`outputs.features_total`、`outputs.client_targets[]` |

## 解锁

`stages.prd.status=completed` 且 `stages.prd.validation.passed=true` 且 `outputs.features[]` 非空 → 可运行 **prd-review**（见 [prd-review.md](prd-review.md#上游门闸)）。

---
