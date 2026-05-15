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
| `docs/config.dev.json` / `docs/config.release.json` | 超时、deploy、**`pipeline.autorun.allow_destructive_deploy`** |
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
| `node .../autorun.cjs [run] --project=<abs> [--from-stage=design] [--to-stage=report] [--force-rerun=<stage>] [--session-id=] [--features=id1,id2] [--dry-run]` | 默认 **design → deploy+smoke**（`to-stage=report` 时含 **gen-report**） |
| `node .../autorun.cjs preflight-only --project=...` | 仅 **§5.1 checklist** + **registry upsert** |
| `node .../autorun.cjs sync-registry --project=...` | 仅 **registry** 对齐（**§5.1#8 / §9**） |
| `node .../gen-report.cjs --project=... --session-id=... [--failure-reason=]` | 单独生成报告（通常由 autorun 末尾调用） |

**`--features`**：限定本期 **`ai-code3`** 段使用的 **`feature_id`** 子集（须 ⊆ **`prd_review.phase_plan`**）。

## 子 skill 与 **ai-code3 `--feature`（§5.6）**

- 每次 spawn **`ai-code3`** 均带 **`--feature=<非空>`**；多 id 时为 **`--feature=id1,id2,...`**（**单写者 / 单进程串行**，避免多进程盲写 **`stages.json`**；与 **auto3.md §5.6** 竞态约束一致）。
- **`merge-push` / `build`** 与 **`codegen`** 等同，仍传上述**同一逗号串**。

## deploy 门闸（dev）

当 **`docs/config.dev.json.deploy.enabled === true`** 时，必须 **`pipeline.autorun.allow_destructive_deploy === true`** 才会 spawn **ai-publish-dev3**；否则 **退出码 1**，**不**调用 publish，并在 **report** 正文写明原因（**publish3.md §5.1.1**）。

**手工** dev deploy 仍按 **ai-publish-dev3** 要求使用 **`--explicit-confirm`**；**autorun** 路径使用 **`--invoked-by-autorun`**（由脚本自动传入）。

## **contract** 待审批

若 **`human_approval.status === pending`**，编排将 **`stages.contract.status` → `blocked`** 并停跑；请用 **ai-design3** `approve-contract` / `reject-contract`（**design3.md §8**）。

## 退出码

与 **`input-spec.md` §五** 对齐：子进程非 0 时 **autorun** 透传退出码；总超时映射 **3**。

## **registry.sqlite**

默认 **`~/.cursor/skills/_registry/registry.sqlite`**（与 **ai-auto3** 兄弟的 **`_registry/`**）。可删后由下次 **upsert** 重建。

## 与 **release**

默认序列**不含** **ai-publish-release3**；release 请人工或独立流程触发（见 **input-spec §4.3**）。

## 已知限制（与 auto3.md 对齐说明）

| 项 | 说明 |
| --- | --- |
| **编排层「已完成」捷径** | 对 **design / contract / design_review** 仅用 **`status===completed` + `validation.passed`** 跳过整段宏；**未**在编排层重算 **`inputs.summary_hash`**（子 skill 子命令内部仍会按自身规则跳过）。 |
| **并行多路 ai-code3** | 本实现采用 **单进程** **`--feature=id1,id2,...`** 串行 **`codegen`→`build`**，**不**并行多进程（避免 **`stages.json` 整文件写竞态**）；与 **§5.6** 中「须有无竞态策略」一致。 |
| **编排心跳 tee** | **§8.2** 30s 心跳未在编排 `spawn` 层实现；依赖各子 skill 自身日志。 |

## 参考

- 规格全文：**[SPEC.md](SPEC.md)** → **`docs/spec/auto3.md`**
