# ai-design3 规格说明（实现规划稿）

| 属性 | 说明 |
| --- | --- |
| **文档类型** | skill 实现规划（非用户上手教程） |
| **目标读者** | 维护 `ai-design3` 的工程师与 Agent 编排者 |
| **规范层级** | 在 [`docs/input-spec.md`](../input-spec.md) 之下细化本 skill；与模板冲突时以 **`docs/templates/`** 与 **input-spec** 为准并回修本文 |

本文档为 **Skill V3** 中 **ai-design3** 的**独立、完整**实现指引：面向将要编写 `SKILL.md`、CommonJS 脚本与随 skill 分发资源（schema、模板、校验器）的维护者。业务语义与阶段链以仓库内 **[`docs/input-spec.md`](../input-spec.md)** 为真源；字段级契约以 **[`docs/templates/stages.json.template`](../templates/stages.json.template)** 及 config 模板为准。

---

## 1. 定位与范围

### 1.1 skill 名称与覆盖阶段

| 项目 | 约定 |
| --- | --- |
| **skill 名** | `ai-design3` |
| **安装路径（建议）** | `~/.cursor/skills/ai-design3/`（与其它 `ai-*3` 同级） |
| **覆盖阶段** | `design` → `contract` → `design-review`（顺序固定，见 [`input-spec.md`](../input-spec.md) §4.1） |
| **不覆盖** | `prd` / `prd-review`（属 **ai-prd3**）；`codegen` 及之后（属 **ai-code3**） |

### 1.2 与上一版（v2）的关系（仅作经验参考）

| 本版 | 上一版对应 | v3 关键差异 |
| --- | --- | --- |
| **ai-design3** | **ai-design2** + **ai-contract2** + 部分「设计↔契约」核对职责 | 状态真源改为 **`<project_root>/.pipeline/stages.json`**，不再依赖业务仓内 **SQLite**（`design_state` / `contract_state` 等）；脚本**只驻留在 skill 目录**，不复制到业务项目；新增 **`design-review`** 门闸；人工审批与 **ai-auto3** 停跑语义见下文 §8。 |

**不向后兼容**：不读取 v2 的 `.ai-pipeline/pipeline.db`、`contracts/` 旧路径约定、各端 `deployment_plan.json` 等；迁移由一次性脚本或人工完成，见 [`input-spec.md`](../input-spec.md) §9.2–9.3。

### 1.3 与全局文档的分工

| 文档 | 职责 |
| --- | --- |
| [`input-spec.md`](../input-spec.md) | 全流水线业务语义、退出码、超时、门闸总则 |
| [`docs/templates/stages.json.template`](../templates/stages.json.template) | `stages.design` / `stages.contract` / `stages.design_review` 的 JSON 形状 |
| **本文（`design3.md`）** | **仅**细化 ai-design3 的 **`run.cjs` 冻结 CLI**、**AJV schema 文件名**、产物路径建议、状态写回规则与实现检查清单 |

---

## 2. 架构原则（必须遵守）

与 [`input-spec.md`](../input-spec.md) §3.3 一致：

1. **确定性逻辑**（校验、I/O、`stages.json` 读写、子进程、超时、退出码）→ **`<skill_dir>/scripts/*.cjs`**（CommonJS）。
2. **语义生成**（设计叙述、契约草案、缺口说明、给人看的错误解释）→ **LLM prompt**（`SKILL.md` 或 `prompts/*.md`），且**不得**用自然语言「模拟」脚本已承担的校验步骤。
3. **`SKILL.md` 保持轻薄**：触发词、输入输出契约、**脚本入口一览**、边界与退出码；不复述脚本算法。
4. **工作目录**：脚本**必须**接受 `--project=<业务项目根绝对路径>`（或等价长选项），**禁止**依赖 `process.cwd()` 作为项目根的唯一推断（可在未传参时从 cwd 向上探测 `.pipeline/stages.json` 作为开发便利，但落盘与日志必须以解析出的 `project_root` 为准）。
5. **统一对外 CLI**：**仅** `node <skill_dir>/scripts/run.cjs <子命令> --project=<root> [选项…]`；子命令命名以 **§6.1 CLI 冻结表** 为唯一标准（**禁止**再引入第二套对外入口，如另立 `design-cli.cjs`）。

---

## 3. 阶段级输入 / 输出（与 `stages.json` 对齐）

以下键名均指 **`.pipeline/stages.json`** 内 **`stages`** 对象下的子键（文件内为**下划线**形式：`prd_review`、`design_review`）。

### 3.1 design

| 维度 | 约定 |
| --- | --- |
| **前置门闸** | `stages.prd_review.status === "completed"` 且 `stages.prd_review.outputs.decision === "passed"`；本期 `feature_id` 列表来自 `stages.prd_review.review.phase_plan[*].feature_ids` 的并集（未列入本期的 feature **不得**在本轮 design 中处理）。 |
| **主要输入** | `docs/prd-spec.md`；各端 `docs/<client_target>/prd.md` 与 `docs/<client_target>/feature_list.md`；`docs/config.dev.json` / `docs/config.release.json`（非敏感）；`stages.json` 中 prd-review 结论块。 |
| **主要输出** | 每 feature 一份**可机读、可版本管理**的设计规格（见 §5.1），并在 `stages.design.outputs.design_specs[]` 中登记：`feature_id`、`client_target`、**产物路径**、`status`（如 `draft` / `approved` 等，若模板未锁枚举则与实现一致即可）、`shared_changes[]`（跨端共享层变更，见 [`input-spec.md`](../input-spec.md) §8 阶段 3）。 |
| **禁止** | 本阶段**不**生成五种契约终稿（`types` / `api` / `schema` / `test_spec` / `design_snapshot` 文件）；不直接写实现代码。 |
| **完成条件** | `stages.design.status === "completed"` 且 `stages.design.validation.passed === true`；且本期每个目标 feature 在 `design_specs[]` 中均有通过校验的条目。 |
| **`feature.status`** | 经 **`feature-stages.cjs`** 写入 **`stages.design.features[]`**；**仅**在处理该 `feature_id` 时更新（见 [`input-spec.md`](../input-spec.md) §7.1.1）。 |
| **Git（§3.5）** | 该 feature **`completed` 后**调用 **`git-pipeline-sync.syncAfterFeature`**（`inputs/`、`docs/`、`.pipeline/`）。 |

### 3.2 contract

| 维度 | 约定 |
| --- | --- |
| **前置门闸** | design 已完成且校验通过；设计中列出的阻塞项未解除则 **blocked/failed**，不生成契约。 |
| **五类契约（固定）** | 与 [`input-spec.md`](../input-spec.md) §8 阶段 4 表格一致；`stages.contract.outputs.artifacts[]` 每项须含 `feature_id` 与五类字段的**路径字符串**（可相对 `project_root` 或存绝对路径，团队需统一，**推荐**相对路径便于协作）。 |
| **机器校验** | 写入 `stages.contract.validation.checks[]`：`types` / `api` / `schema` / `test_spec` / `design_snapshot`；`validation.checks[].status` 遵守模板枚举（`pending` / `passed` / `failed` / `skipped`）。 |
| **人工审批** | `stages.contract.outputs.human_approval.status`：`pending` →（仅人工或显式子命令）`approved` / `rejected` / `not_required`。**ai-auto3 不得在 `pending` 时自动批准**；应把 `stages.contract.status` 置为 `blocked` 并停自动序列（见 [`input-spec.md`](../input-spec.md) §8 阶段 4）。 |
| **完成条件** | `stages.contract.status === "completed"` 且 `validation.passed === true` 且 `human_approval.status === "approved"`（或规则允许的 `not_required`）。 |
| **`feature.status`** | **`stages.contract.features[]`** 按 feature 记录契约阶段进度；**`human_approval`** 仍为整段 stage 单一对象（不按 feature 审批）。 |
| **Git（§3.5）** | 每个 feature **contract `completed` 后** **commit+push**（同上路径）。 |

### 3.3 design-review

| 维度 | 约定 |
| --- | --- |
| **前置门闸** | contract 产物齐全且机器校验已通过；`human_approval` 已达可进入复核的状态（实现上通常与「已批准」一致，具体以团队门闸为准）。 |
| **主要输入** | design 规格 + 五类契约文件 + contract 校验摘要 + prd-review 本期范围。 |
| **主要输出** | `stages.design_review.outputs.decision`：`pending` / `passed` / `failed` / `needs_design_fix` / `needs_contract_fix`；`gaps[]`、`alignment_summary`、`can_enter_codegen`。 |
| **禁止** | **不**在本阶段静默修改契约文件；缺口只写入 `stages.json` 与可选报告文件，由人决定回到 design 还是 contract。 |
| **完成条件** | `stages.design_review.status === "completed"` 且 `validation.passed === true` 且阻塞性缺口计数为 0（模板字段 `blocking_gaps_count` 等）。 |
| **Git（§3.5）** | 每个 feature **design-review `completed` 后** **commit+push**（同上路径）。 |

---

## 4. 推荐产物目录布局（v3 默认建议）

为实现与教学成本可控，建议在业务仓库内采用**统一契约根目录**（若团队已定其它根路径，skill 内可通过**配置项**覆盖，但须在 `SKILL.md` 写清）：

```text
<project_root>/
  .pipeline/
    stages.json
  docs/
    prd-spec.md
    <client_target>/           # website | admin | backend | ...
      prd.md
      feature_list.md
    contracts/
      <feature_id>/
        <feature_id>.types.ts          # 或 .py 等，与项目语言一致
        <feature_id>.api.yaml          # OpenAPI 3.x，须支持 x-smoke（见 input-spec §8.13）
        <feature_id>.schema.sql        # 或 .prisma / .json
        <feature_id>.test-spec.md      # 或 .yaml
        <feature_id>.design.snapshot.json
    designs/                              # 可选：与 contracts 平级，便于区分「设计」与「契约」
      <feature_id>.design.json            # 或 design.md + design.json 双轨
```

**说明**：

- **`design_snapshot`** 必须与当前 design 规格结构化一致，供 design-review 做 diff/字段级核对；其 JSON Schema 文件名以 **§6.2** 为准（`design-snapshot.v3.schema.json`）。**与 `ai-auto3` 编排对齐**：登记在 **`stages.contract.outputs.artifacts[].design_snapshot`** 的快照 JSON **根对象**须可被 **`docs/spec/auto3.md` §5.7** 读取：**须**含 **`depends_on`**（**`string[]`**，无 feature 间依赖时 **`[]`**），语义与 **`docs/spec/code3.md` §7.5** 一致；并**建议**包含 **`client_targets`**（**`string[]`**，每项 ∈ **`stages.client_targets.allowed_values`**）与可选 **`cross_client`**（**`boolean`**），供 **`docs/spec/auto3.md` §5.7** 划分 **feature group** 与 **P0～P3**；上述键与 **`design-snapshot.v3.schema.json`** 须在演进时**同一 PR 内**同步，避免编排与校验漂移。
- **`api.yaml`** 除常规 OpenAPI 校验外，须满足后续 **ai-publish-dev3** 冒烟对 **`x-smoke`** 的约定（字段形状见 [`input-spec.md`](../input-spec.md) §8.13）。
- **契约根目录**：默认 `docs/contracts/`；可在业务仓 `docs/config.dev.json` 设置 `pipeline.paths.contracts_dir`（**相对**项目根、**不得**含 `..`），`register-contract-artifacts` 与路径登记均使用该值。

---

## 5. 设计规格（`design_specs[]`）建议字段

模板中 `stages.design.outputs.design_specs` 为数组，元素结构未在模板片段中完全展开时，实现阶段应**增补最小可校验 schema**（skill 内 AJV；**磁盘真源** JSON 的 Schema 文件名见 **§6.2** `design-spec.v3.schema.json`），并与 **codegen** 消费方对齐。建议每个元素至少包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `feature_id` | string | 与 `feature_list.md` 中 Feature ID 一致 |
| `client_target` | string | 枚举同 `client_targets.allowed_values` |
| `spec_path` | string | 指向 `docs/designs/...` 或等价路径 |
| `status` | string | 如 `draft` / `ready_for_contract` / `superseded` |
| `file_plan` | object | `new_files[]` / `modify_files[]` / `reuse_existing[]`（与 v2 design_spec 理念对齐，便于 codegen） |
| `api_outline` | array | 路由与方法级草稿（非 OpenAPI 终稿） |
| `data_outline` | array | 表/实体级变更思路 |
| `acceptance` | array | 验收点，应可追溯至 prd / feature_list |
| `constraints` | array | CORS、鉴权、限流、跨端 base URL 等横切项 |
| `dependencies` | array | 外部服务、其它 feature_id |
| `risks` | array | 需人工确认项；非空时可抬升 `outputs.needs_human_review` |
| `shared_changes` | array | 共享层路径及影响说明（见 input-spec §8 阶段 3） |

**与 codegen 的契约**：`file_plan` 应尽量避免多 feature 同时 `modify_files` 指向同一「汇总文件」；沿用 v2 SKILL 中的**插件式注册**最佳实践（流程与反模式说明见本机 `~/.cursor/skills/ai-design2/SKILL.md` 中「集成枢纽、`depends_on` 与合并冲突控制」一节）。**ai-code3** 的 **`codegen.cjs`** 在真实生成实现时，应以 **`design_snapshot`**（契约 **`design_snapshot`** 路径）中的 **`file_plan` / `depends_on` / 路由与验收摘要** 为硬边界，并与 **`stages.contract.outputs.artifacts[]`** 中该 **`feature_id`** 的五类契约路径一起注入 Agent 上下文（详见 **`docs/spec/code3.md` §7.5–§7.9**）。

---

## 6. 脚本与 CLI

- **对外唯一入口**：`scripts/run.cjs`，子命令见 **§6.1**（冻结）。
- **内部实现**：允许拆分为 `scripts/lib/*.cjs`（路径解析、合并 `stages.json`、超时封装、swagger/tsc 子进程等），但**不得**把这些 lib 当作对外 CLI；Agent 与 **ai-auto3** 只应调用 **`run.cjs` + §6.1 子命令**。
- **超时**：`run.cjs` 在分发各子命令时统一套 `docs/config.dev.json.timeouts.stages.*`（见 [`input-spec.md`](../input-spec.md) §6.1），映射 **§7** 退出码。

### 6.1 CLI 冻结表（`run.cjs` 子命令）

**调用形式（唯一标准）**：

```text
node <skill_dir>/scripts/run.cjs <子命令> --project=<业务项目根绝对路径> [选项…]
```

**全局选项（所有子命令解析一致）**：

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| `--project=<abs>` | 是 | 业务仓库根；**禁止**仅靠 cwd 隐式推断为唯一依据 |
| `--feature=<feature_id>` | 否 | 仅处理单个 feature；省略时由实现按「本期候选」批量（批量语义须在 `SKILL.md` 写清） |
| `--approved-by=<id>` | 否 | 仅 **`approve-contract`**：写入 `human_approval.approved_by`（缺省可为空或 `env`/`git` 推导，须在 SKILL 写死） |
| `--notes=<text>` | 条件 | **`reject-contract` 必填**；`approve-contract` / `mark-contract-not-required` 可选 |
| `--force` | 否 | 忽略「已完成则跳过」判定，等价 input-spec §4.4 `--force-rerun` 在单阶段内的收窄实现 |
| `--force-rerun=<stage>` | 否 | `design` \| `contract` \| `design_review`：与 `--force` 组合实现分阶段重跑（实现以 `SKILL.md` 为准） |
| `--dry-run` | 否 | 只打印将执行的操作与将写入的 `stages` 差分，**不落盘**；**不**启用「inputs.summary_hash 未变则整段跳过」 |

**子命令（名称冻结；新增须走文档版本 bump 与 `_schema` 联动评审）**：

| 子命令 | 必备选项 | 职责摘要 | 主要写入 / 更新 `stages` |
| --- | --- | --- | --- |
| `preflight` | `--project` | 路径可读、`stages.json` / `_schema` 支持、**prd_review** 门闸、config 密钥扫描（`forbidden_json_key_patterns`） | 只读；失败退出码 **1** |
| `list-design-candidates` | `--project` | stdout 输出 JSON：本期 `feature_id[]`（来源 `prd_review.review.phase_plan`） | 只读 |
| `scan-design-style` | `--project` | 扫描源码树片段，写 **`docs/designs/<feature_id>.style-scan.json`**，可选回写 `design.json` 的 `style_scan_ref`；更新 `stages.design.validation.warnings` | `stages.design.validation.warnings` |
| `lib-research` | `--project` | 函数域研究：写 **`docs/designs/<feature_id>.lib-research.json`**，回写 **`design.json`** 的 `library_decisions` / `constraints[]`；项目缓存 **`.pipeline/lib-research-cache.json`** | 默认仅写磁盘；`stages` 可由 `--dry-run` 预览 |
| `validate-design` | `--project` | 解析各端 `feature_list.md`、校验 **§6.2** `design-spec.v3.schema.json`（对每个目标 `docs/designs/<feature_id>.design.json`）、blocking 规则 | `stages.design.validation`、`status`（失败时 `failed`） |
| `write-design` | `--project` | 在 `validate-design` 已通过的前提下，写 **`stages.design`** 完成态、`outputs.design_specs[]` 路径与元数据、`duration_ms` 等 | `stages.design` |
| `hash-design-inputs` | `--project` | 计算上游摘要，写 **`stages.design.inputs.summary_hash`** | `stages.design.inputs` |
| `register-contract-artifacts` | `--project` | 扫描 **`docs/contracts/<feature_id>/`** 下五类约定文件名是否存在，填充 **`stages.contract.outputs.artifacts[]`** 路径字段；**不**跑 tsc/swagger | `stages.contract.outputs` |
| `validate-contract` | `--project` | 机器校验：types / OpenAPI / schema / test_spec 结构 / **§6.2** `design-snapshot.v3.schema.json`；子工具失败写入 `validation.checks[]` | `stages.contract.validation`、`status` |
| `approve-contract` | `--project` | **`human_approval.status` → `approved`**，写 `approved_by` / `approved_at` / `notes`；须显式调用（防误触） | `stages.contract.outputs.human_approval` |
| `reject-contract` | `--project`、`--notes=<text>` | **`human_approval.status` → `rejected`** | 同上 |
| `mark-contract-not-required` | `--project` | **`human_approval.status` → `not_required`**（团队策略允许时） | 同上 |
| `hash-contract-inputs` | `--project` | 写 **`stages.contract.inputs.summary_hash`** | `stages.contract.inputs` |
| `validate-design-review` | `--project` | 确定性核对：五类路径齐全、**§6.2** 快照与 design-spec 可对齐、`gaps` / `blocking_gaps_count` 规则；LLM 文本可由 Agent 预写入临时区再由本子命令合并（实现细节放 SKILL） | `stages.design_review.validation`、`outputs`（部分） |
| `write-design-review` | `--project` | 在 `validate-design-review` 已通过的前提下，写 **`stages.design_review`** 完成态、`decision`、`can_enter_codegen` 等 | `stages.design_review` |
| `hash-design-review-inputs` | `--project` | 写 **`stages.design_review.inputs.summary_hash`** | `stages.design_review.inputs` |

**说明**：

- **语义生成**（设计叙述、契约 YAML/TS 正文、对齐说明）仍由 Agent 按 `SKILL.md` 在仓库内直接编辑文件；上表子命令只负责**门闸、登记路径、校验、写回 `stages.json`**，与 [`input-spec.md`](../input-spec.md) §3.3 一致。
- **`contract` 阶段人工审批**为 **整段 stage 单一 `human_approval` 对象**（见 `stages.json.template`），**不**按 feature 多行审批；故 `approve-contract` / `reject-contract` **不得**要求 `--feature`。
- **退出码**：子命令行为与 **§7** 对齐；`validate-*` 未通过时默认 **1**（前置/契约）或 **4**（质量门），须在 `SKILL.md` 用表写死，与 prd3「validate 失败写 `failed`」习惯一致。

### 6.2 AJV 与 JSON Schema 文件名冻结表

以下文件均相对于 **`<skill_dir>/templates/schemas/`**，文件名**大小写敏感**，实现须**内置路径引用**（勿依赖业务仓覆盖同名文件，避免双真源）。

| 文件名 | 校验对象 | 典型调用子命令 |
| --- | --- | --- |
| **`lib-research.v3.schema.json`** | 业务仓 **`docs/designs/<feature_id>.lib-research.json`**（若启用 Agent 产出） | `lib-research`（校验 Agent 输出） |
| **`design-spec.v3.schema.json`** | 业务仓 **`docs/designs/<feature_id>.design.json`**（与 §4 `designs/` 布局一致） | `validate-design` |
| **`design-snapshot.v3.schema.json`** | 业务仓 **`docs/contracts/<feature_id>/<feature_id>.design.snapshot.json`** | `validate-contract`、`validate-design-review` |
| **`contract-artifacts-item.v3.schema.json`** | **`stages.contract.outputs.artifacts[]` 单个元素**（`feature_id` + 五类路径字符串字段名与模板一致） | `register-contract-artifacts`（写回前校验行结构）、`validate-contract`（可选二次校验） |

**非 AJV 的契约校验**（仍由 `validate-contract` 调度，**不设**本表 JSON Schema 名）：

- OpenAPI：**`swagger-cli validate`**（或项目约定等价物）作用于 `*.api.yaml`。
- **types**：`tsc --noEmit` 或项目约定编译检查；纯 Python `types` 无项目级检查时记 `skipped`。
- **schema.sql**：若 PATH 中存在 **`sql-lint`** 则对 `*.sql` 调用；否则仅非空检查。
- **test_spec**：Markdown 轻量规则；YAML 做**语法 parse**（依赖 skill 内 `yaml` 包）；可另增 **`test-spec.v3.schema.json`**——**若增加，须与本表同节增补并升 skill 文档版本**；当前 v0 **冻结集为 §6.2 上表所列 JSON Schema 文件**。

### 6.3 与 v2 习惯的对照

上一版 **ai-design2 / ai-contract2** 的 `run.cjs generate | approve | check` 仅作交互参考；v3 **子命令名称以 §6.1 为准**，状态写入目标为 **`.pipeline/stages.json`**。

---

## 7. 退出码与 `stages.json` 映射

与 [`input-spec.md`](../input-spec.md) §5 一致，ai-design3 对外应遵守：

| 退出码 | 含义 | ai-design3 典型场景 |
| --- | --- | --- |
| 0 | 成功 | 单阶段或串联子流程成功结束 |
| 1 | 前置/兼容/schema/门闸 | 缺文件、prd-review 未 passed、密钥误入 JSON、契约未批却跑 design-review |
| 2 | 用户取消 | SIGINT / 显式 cancel |
| 3 | AI/工具超时或异常 | 阶段超时、Agent 异常；写 `timed_out` / `timeout_reason` / `duration_ms` |
| 4 | 质量门失败 | contract 机器校验失败、design-review 发现阻塞缺口 |
| 5 | 契约破坏 | 一般不在本 skill 主路径；若脚本发现契约被篡改可报 5 |

**投影规则**：进程退出码**不**写入 `stages.json`；由 skill 将语义写入 `stages.<stage>.status`、`validation.passed` 等（见 input-spec §5「退出码与 stages.json 的桥接」）。

---

## 8. 与 ai-auto3 的协作点（实现必读本节）

1. **自动序列起点**：ai-auto3 默认从 **design** 开始（[`input-spec.md`](../input-spec.md) §4.3）；故 ai-design3 必须能在「仅跑 design」或「design → contract → design-review 一次跑完」两种模式下工作。
2. **contract 人工审批停跑**：当 `human_approval.status === "pending"` 时，ai-auto3 将 contract 标为 **blocked** 并停止；用户需通过 **ai-design3** 调用 **`run.cjs approve-contract`** / **`run.cjs reject-contract`**（见 **§6.1**）。**禁止**在 skill 内提供「默认 approve」捷径。
3. **「已完成则跳过」**：实现 §4.4 三条件：`status === "completed"`、`validation.passed === true`、`inputs.summary_hash` 与上游一致；`--force` / `--force-rerun=<stage>` 可绕过。`validate-design` / `validate-contract` 在已写入对应 `inputs.summary_hash` 且重算一致时可**整段跳过**（`--dry-run` 除外，仍完整计算以便打印 `slice`）。
4. **日志**：会话日志写在 **`<project_root>/.agent-sessions/`**（路径与轮转见 input-spec §6）；ai-design3 **自己**追加本阶段日志，不假设 ai-auto3 代写。

---

## 9. 超时与可观测性

- **阶段超时**：`design` / `contract` / `design-review` 默认 **600 s**（[`input-spec.md`](../input-spec.md) §6.1 表）；从 `docs/config.dev.json.timeouts.stages.design_s` 等读取。
- **实现位置**：超时只能在 **cjs** 内（`spawn` + `kill`），不得依赖 LLM。
- **必填**：每阶段结束写 `outputs.duration_ms`；超时写 `timed_out: true`、`timeout_reason`，进程退出码 **3**。

---

## 10. `SKILL.md` 编写清单（发布前自检）

- [x] frontmatter：`name: ai-design3`、`description` 含触发词（如「ai-design3」「设计契约」「design-review」）。
- [x] 明确三阶段顺序及**不可跳步**门闸。
- [x] 列出 **`run.cjs` 全部子命令**（含参数示例），与 **§6.1** 完全一致。
- [x] 随 skill 发布的 **`templates/schemas/`** 下 JSON Schema 与 **§6.2** 文件名一致（**四**文件：`design-spec`、`lib-research`、`design-snapshot`、`contract-artifacts-item`）。
- [x] 说明与 **ai-prd3**（上游）、**ai-code3**（下游）的衔接字段：`design_review.outputs.can_enter_codegen`、`codegen.inputs.requires_stage`。
- [x] 重申：**不**复制脚本到业务仓；**不**读取 v2 `pipeline.db`。

---

## 11. 测试与验收（实现者）

| 用例 | 期望 |
| --- | --- |
| prd-review 未 `passed` 调用 design | 退出码 1，`stages.design.status` 不为 `completed` |
| 本期 feature 部分缺 `feature_list` 行 | 退出码 1，blocking_issues 非空 |
| contract 缺任一类产物文件 | `validation.passed=false`，退出码 4 或 1（与团队对「缺文件」归类一致即可，但须在 SKILL 写死） |
| OpenAPI 无效 | `checks[name=api].status=failed` |
| `human_approval=pending` 时 ai-auto3 模拟 | contract `blocked`，不进入 design-review |
| approve 后全流程 | design-review `decision=passed`，`can_enter_codegen=true` |
| `--force-rerun=contract` | 覆盖 artifacts 与校验状态，human_approval 重置为 `pending`（与 [`input-spec.md`](../input-spec.md) §7.2 重跑矩阵一致） |
| 超时注入 | `timed_out=true`，退出码 3 |

---

## 12. 参考索引（不依赖外链亦可实现）

| 资料 | 路径 |
| --- | --- |
| 业务总规 | [`docs/input-spec.md`](../input-spec.md) |
| 阶段状态模板 | [`docs/templates/stages.json.template`](../templates/stages.json.template) |
| feature 列表模板 | [`docs/templates/feature_list.md.template`](../templates/feature_list.md.template) |
| v2 设计 skill（流程经验） | 本机 `~/.cursor/skills/ai-design2/SKILL.md` |
| v2 契约 skill（generate/approve/check 经验） | 本机 `~/.cursor/skills/ai-contract2/SKILL.md` |

---

## 13. 文档修订

- 若修改 `stages.json.template` 中与本 skill 相关字段，须**同步**更新本文 §3–§5，并按 [`input-spec.md`](../input-spec.md) §9.1 判断是否提升 `_schema.version`。
- 若增删 **`run.cjs` 子命令**或 **`templates/schemas/*.v3.schema.json`**，须**同步**更新 **§6.1–§6.2**，并在 `SKILL.md` 与实现常量中一并修改，避免字符串漂移。
- 本文版本建议页脚维护：`design3.md` revision 与日期（首次撰写：与仓库当前迭代一致即可）。
