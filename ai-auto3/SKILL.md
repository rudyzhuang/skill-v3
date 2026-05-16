---
name: ai-auto3
description: >-
  Skill V3 自动编排：自 design 起串联 ai-design3 / ai-code3 / ai-publish-dev3，含 checklist、
  pipeline PID 锁、超时、registry.sqlite、末尾 gen-report。用户说「ai-auto3」「第三代自动编排」
  「autorun」「从设计自动跑到 dev 冒烟」时使用。
disable-model-invocation: true
---

# ai-auto3（第三代自动编排）

**规范真源**：仓库内 [`docs/spec/auto3.md`](../docs/spec/auto3.md) 与 [`docs/input-spec.md`](../docs/input-spec.md)。脚本仅驻留在 **`ai-auto3/scripts/**`**，不复制到业务仓。

## 触发词

「**ai-auto3**」「第三代自动编排」「**autorun**」「从 **design** 自动跑到 **dev deploy + smoke + report**」。

## 前置条件

- **ai-prd3** 已完成 **`prd` + `prd-review`**，且 **`.pipeline/stages.json`** 满足 **auto3.md §5.1**（本脚本 `preflight-only` 可预检）。
- 与 **ai-design3 / ai-code3 / ai-publish-dev3** 安装在同一 **`~/.cursor/skills/`** 根下（兄弟目录），否则子进程 `node .../run.cjs` 无法解析。

## 必读路径（业务项目）

| 路径 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | 编排真源 |
| `docs/config.dev.json` / `docs/config.release.json` | 超时、deploy、**`pipeline.autorun.allow_destructive_deploy`**、**`pipeline.autorun.feature_group_max_parallel`**（**auto3.md §5.7.4**） |
| `docs/config.env` | 密钥（`deploy.enabled=true` 时 Cloudflare 等必填变量须非空） |
| `.agent-sessions/` | 会话日志、**`locks/pipeline.pid`** |

## 一行开跑

```bash
node ~/.cursor/skills/ai-auto3/scripts/autorun.cjs --project=$(pwd)
# 或本仓开发：
node /path/to/skill-v3/ai-auto3/scripts/autorun.cjs --project=/abs/path/to/business/repo
```

**安装依赖**（registry 需要 **SQLite**）：在 **`ai-auto3/`** 目录执行 **`npm install`**（安装 `better-sqlite3`）。

## CLI

| 调用 | 说明 |
| --- | --- |
| `node .../autorun.cjs [run] --project=<abs> [--from-stage=design] [--to-stage=report] [--force-rerun=<stage>] [--session-id=] [--features=id1,id2] [--dry-run]` | 默认按 **Phase 外循环**执行（首期通常 `mvp`）：当前 phase 先做完 `design→design-review`，再并行 code3 至 `deploy+smoke`，然后进入下一 phase（`to-stage=report` 时含 **gen-report**） |
| `node .../autorun.cjs preflight-only --project=...` | 仅 **§5.1 checklist** + **registry upsert**（若检测到 `pipeline.pid` 仅告警，不阻断） |
| `node .../autorun.cjs sync-registry --project=...` | 仅 **registry** 对齐（**§5.1#8 / §9**） |
| `node .../gen-report.cjs --project=... --session-id=... [--failure-reason=]` | 单独生成报告（通常由 autorun 末尾调用） |

**`--features`**：限定本期 **`ai-code3`** 段使用的 **`feature_id`** 子集（须 ⊆ **`prd_review.phase_plan`**）。
对 **ai-design3**（design/contract/design-review）仅在 `--features` 解析后恰好 **1 个 feature_id** 时传 `--feature=<id>`；多 feature 时不下发该参数，避免把逗号串误传给 design3（design3 仅支持单 feature 过滤）。

## 子 skill 与 **ai-code3 `--feature`（§5.6、§5.7）**

- 每次 spawn **`ai-code3`** 均带 **`--feature=<非空>`**；**规格**上 **`autorun.cjs`** 按 **auto3.md §5.7** 将本期 id 分为 **feature group**，**每 group 一次** spawn、**`--feature=<组内 id 逗号列表>`**；**`merge-push` / `build`** 传**本轮 id 全集**。
- `codegen` 阶段新增覆盖校验：若 `stages.codegen.outputs.worktrees[*].feature_id` 未覆盖当前 phase 计划中的全部 `feature_ids`，`autorun` 直接失败并给出缺失列表，避免“部分实现却误报 completed”。
- 启动前先加载全部 `feature_list.md` 做完整性校验：每个 feature 必须进入 `phase_plan` 或显式 `deferred`，否则 preflight 失败。
- `feature_list.md` 解析仅以 `## Features` 段落中的 `Feature ID` 表为准，忽略 `## Metadata` 等其他表，避免把 `Field/schema_name` 这类元数据误判为 feature。
- **组间并行**上限：**`pipeline.autorun.feature_group_max_parallel`**（默认 **3**）。**`merge-push` 前**须等 **`codegen`～`code-review` 全组**成功（**§5.6**）。
- 在**真实 Agent 模式**且未显式配置 `feature_group_max_parallel` 时，`autorun.cjs` 默认按 **1** 串行执行 codegen/typecheck/test/code-review，降低多并发子进程导致的卡住风险；若需并发请在配置中显式给出该值。
- **`stages.json` 多写者竞态**：多路并行时仍须满足 **auto3.md §5.6.2**（单写者合并 / 分片写回 / 或 **`feature_group_max_parallel: 1`** 串行）。
- 在 `design` 宏链路开跑前，`autorun.cjs` 会对 `prd_review.phase_plan` 中缺失的 `docs/designs/<feature_id>.design.json` 做最小 seed（`status=draft`，并补 `client_targets` / `cross_client`），避免 `scan-design-style` 因缺文件直接失败且减少 feature-plan 端型误判噪音。
- `autorun.cjs` 调用 `ai-code3` 时优先探测真实 Agent（优先级：`pipeline.autorun.code3_agent_bin` > `AI_CODE3_AGENT_BIN` > `AI_CODEGEN_AGENT_BIN` > `~/.local/bin/cursor-agent` > `zsh/bash -lc "command -v cursor-agent"`）；探测到后启用真实 codegen，未探测到才降级 stub。
- 未探测到 Agent（或显式 `pipeline.autorun.force_stub_remaining=true`）时，才降级附带 `--stub-remaining` 并注入 `AI_CODE3_SKIP_AGENT=1`；同时仍注入 `AI_CODE3_ALLOW_NO_AGENT_PASS` 与 `AI_CODE3_CODEGEN_CONFIRM=yes` 保持可重跑性。
- 当目标链路包含 `deploy_smoke` 且检测到 `ai-publish-dev3` 缺少 `js-yaml` 时，`autorun.cjs` 会先在 `ai-publish-dev3/` 自动执行一次 `npm install`，避免运行期出现 `x-smoke` 解析被动跳过。
- `feature-plan` 的“contract 无匹配 feature_id”提示在一次 autorun 中会按内容去重，仅首轮输出，避免多阶段重复刷屏。
- `feature-plan` 在 `design_snapshot.client_targets` 缺失时，会回退读取 `docs/<target>/feature_list.md` 推断端型，避免把可识别特性误判为 P3 并刷警告。

## deploy 门闸（dev）

当 **`docs/config.dev.json.deploy.enabled === true`** 时，必须 **`pipeline.autorun.allow_destructive_deploy === true`** 才会 spawn **ai-publish-dev3**；否则 **退出码 1**，**不**调用 publish，并在 **report** 正文写明原因（**publish3.md §5.1.1**）。

**手工** dev deploy 仍按 **ai-publish-dev3** 要求使用 **`--explicit-confirm`**；**autorun** 路径使用 **`--invoked-by-autorun`**（由脚本自动传入）。

## **contract** 待审批

若 **`human_approval.status === pending`**，默认会自动调用 **ai-design3** `mark-contract-not-required` 继续流水线（可在 `docs/config.dev.json` 设 `pipeline.autorun.auto_contract_approval=false` 关闭自动审批并恢复人工门闸）。

## 退出码

与 **`input-spec.md` §五** 对齐：子进程非 0 时 **autorun** 透传退出码；总超时映射 **3**。

## **registry.sqlite**

默认 **`~/.cursor/skills/_registry/registry.sqlite`**（与 **ai-auto3** 兄弟的 **`_registry/`**）。可删后由下次 **upsert** 重建。
除 `projects/pipeline_runs/stage_events` 外，需按项目持久化中间态（`current_phase`、`current_stage`、待处理 feature 队列、phase 结果），以支持中断恢复与多项目隔离。

## 与 **release**

默认序列**不含** **ai-publish-release3**；release 请人工或独立流程触发（见 **input-spec §4.3**）。

## 已知限制（与 auto3.md 对齐说明）

| 项 | 说明 |
| --- | --- |
| **编排层「已完成」捷径** | 对 **design / contract / design_review** 仅用 **`status===completed` + `validation.passed`** 跳过整段宏；**未**在编排层重算 **`inputs.summary_hash`**（子 skill 子命令内部仍会按自身规则跳过）。 |
| **并行多路 ai-code3** | **`autorun.cjs`** 在 **`codegen`～`code-review`** 按 **auto3.md §5.7** 读 **`stages.contract` + `design_snapshot`** 分组，层内受 **`pipeline.autorun.feature_group_max_parallel`** 限制并行 spawn；**`merge-push` / `build`** 仍为**本轮 id 全集**单次调用。多进程写 **`stages.json`** 须遵守 **§5.6.2**（建议 **`feature_group_max_parallel: 1`** 直至 **ai-code3** 分片写回）。 |
| **编排心跳 tee** | **§8.2** 30s 心跳未在编排 `spawn` 层实现；依赖各子 skill 自身日志。 |
| **pipeline 锁预检提示** | `preflight-only` 与 run 前 checklist 对 `pipeline.pid` 仅提示；真正拦截由 `acquirePipelineLock` 原子执行，避免历史锁/竞态导致误阻断。 |

## 参考

- 规格全文：**[SPEC.md](SPEC.md)** → **`docs/spec/auto3.md`**
