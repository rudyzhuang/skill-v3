---
name: ai-prd3
version: "0.2.8"
description: >-
  Skill V3 第三代 PRD 与 **AI 自动 prd-review**（不设单独人工签审节点）：维护 docs/prd-spec.md 为唯一总源头，派生各端 prd.md / feature_list.md；
  Agent 按 prompts 产出评审 JSON 后由脚本合并并终检；**门闸结果与分期摘要**汇总在 **.pipeline/reports/prd-implementation-summary.md**（亦可 stdout）。
  在用户提到 ai-prd3、第三代 PRD、Skill V3 prd、prd-review、finalize-prd-review、report 或需执行 bootstrap/validate-prd/write-prd 时使用。
---

# ai-prd3（Skill V3）

## 0. 规范真源（SSOT）

实现与脚本行为以仓库内 **`ai-prd3/docs/spec/prd3.md`** 为唯一规范来源；本 `SKILL.md` 仅保留编排与触发说明。

**ai-soak3 衔接**：`validate-prd` 若输出 **`requires_agent`** / **`functional_requirements_changed`**，须先按 **`prompts/raw-input-impact.md`** 做 **C/O/I/N 分流**（**`prd3.md` §1.5**、**`rfc-soak3-req-fidelity.md` §2.5**）：功能→prd-spec，配置→`config.*`；正交新增不扰动无关 feature；受影响 feature 走 incremental codegen 与双评审。

## 1. 覆盖范围

| 覆盖 | 不覆盖 |
| --- | --- |
| `prd`、`prd-review`（写入 `stages.json` 时键名为 **`prd_review`**） | `design` 及以后各阶段（由 **ai-design3**、**ai-code3**、**ai-publish-***、**ai-auto3** 等负责） |

## 2. 业务项目路径（相对 `<project_root>/`）

| 路径 | 说明 |
| --- | --- |
| `docs/prd-spec.md` | PRD 总源头 |
| `docs/<client_target>/prd.md` | 从 prd-spec 派生 |
| `docs/<client_target>/feature_list.md` | 从 prd-spec 派生 |
| `docs/config.dev.json` / `docs/config.release.json` | 非敏感配置 |
| `docs/config.env` | 仅占位，禁止真实密钥入库 |
| `.pipeline/stages.json` | 门闸真源 |
| `.pipeline/reports/prd-implementation-summary.md` | **prd-review 终检通过**或 **`report`** 生成；含 **「AI 评审门闸结果」** 与分期摘要（`prd3.md` §8.8）；**非**门闸真源 |
| `.agent-sessions/` | 会话日志（应加入 `.gitignore`）；**全流水线 PID 锁等**若未在本 skill 实现，由 **`ai-auto3`** 按 `input-spec.md` 管理 |
| `inputs/` | 原始需求目录（可选）；**`bootstrap`** 收尾对**全项目** `git add -A` 后 **commit+push**（见 **`input-spec.md` §3.5**） |

**允许的 `client_target`**：`website`、`admin`、`backend`、`miniapp`、`mobile`、`desktop`、`agent`。

## 3. 唯一 CLI 入口

在 **本仓库** 中 skill 根目录为 **`ai-prd3/`**（与 `prd3.md` §3 中 `<skill_dir>/scripts/` 布局一致，可拷贝到 `~/.cursor/skills/ai-prd3/` 使用）。**首次使用前**在 **`ai-prd3/`** 目录执行 **`npm install`** 以安装 **AJV**（`prd-review-write-stage` 对 **`templates/schemas/prd-review-output.v1.schema.json`** 做机器校验，见 `prd3.md` §8.3）。

```bash
node ai-prd3/scripts/run.cjs <子命令> --project=<业务项目根绝对路径> [选项]
```

**子命令**（`prd3.md` §4.2）：

| 子命令 | 职责 |
| --- | --- |
| `bootstrap` | 目录与模板拷贝、`stages` 合并、`stages.prd` → `running`；**`stages.prd.outputs.client_targets`** 与 `client_targets.declared` 对齐（§6）；默认仅在缺文件时生成 `docs/<target>/prd.md` / `feature_list.md`，`--force` 时会按当前 `prd-spec` **重写派生文件**，避免 `feature_id_not_in_lists` 漂移 |
| `parse-targets` | stdout 打印 `declared[]`（调试） |
| **`detect-raw-input`** | 比对原始需求哈希（**文件或内联文字**；见 `docs/spec/prd3.md` §1）；输出 `.pipeline/reports/raw-input-drift.json` 与 `impact_hints` |
| **`apply-raw-input-config`** | 从原始需求（文件/内联）解析域名与各端 URL，同步 `config.*.json` 的 **`deploy.services`（website/admin/backend）** 与 `smoke` |
| `validate-prd` | **先** `detect-raw-input`，再串联 spec / derived / config 校验，**不写** completed；失败写 `stages.prd` **failed** |
| `write-prd` | 校验通过后写 **`completed`**、**`validation.required_files[]`** 存在位、**§9.1** `inputs.summary_hash` |
| `validate-prd-review` | 前置门闸 + **终检**；通过写 **§9.2** `prd_review.inputs.summary_hash` 与 **`completed`**；成功后写 **`.pipeline/reports/prd-implementation-summary.md`**（`prd3.md` §8.8） |
| `write-prd-review` | 合并前先校验 `phase_plan.feature_ids` 必须存在于 `docs/<target>/feature_list.md`；并要求 **feature 全集**可被 `phase_plan` / `deferred_features` 完整覆盖且具备优先级；校验通过后再写入 `stages.prd_review`（**不写** `completed` 与 **§9.2** 哈希） |
| **`finalize-prd-review`** | **推荐（Agent 默认）**：`write-prd-review` + `validate-prd-review` 一键串联（须 **`--json=`**）；**不设单独人工签审**；通过后同上自动生成 **report** 文件 |
| `report` | **`prd_review` 已完成**且 **`outputs.decision=passed`** 时：重写 **`.pipeline/reports/prd-implementation-summary.md`** 并 **stdout** 全文 |

**常用选项**：

- `--force`：`write-prd` / `write-prd-review` / **`finalize-prd-review`** 覆盖已完成门闸；**`bootstrap`** 在 **`prd` 已完成**时须加 `--force` 才允许再次执行（`prd3.md` §7.5）。**`bootstrap --force`** 在重置 `prd` 的同时会将 **`prd_review`** 置回未完成态，避免门闸双真源。
- `--allow-fill-missing-keys`：仅 **`bootstrap`**。当 **`docs/config.*.json`** 已存在但相对 skill 模板**缺键**时，做 **additive** 补齐（不覆盖已有键值）；不传则 **退出 1**（`prd3.md` §7.2）。
- `--session-id=<id>`：写入 **`.agent-sessions/ai-prd3.ndjson`** 与 **`.agent-sessions/<id>.log`**（`prd3.md` §11）；亦可设环境变量 **`AI_SESSION_ID`**。
- `--no-timeout` 或环境变量 **`AI_PRD3_NO_TIMEOUT=1`**：禁用子进程超时（冒烟/调试）。
- `--lang=cn|en`：`bootstrap` 选用 prd-spec 模板。
- `--json=<path>`：**`write-prd-review` / `finalize-prd-review`** 的合并输入（绝对路径或相对项目根）。
- **`--raw-input=<path>`**：需求 **Markdown 文件**路径（相对项目根或绝对）；亦可用 **`AI_PRD3_RAW_INPUT`**。
- **`--raw-input-text=<md>`** / **`--raw-input-text-file=<path>`**：**内联 Markdown**（用户对话粘贴）；`@path` 或 text-file 读入后写入 `.pipeline/cache/raw-input.snapshot.md`。
- **`--stdin`**：从标准输入读入内联 Markdown。
- **`AI_PRD3_RAW_INPUT_TEXT`**：环境变量内联 Markdown（优先级低于 CLI）。
- **`--fail-on-change`**：仅 **`detect-raw-input`**；内容相对缓存变更时退出码 **2**。
- **`report`**：`prd_review` 已完成时单独重打摘要；行为见上表（**不参与**门闸）。
- 若 `--json` 里出现 `feature_id_not_in_lists:*`，优先改用项目根 `prd-review-auto.json` 或按 `docs/<target>/feature_list.md` 修正 `phase_plan.feature_ids`，避免把门闸写入无效状态。

**附录 B（密钥扫描）**：`prd-validate-config.cjs` 与 `prd-review-validate.cjs` 使用 `lib/secret-scan.cjs`：读取 `config.dev.json` 的 `security.forbidden_json_key_patterns` 对键名做小写**子串**匹配，并对 string 值跑启发式。模板字段 **`security.env_file_path`**（`.env` 文件相对路径，**非**密钥内容）为推荐键名；遗留 **`secret_env_path`** 与模式定义键名见 `secret-scan.cjs` 白名单，以免与 `prd3.md` §17 字面「子串」规则误杀。

**超时（`prd3.md` §11）**：`run.cjs` 对受控子进程使用 `lib/run-with-timeout.cjs`，默认超时秒数来自 **`docs/config.dev.json` → `timeouts.stages.prd_s` / `prd_review_s`**。超时：**退出码 3**，并写当前阶段 `outputs.timed_out` / `duration_ms` / `timeout_reason`（`lib/stage-status.cjs`）。

**可观测性（`prd3.md` §11）**：`run.cjs` 在子命令起止向 **`.agent-sessions/ai-prd3.ndjson`** 追加 NDJSON；若提供 **`--session-id`**（或 **`AI_SESSION_ID`**），同时追加人类可读行到 **`.agent-sessions/<session_id>.log`**（`lib/session-log.cjs`）。

**prd-spec 漂移**：`prd-validate-spec.cjs` 在 **`stages.prd` 已为 `completed` 且 `validation.passed`** 时，若磁盘 **`prd-spec.md`** 的 SHA-256 与 **`stages.prd.inputs.summary_hash`** 不一致 → **退出 1**（须重跑 `validate-prd` + `write-prd` 或 `bootstrap --force` 后重做 prd）。

## 4. 退出码（`prd3.md` §10）

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 前置失败、解析/校验/结构 JSON/敏感扫描失败等 |
| 2 | 用户中断：**`run.cjs`** 收到 **SIGINT**（Ctrl+C）时 **退出 2** 并写会话日志（`prd3.md` §7.4） |
| 3 | **子命令执行超时**（见 §3） |

## 5. 与下游的衔接话术（`prd3.md` §8.7）

- **prd / prd-review 完成后**：下一步设计阶段请使用 **`ai-design3`**。
- **从 design 起自动跑至 dev deploy + smoke + report**：使用 **`ai-auto3`**（**不**从 prd 起步自动全程）。
- **评审与分期结论（给人看）**：优先打开 **`.pipeline/reports/prd-implementation-summary.md`** 顶部 **「AI 评审门闸结果」**；亦可 `run.cjs report` 重打。

## 6. prd-review 禁止项（`prd3.md` §8.2）

- **不得**把评审意见、讨论纪要默认追加进 **`docs/prd-spec.md`**。
- **不得**把各端 **`prd.md`** 当批注白板；对端调整须走 **`suggested_prd_spec_changes` → 对话中确认后回到 prd 改 prd-spec → 再派生**（**不设**单独「人工签审」节点，但总规变更仍须在对话中显式确认）。
- **不得**把密钥写入 **`config.dev.json` / `config.release.json`**。
- **不得**遗漏 feature：评审前须加载全部 `docs/<target>/feature_list.md`，AI 自动推理后必须为每个 `feature_id` 给出 `phase` 与优先级（或显式 `deferred`）。

## 7. 重跑与 `--force`（§7.5 / §8.6）

覆盖 **`stages.prd_review`** 或已成功阶段时须 **`--force`**（或对话中显式确认后再跑）；脚本侧未带 **`--force`** 且阶段已成功完成时，`write-prd` / `write-prd-review` / **`finalize-prd-review`** / **`bootstrap`（当 prd 已完成）** 均 **退出 1**。

## 8. LLM 提示词

| 文件 | 用途 |
| --- | --- |
| [prompts/prd-spec-author.md](prompts/prd-spec-author.md) | 补全 prd-spec |
| [prompts/derive-per-target.md](prompts/derive-per-target.md) | 按端写 `prd.md` / `feature_list.md` |
| [prompts/prd-review.md](prompts/prd-review.md) | **AI 评审**：产出可合并的 prd-review JSON → **`finalize-prd-review --json=...`** |
| [prompts/raw-input-impact.md](prompts/raw-input-impact.md) | **原始需求变更**：按 `detect-raw-input` 的 `impact_hints` 更新 prd-spec / 派生稿 |

## 9. 冒烟与自检

```bash
cd ai-prd3 && npm install   # 若尚未安装 AJV
node scripts/smoke.cjs
```

`smoke.cjs` **连续跑两轮**主流程与关键负面用例（JSON Schema 拒绝、`conditional_passed` 终检、`prd_spec_drift`、非法端名等）；两轮均须输出 **`smoke: all passed`**。含 **`scripts/self-test-secret-scan.cjs`**（附录 B 键名/值形态用例）。发布前须与 **`docs/templates/`** 同步 `templates/`（`prd3.md` §13）。

## 10. 附录 C（`prd3.md` §18）核对

- [x] Frontmatter：`name`、`version`、`description`（含 **ai-prd3**、第三代 PRD、**AI prd-review**）。
- [x] §0 指向 **`docs/spec/prd3.md`**。
- [x] 覆盖 / 非覆盖阶段。
- [x] I/O 路径表、`run.cjs` 子命令表（含 **`finalize-prd-review`**）、退出码与**超时**、附录 B 调用说明。
- [x] **`--allow-fill-missing-keys`**、**`--session-id` / `AI_SESSION_ID`**、**§11** `.agent-sessions/ai-prd3.ndjson` 与 `<session_id>.log`；**SIGINT → 退出 2**；**prd-spec 漂移**（`validate-prd` 首步）。
- [x] 与 **ai-design3**、**ai-auto3** 衔接话术；禁止项；重跑与 `--force`（含 bootstrap 门闸）。
- [x] **`report`** 与 **§8.8** 摘要路径（含门闸结果小节）、**`validate-prd-review`** / **`finalize-prd-review`** 成功后自动生成。

---

*连续两轮评审（2026-05-17）：`smoke.cjs` round-1/2 全量通过；raw-input 支持文件 + 内联文字（`docs/spec/prd3.md` §1.1）。规格变更请走 `docs/spec/prd3.md`。*
