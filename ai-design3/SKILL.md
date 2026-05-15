---
name: ai-design3
description: >-
  驱动 Skill V3 的 design、contract、design-review 三阶段：门闸校验、登记契约路径、
  AJV 校验设计规格与设计快照、人工审批写回 stages.json。在用户提到 ai-design3、
  设计契约、design-review、或需从 prd-review 之后跑设计与契约流水线时使用。
disable-model-invocation: true
---

# ai-design3

本 skill 的**规范真源**为仓库内 [`docs/spec/design3.md`](../docs/spec/design3.md) 与 [`docs/input-spec.md`](../docs/input-spec.md)；**`stages` 字段形状**以 [`docs/templates/stages.json.template`](../docs/templates/stages.json.template) 为准。脚本与 schema **仅驻留在本目录**（`ai-design3/`），**不**复制到业务仓；**不**读取 v2 的 `pipeline.db` 或旧契约路径。

## 覆盖阶段与顺序（不可跳步）

1. **design**：前置为 `stages.prd_review.status === "completed"` 且 `outputs.decision === "passed"`；本期 `feature_id` 来自 `stages.prd_review.review.phase_plan[*].feature_ids` 并集。
2. **contract**：前置为 design 已完成且 `validation.passed === true`；五类契约产物路径登记在 `stages.contract.outputs.artifacts[]`；机器校验写入 `stages.contract.validation.checks[]`。
3. **design-review**：前置为 contract 机器校验通过且 `human_approval` 为 `approved` 或 `not_required`；**不得**在本阶段静默修改契约文件。

**语义生成**（设计叙述、OpenAPI/TS/SQL 正文、对齐说明）由 Agent 在业务仓内编辑；本子 skill 的 `run.cjs` 只做**门闸、路径登记、确定性校验、写回 `.pipeline/stages.json`**。

## 与上下游 skill 的衔接

| 方向 | 说明 |
| --- | --- |
| 上游 **ai-prd3** | 必须完成 prd-review 且 `decision` 为 `passed` 后，design 子命令才允许推进。 |
| 下游 **ai-code3** | `stages.design_review.outputs.can_enter_codegen` 在 `write-design-review` 成功路径下设为 `true`；codegen 应读取 `inputs.requires_stage` 等字段（见 input-spec）。 |
| **ai-auto3** | contract 的 `human_approval.status === "pending"` 时必须停跑并由人显式调用 `approve-contract` / `reject-contract`；**禁止**在本 skill 内提供默认批准。 |

## 唯一 CLI 入口

```bash
node <skill_dir>/scripts/run.cjs <子命令> --project=<业务项目根绝对路径> [选项…]
```

**依赖**：在 `ai-design3/` 目录执行一次 `npm install`（使用 AJV 加载 `templates/schemas/*.v3.schema.json`）。

**全局选项**（所有子命令解析一致）：

| 选项 | 必填 | 说明 |
| --- | --- | --- |
| `--project=<abs>` | **编排场景必填**；未传时脚本可从 **cwd 向上**探测 `.pipeline/stages.json` 仅作开发便利 | 业务仓库根；落盘与日志以解析结果为准 |
| `--feature=<feature_id>` | 否 | 仅处理单个 feature；省略则处理本期候选并集 |
| `--approved-by=<id>` | 否 | 仅 `approve-contract`：写入 `human_approval.approved_by`（缺省取 `USER` / `USERNAME` 环境变量或空串） |
| `--notes=<text>` | `reject-contract` **必填**；其余审批类子命令可选 | 拒绝/备注 |
| `--force` | 否 | 绕过部分「已完成则跳过」判定（见 design3 §8.3 与 input-spec §4.4 对齐） |
| `--dry-run` | 否 | 仍将计算并更新内存中的 `stages` 对象，但**不写盘**；并向 stdout 打印 `dry_run` JSON 摘要（`slice` 字段） |

### 子命令（名称冻结，与 design3.md §6.1 一致）

| 子命令 | 必备选项 | 职责摘要 |
| --- | --- | --- |
| `preflight` | `--project` | 可读路径、`stages.json` / `_schema`、prd_review 门闸、`config.*.json` 键名扫描（`security.forbidden_json_key_patterns`） |
| `list-design-candidates` | `--project` | stdout 输出 JSON：`feature_id[]` |
| `validate-design` | `--project` | 校验本期 `feature_id` 在至少一个 `docs/<client_target>/feature_list.md` 中有声明（表格行或 `###` 标题）；AJV 校验 `docs/designs/<feature_id>.design.json`；若任一设计文件 `risks[]` 非空则置 `outputs.needs_human_review=true`；更新 `stages.design.validation` |
| `write-design` | `--project` | 在 `validate-design` 已通过前提下写 `stages.design` 完成态与 `outputs.design_specs[]` |
| `hash-design-inputs` | `--project` | 写入 `stages.design.inputs.summary_hash` |
| `register-contract-artifacts` | `--project` | 扫描 `docs/contracts/<feature_id>/` 五类约定文件名，填充 `artifacts[]`（缺任一路径则本子命令失败）；**不**跑 tsc/swagger（design3 §6.1）。若 `design.outputs.needs_human_review===true` 则拒绝（可用 `--force` 绕过）。`--force` 时重置 contract 人工审批与校验占位（对齐 design3 §11 / input-spec 重跑矩阵） |
| `validate-contract` | `--project` | 机器校验：根目录存在 `tsconfig.json` 且含 `.types.ts` 契约时跑一次 `npx tsc --noEmit`；快照 AJV；OpenAPI 头 + 可选 `swagger-cli validate`（超时退出码 **3** 并写 `outputs.timed_out`）；`paths` 级 `x-smoke` 缺失时仅在 `checks[].errors` 中记建议，不把 `api` 标为失败。校验通过且人工未批时 `contract.status=blocked`，通过且已批/免批时 `completed` |
| `approve-contract` | `--project` | `human_approval.status → approved` |
| `reject-contract` | `--project`、`--notes` | `human_approval.status → rejected` |
| `mark-contract-not-required` | `--project` | `human_approval.status → not_required` |
| `hash-contract-inputs` | `--project` | 写入 `stages.contract.inputs.summary_hash` |
| `validate-design-review` | `--project` | 门闸：`human_approval`、`contract.validation.passed`、`contract.status===completed`（可用 `--force` 绕过最后一项）；五类快照路径必填；快照 AJV + 与 `design_specs` 的 `feature_id`/`client_target` 对齐；`gaps` 阻塞计数 |
| `write-design-review` | `--project` | 在 `validate-design-review` 通过后写 `stages.design_review` 完成态 |
| `hash-design-review-inputs` | `--project` | 写入 `stages.design_review.inputs.summary_hash` |

## 退出码（与 input-spec §5 对齐）

| 码 | 含义 | 本子命令典型 |
| --- | --- | --- |
| 0 | 成功 | — |
| 1 | 前置/门闸/缺文件/schema/配置扫描 | `preflight` 失败、`validate-design` 缺规格文件、`validate-contract` 缺产物路径 |
| 2 | 用户取消 | SIGINT |
| 3 | 超时/异常 | `swagger-cli validate` / `tsc --noEmit` 子进程超时（写 `stages.contract.outputs.timed_out`） |
| 4 | 质量门 | AJV/OpenAPI 校验失败、`validate-design-review` 阻塞缺口 |
| 5 | 契约破坏 | 预留 |

**约定**：`validate-design` 若仅 **AJV/内容** 失败 → **4**；若 **缺设计文件** → **1**。`validate-contract`：**缺文件/空路径** → **1**；**内容/OpenAPI 校验失败** → **4**。

## 随 skill 分发的 JSON Schema（§6.2）

路径：`<skill_dir>/templates/schemas/`（大小写敏感）

| 文件 | 校验对象 |
| --- | --- |
| `design-spec.v3.schema.json` | `docs/designs/<feature_id>.design.json` |
| `design-snapshot.v3.schema.json` | `docs/contracts/<feature_id>/<feature_id>.design.snapshot.json` |
| `contract-artifacts-item.v3.schema.json` | `stages.contract.outputs.artifacts[]` 单项 |

## 推荐产物布局（业务仓）

见 design3.md §4：`docs/designs/`、`docs/contracts/<feature_id>/` 与五类文件名。

## 日志

会话日志目录为 **`<project_root>/.agent-sessions/`**（见 input-spec §6）；每个子命令结束时追加一行 NDJSON 至 **`ai-design3.ndjson`**（含 `subcommand`、`exit_code` 等）。

## 批量语义

省略 `--feature` 时，design/contract 相关子命令处理 **`prd_review.review.phase_plan[*].feature_ids` 并集**；与 `--feature=<id>` 联用时，`id` 必须属于该并集。

## 发布前自检（design3 §10）

- [x] frontmatter `name` / `description` 含触发词  
- [x] 三阶段顺序与门闸已写明  
- [x] `run.cjs` 子命令表与 design3 §6.1 一致  
- [x] `templates/schemas/` 三文件齐全  
- [x] 与 ai-prd3 / ai-code3 衔接字段已点名  
- [x] 不复制脚本到业务仓、不读 v2 DB  

---

*实现规划：`docs/spec/design3.md`。首次落地于本仓库 `ai-design3/` 目录，供评审与迭代；未默认安装到 `~/.cursor/skills/`。*
