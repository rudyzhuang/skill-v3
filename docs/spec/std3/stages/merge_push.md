# merge_push 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 将各 feature 的 codegen worktree 分支 **按序合并**入主干并 **push** 远端；合并失败或 push 失败使用专用退出码 **6** / **7**。

## 脚本

```bash
node ai-std3/scripts/stages/merge-push.cjs --project=<业务项目根绝对路径>
```

实现：`ai-std3/scripts/stages/merge-push.cjs`（单脚本 stage，无 Agent）。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.code_review.status=completed` 且 `stages.code_review.outputs.decision ∈ {passed, passed_with_warnings}` 且 `validation.passed=true` |
| **单 feature 可合并** | `stages.codegen.features.<feature_id>.status=completed` 且 `commit` 非空；对应 worktree 存在 |

> 与 [std3 门闸表](../std3.md#2-门闸链汇总) 一致：`decision ≠ failed`（`passed_with_warnings` 允许进入）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.codegen.features.<feature_id>` | `worktree_path`、`branch`（`features/v3-<feature_id>`）、`commit` |
| `stages.prd.outputs.features[]` | 合并顺序参考（可按 `priority` / `feature_id` 排序，实现须稳定） |
| `docs/config.dev.json` | `git.default_branch`（默认 `main`）、`git.remote`（默认 `origin`） |
| 业务仓 Git 工作区 | 干净或可自动 stash；当前分支将切到 `default_branch` |

**代码落位**：合并后各端代码须在 `src/<client_target>/` 下（见 [`input-spec.md`](../../input-spec.md) §3.4），不得落在 V2 根目录 `backend/`、`website/` 等。

## 处理逻辑

1. **门闸、幂等跳过与锁**：
   - 检查上游门闸；不满足 → 退出码 1。
   - **计算 `merge_bundle_hash`**：按 `feature_id` 字典序排列各 codegen 完成 feature 的 `${feature_id}:${commit}` 列表，`JSON.stringify + SHA-256`（hash-of-hashes 方式）。
   - 若 `stages.merge_push.status=completed` 且 `merge_bundle_hash == stages.merge_push.inputs.merge_bundle_hash` → **整段跳过**（写 `stage_skipped`，退出码 0）。
   - 写入 `inputs.merge_bundle_hash = merge_bundle_hash`，写 `stages.merge_push.status=running`。
   - 获取 PID 锁 `.pipeline/locks/merge_push.pid`（防并发 merge）；已有锁则退出码 1 + 原因说明。
2. **准备主干**：`git fetch <remote>`；`git checkout <default_branch>`；`git merge --ff-only <remote>/<default_branch>`（快进对齐，若有本地未提交变更先自动 stash，无法 stash → 退出码 1）。
3. **按 feature 合并**（顺序稳定：P0→P3 再 `feature_id` 字典序）：
   - 对每个 `features/v3-<feature_id>`：先检查 `git merge-base --is-ancestor <commit> HEAD`；若为 ancestor（已在主干）→ 跳过 merge，写入 `already_merged_features[]`。
   - 否则：`git merge --no-ff <branch> -m "feat(<feature_id>): merge codegen implementation"`；成功 → 追加 `outputs.merged_features[]`。
   - 冲突 → `git merge --abort`，中止后续 merge，写 `outputs.conflict_features[]`，`status=failed`，**退出码 6**。
4. **推送**：`git push <remote> <default_branch>`；失败时 `git pull --rebase` 后重试一次；仍失败 → `status=failed`，**退出码 7**。
5. **写 stages**：`status=completed`、`validation.passed=true`、`outputs.merged_features[]`、`outputs.already_merged_features[]`、`outputs.target_branch`、`outputs.final_commit`（合并后 HEAD）、`outputs.conflict_features=[]`；释放 PID 锁。

**停止信号**：检测到 `stop.signal` 时，若 merge 已开始则完成当前 `git merge` 后中止，不写 `completed`，**退出码 5**；`status=stopped`。

## 日志事件（merge_push）

| 步骤 | event | LEVEL | 关键 meta |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at` |
| 步骤1：hash 跳过 | `stage_skipped` | INFO | `reason: "merge_bundle_hash matched"`, `exit_code: 0` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `merge_bundle_hash` |
| 步骤2：准备主干 | `git_checkout` | INFO | `branch: default_branch`, `remote` |
| 步骤3：单 feature 已在主干 | `feature_skipped` | INFO | `feature_id`, `commit`, `reason: "already_merged"` |
| 步骤3：单 feature merge | `git_commit` | INFO | `branch`, `commit_hash`, `feature_id` |
| 步骤3：merge 冲突 | `validation_fail` | ERROR | `conflict_features[]`, `exit_code: 6` |
| 步骤4：push 成功 | `git_push` | INFO | `remote`, `branch`, `status` |
| 步骤4：push 失败 | `git_push_failed` | ERROR | `remote`, `branch`, `error`, `exit_code: 7` |
| 步骤5：写完成态 | `file_updated` | INFO | `status: "completed"`, `final_commit`, `merged_count`, `already_merged_count` |
| stage 完成 | `stage_complete` | INFO | `stage`, `final_commit`, `merged_count`, `exit_code: 0` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason` |

## 退出码（本 stage）

| 码 | 场景 | stages.merge_push.status |
| ---: | --- | --- |
| 0 | 全部 feature 合并并 push 成功 | `completed` |
| 0 | hash 命中整段跳过 | `completed`（不变） |
| 1 | 门闸未满足、工作区不可写 stash 失败、PID 锁占用 | `failed` |
| 5 | `stop.signal` | `stopped` |
| 6 | `conflict_features[]` 非空（merge 冲突） | `failed` |
| 7 | push 失败（权限/网络/保护分支等） | `failed` |

## 输出

| 位置 | 说明 |
| --- | --- |
| git 主干 | 各 feature 分支已 `--no-ff` 合并并推送 |
| `.pipeline/stages.json` | `stages.merge_push`：`inputs.merge_bundle_hash`、`outputs.target_branch`、`outputs.merged_features[]`、`outputs.already_merged_features[]`、`outputs.conflict_features[]`、`outputs.final_commit`、`validation.passed` |

## 解锁

`stages.merge_push.status=completed` 且 `outputs.final_commit` 非空 → 可运行 **build**。

---
