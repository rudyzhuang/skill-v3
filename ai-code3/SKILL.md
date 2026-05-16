---
name: ai-code3
version: "0.3.1"
description: >-
  Skill V3 代码流水线：在业务项目中驱动 codegen、typecheck、test、code-review、merge-push、build；
  状态真源为 .pipeline/stages.json；脚本为 Node CommonJS（.cjs）。
  在用户提到 ai-code3、第三代 codegen～build、合并推送门闸、diff-guard、summary_hash 时使用。
disable-model-invocation: true
---

# ai-code3（Skill V3）

## §0 规范真源（SSOT）

实现与验收以仓库 **`docs/spec/code3.md`** 为唯一规范来源；**「规格全文 vs 当前脚本」对照表**见该文档 **§0.1**。本文件保持轻薄，仅含触发、路径、子命令、退出码与编排衔接。

## 覆盖阶段与非覆盖

| 覆盖 | `stages.json` 键名 |
| --- | --- |
| codegen / typecheck / test / code-review / merge-push / build | `codegen` / `typecheck` / `test` / `code_review` / `merge_push` / `build` |

**不在本 skill**：`prd` / `prd-review` / `design` / `contract` / `design-review`（**ai-prd3**、**ai-design3**）；`deploy` / `smoke` / `report`（**ai-publish-dev3**、**ai-publish-release3**、**ai-auto3**）。

## 上游与下游衔接

- **上游（codegen）**：仅当 **`stages.contract`** 与 **`stages.design_review`** 满足 `docs/spec/code3.md` §7.2 时可执行 codegen。
- **下游**：**ai-publish-dev3** 消费 **`stages.build.outputs.artifacts[]`** 与 **`docs/config.dev.json`** 中的 deploy 映射；测试失败时的续跑入口由 **ai-auto3** 或人工读取 **`rollback_to`** 决定（本 skill 不直接调用上游子 skill）。

## codegen 与 Cursor Agent（规划真源）

- **worktree + 分相 Agent、环境变量、CI 跳过策略、状态字段** 以 **`docs/spec/code3.md` §7.4–§7.12** 为准（对齐上一代 **ai-codegen2**，状态落在 **`stages.codegen.outputs.worktrees[]`** 与 **`outputs.agent`**）。  
- **`codegen.cjs`** 已拆分 **`lib/codegen-worktree.cjs`**、**`lib/codegen-gates.cjs`**、**`lib/codegen-scaffold.cjs`**、**`lib/invoke-codegen-agent.cjs`**；若业务目录尚未初始化 git，codegen 会先自动 `git init` + 初始提交，再进入 worktree 与 diff-guard；**不得**弱化 **diff-guard** 与 **`stages.json`** 原子写。
- 当 `AI_CODE3_SKIP_AGENT=1` 且 `AI_CODE3_ALLOW_NO_AGENT_PASS=yes` 时，codegen 经 **`lib/codegen-health-full-scaffold.cjs`** 按 **`client_targets`** 在 worktree 落盘健康示例（**`src/<client_target>/`**；根级 **`package.json`** 与可选 **`scripts/build.cjs`**），以保证后续 `test/build` 可继续；**禁止**在仓库根落盘 `backend/`、`website/`、`apps/mobile/` 等 V2 端目录。

## 业务项目路径（相对 `<project_root>/`）

| 路径 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | 编排门闸真源 |
| `docs/config.dev.json` | 超时、build、git 等（本实现默认读取） |
| `docs/config.release.json` | 与 dev 结构对齐；可选扫描 |
| `docs/config.env` | 可选；存在时不得在日志中打印完整密钥值 |
| `.agent-sessions/` | 会话日志、锁（应 `.gitignore`） |
| `src/<client_target>/` | 端代码主目录（`website/admin/backend/mobile/desktop/miniapp/agent`）；含各端 `tests/` 子目录 |
| `src/shared/` `src/common/` `src/sdk/` | 允许的共享代码目录（可选） |
| `scripts/` | 项目级构建/编排脚本（如 `build.cjs`）；**非** skill 脚本目录 |

**`client_targets` 允许值**：`website` / `admin` / `backend` / `miniapp` / `mobile` / `desktop` / `agent`。

## CLI 入口

```bash
node <skill_dir>/scripts/run.cjs [子命令] --project=<业务项目根绝对路径> [选项]
```

| 子命令 | 行为 |
| --- | --- |
| （缺省）或 `all` | 自 **codegen** 顺序执行至 **build**（满足「已完成则跳过」三条件时跳过，见 `docs/spec/code3.md` 附录 A · A.3） |
| `preflight` | 校验项目根、`docs/config.dev.json`、`.pipeline/stages.json` 可读、**`_schema.version`**、附录 B 式 **secret-scan**（不写回阶段状态）；可选 **`AI_CODE3_PREFLIGHT_UPSTREAM_GATES=yes`** 预检 **§7.2**；**各阶段业务门闸**由各 `*.cjs` 在执行时校验 |
| `codegen` / `typecheck` / `test` / `code-review` / `merge-push` / `build` | 单阶段；仍执行该阶段前置门闸（`merge-push` 含源码目录落位校验） |
| `clean` / `clean-worktrees` | 仅 **`clean.cjs`**（**不**跑 preflight）；须 **`AI_CODE3_CLEAN_CONFIRM=yes`** |

**常用选项**：`--from-stage=`、`--to-stage=`、`--feature=`（**逗号分隔多 id** 合法）、`--force-rerun=<stage>`、`--dry-run`、`--session-id=`。

**由 ai-auto3 自动编排调用时**：每一次 spawn（含 **`merge-push` / `build`**）**必须**带**非空** **`--feature=`**（`merge-push`/`build` 建议为**本轮 feature id 全集**逗号拼接）；不得以「省略参数走 `phase_plan` 默认全集」作为编排隐式行为。多 feature 并行与 **`merge-push`** 汇合规则见 **`docs/spec/auto3.md` §5.6**、**`docs/input-spec.md` §4.3**。
外部 Agent 为 `cursor-agent` 时，`invoke-ai-code3-agent` 会以非交互参数调用（`--print --trust "<phase prompt>"`），避免无提示词启动导致挂起；`code_review` 相仍需按 `AI_CODE3_CODE_REVIEW_OUTPUT` 写出 JSON。

**`--stub-remaining`**：在完成 **test** 之后，将 **code-review / merge-push / build** 以占位字段写回 `stages.json`（供本仓结构冒烟）；**不得**用于真实合码与发版。

**`codegen` 覆盖已放行结果**：若 **`stages.codegen`** 已为 **`completed`** 且 **`validation.passed=true`**，再次执行 codegen（非 dry-run、且未被「跳过」短路）须设置 **`AI_CODE3_CODEGEN_CONFIRM=yes`**，否则 **退出 1** 并写 **`blocked`**（`input-spec.md` §7.2 / `code3.md` §6 overwrite）。

**外部 Agent 统一环境**（**`AI_CODE3_AGENT_BIN`** / **`AI_CODEGEN_AGENT_BIN`**）：**`AI_CODE3_PHASE`**（`impl` | `test` | `test_fix` | `code_review`）、**`AI_CODE3_WORKTREE`**、**`AI_CODE3_PROJECT`**、可选 **`AI_CODE3_FEATURE_ID`**；**code_review** 相须将 JSON 写入 **`AI_CODE3_CODE_REVIEW_OUTPUT`**（见 **`prompts/code-review-agent.md`**）。stderr 约定含 **`failed_stage=`** 与（多 feature 时）**`feature_id=`**。

```bash
node ai-code3/scripts/self-test-secret-scan.cjs
node ai-code3/scripts/self-test-merge-push.cjs
node ai-code3/scripts/self-test-test-level-gate.cjs
node ai-code3/scripts/smoke.cjs
```

`smoke.cjs` 会：在 **`ai-code3/`** 目录执行 **`npm ci`**（安装 **ajv** 等依赖）；依次跑 secret-scan、**merge-push（真实 git）** 自测、**`self-test-clean.cjs`**、**`self-test-preflight-upstream.cjs`**、**`self-test-test-level-gate.cjs`**；再将 fixture 复制到临时目录并执行 `preflight` + `all --stub-remaining`。

自动化门禁与两轮全量评审见 **`docs/spec/code3.md` §16.1**（须与上表四条自测命令一致）。

`test` 阶段支持可选测试层级门禁：优先读取 contract `test_spec.required_test_levels`（`unit` / `integration` / **`ui_e2e`**），并由 `docs/config.dev.json` 的 `build.test_level_gate.mode`（`off` / `warn` / `enforce`）控制；`ui_e2e` 层接受 **`ui_scenarios[]`** 或 `tests/e2e`/`integration_test` 文件；**Browser/Dart MCP 执行**在 **ai-e2e3**（deploy 后）。`test_spec` 未声明时可回退 `build.test_level_gate.fallback_required_test_levels`。

## 退出码（与 `docs/input-spec.md` §5 一致）

| 码 | 含义 |
| ---: | --- |
| 0 | 成功 |
| 1 | 前置/schema/门闸/配置缺失/锁占用 |
| 2 | 用户取消（占位；由调用方注入） |
| 3 | 超时或可重试外部失败 |
| 4 | 质量门（typecheck / test / code-review / build） |
| 5 | 契约 diff-guard 失败 |
| 6 | Git 合并冲突 |
| 7 | Git 推送失败 |
| 8 | 云 API（本 skill 默认不应触发） |

失败时 stderr / 日志须含 **`failed_stage=codegen|typecheck|...`**。

## typecheck：工具全部未探测（T1 定稿）

当**未执行任何**静态检查工具（全部 `skipped` / 工具缺失）时：**退出 0**，并在 **`stages.typecheck.outputs.skip_reason`** 写明原因（与 `docs/spec/code3.md` §16「全 skip」用例一致）。任一已执行工具非 0 → **退出 4**。

## 禁止项

- 不修改契约产物目录（codegen 以 diff-guard 守护）。
- 不隐式执行 deploy / smoke。
- 不并行多进程抢写 **`stages.json`**（同 scope 锁见脚本实现）。
- **`code-review` 不得**篡改 **`stages.test`** / **`typecheck`** / **`codegen`** 的通过性字段。
- **`merge-push` 后源码落位必须合规**：源码文件需位于 `src/<client_target>/` 或共享目录（`src/shared|common|sdk`）；否则记为失败并阻断进入 build。

## 附加资源

- 完整算法、哈希算法、`stages.json` 子集、附录 A–C：**[SPEC.md](SPEC.md)** → **`docs/spec/code3.md`**
- 模板真源指针：**[templates/README.md](templates/README.md)**
