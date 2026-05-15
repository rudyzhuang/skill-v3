---
name: ai-code3
version: "0.2.0"
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
- **`codegen.cjs`** 过渡实现完成后，应拆分 **`lib/codegen-scaffold.cjs`**、**`lib/invoke-codegen-agent.cjs`**（规划名），**不得**弱化 **diff-guard** 与 **`stages.json`** 原子写。

## 业务项目路径（相对 `<project_root>/`）

| 路径 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | 编排门闸真源 |
| `docs/config.dev.json` | 超时、build、git 等（本实现默认读取） |
| `docs/config.release.json` | 与 dev 结构对齐；可选扫描 |
| `docs/config.env` | 可选；存在时不得在日志中打印完整密钥值 |
| `.agent-sessions/` | 会话日志、锁（应 `.gitignore`） |

**`client_targets` 允许值**：`website` / `admin` / `backend` / `miniapp` / `mobile` / `desktop` / `agent`。

## CLI 入口

```bash
node <skill_dir>/scripts/run.cjs [子命令] --project=<业务项目根绝对路径> [选项]
```

| 子命令 | 行为 |
| --- | --- |
| （缺省）或 `all` | 自 **codegen** 顺序执行至 **build**（满足「已完成则跳过」三条件时跳过，见 `docs/spec/code3.md` 附录 A · A.3） |
| `preflight` | 校验项目根、`docs/config.dev.json`、`.pipeline/stages.json` 可读、**`_schema.version`**、附录 B 式 **secret-scan**（不写回阶段状态）；**各阶段业务门闸**由各 `*.cjs` 在执行时校验 |
| `codegen` / `typecheck` / `test` / `code-review` / `merge-push` / `build` | 单阶段；仍执行该阶段前置门闸 |

**常用选项**：`--from-stage=`、`--to-stage=`、`--feature=`、`--force-rerun=<stage>`、`--dry-run`、`--session-id=`。

**`--stub-remaining`**：在完成 **test** 之后，将 **code-review / merge-push / build** 以占位字段写回 `stages.json`（供本仓结构冒烟）；**不得**用于真实合码与发版。

**`codegen` 覆盖已放行结果**：若 **`stages.codegen`** 已为 **`completed`** 且 **`validation.passed=true`**，再次执行 codegen（非 dry-run、且未被「跳过」短路）须设置 **`AI_CODE3_CODEGEN_CONFIRM=yes`**，否则 **退出 1** 并写 **`blocked`**（`input-spec.md` §7.2 / `code3.md` §6 overwrite）。

**`merge-push` 强制重跑**：`--force-rerun=merge_push` 时必须同时设置环境变量 **`AI_CODE3_MERGE_CONFIRM=yes`**，否则 **退出 1**（destructive explicit confirm，`input-spec.md` §7.2）。

## 冒烟自测（本仓）

```bash
node ai-code3/scripts/self-test-secret-scan.cjs
node ai-code3/scripts/self-test-merge-push.cjs
node ai-code3/scripts/smoke.cjs
```

`smoke.cjs` 会依次跑 secret-scan、**merge-push（真实 git）** 自测，再将 fixture 复制到临时目录并执行 `preflight` + `all --stub-remaining`。

分阶段实施与两轮评审门禁见 **`docs/plans/ai-code3-implementation-plan.md`**。

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

## 附加资源

- 完整算法、哈希算法、`stages.json` 子集、附录 A–C：**[SPEC.md](SPEC.md)** → **`docs/spec/code3.md`**
- 模板真源指针：**[templates/README.md](templates/README.md)**
