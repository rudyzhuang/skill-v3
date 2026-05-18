# merge_push 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 将各 feature 的 codegen worktree 分支 **按序合并**入主干并 **push** 远端；合并失败或 push 失败使用专用退出码 **6** / **7**。

## 脚本

```bash
node ai-std3/scripts/lib/merge-push.cjs --project=<业务项目根绝对路径>
```

实现：`ai-std3/scripts/lib/merge-push.cjs`（单脚本 stage，无 Agent）。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.code_review.status=completed` 且 `stages.code_review.outputs.decision=passed` 且 `validation.passed=true` |
| **单 feature 可合并** | `stages.codegen.features.<feature_id>.status=completed` 且 `commit` 非空；对应 worktree 存在 |

> 与 [std3 门闸表](../std3.md#2-门闸链汇总) 一致：`decision ≠ failed`。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.codegen.features.<feature_id>` | `worktree_path`、`branch`（`features/v3-<feature_id>`）、`commit` |
| `stages.prd.outputs.features[]` | 合并顺序参考（可按 `priority` / `feature_id` 排序，实现须稳定） |
| `docs/config.dev.json` | `git.default_branch`（默认 `main`）、`git.remote`（默认 `origin`） |
| 业务仓 Git 工作区 | 干净或可自动 stash；当前分支将切到 `default_branch` |

**代码落位**：合并后各端代码须在 `src/<client_target>/` 下（见 [`input-spec.md`](../../input-spec.md) §3.4），不得落在 V2 根目录 `backend/`、`website/` 等。

## 处理逻辑

1. **门闸与锁**：检查上游；获取 PID 锁 `.pipeline/locks/merge_push.pid`（防并发 merge）。
2. **准备主干**：`git fetch <remote>`；`git checkout <default_branch>` 并与 `<remote>/<default_branch>` 对齐。
3. **按 feature 合并**（顺序稳定，建议 P0→P3 再 `feature_id` 字典序）：
   - 对每个 `features/v3-<feature_id>`：`git merge --no-ff <branch> -m "feat(<feature_id>): merge codegen implementation"`。
   - 冲突 → 中止后续 merge，写 `outputs.conflict_features[]`，**退出码 6**。
4. **推送**：`git push <remote> <default_branch>`；失败时 `git pull --rebase` 后重试一次；仍失败 → **退出码 7**。
5. **写 stages**：`status=completed`、`validation.passed=true`、`outputs.merged_features[]`、`outputs.target_branch`、`outputs.final_commit`（合并后 HEAD）、`outputs.conflict_features=[]`。
6. **日志**：`git_commit` / `git_push` 或 `git_push_failed`（见 [std3 标准事件](../std3.md#标准事件类型所有-stage-通用)）。

**停止信号**：检测到 `stop.signal` 时，若 merge 已开始则完成当前 `git merge` 后中止，不写 `completed`，**退出码 5**。

## 日志事件（merge_push）

| 步骤 | event | LEVEL | 关键 meta |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at` |
| 单 feature merge | `git_commit` | INFO | `branch`, `commit_hash`, `feature_id` |
| push 成功 | `git_push` | INFO | `remote`, `branch`, `status` |
| push 失败 | `git_push_failed` | ERROR | `remote`, `branch`, `error`, `exit_code: 7` |
| 冲突 | `validation_fail` | ERROR | `conflict_features[]`, `exit_code: 6` |
| stage 完成 | `stage_complete` | INFO | `stage`, `final_commit`, `merged_count` |

## 退出码（本 stage）

| 码 | 场景 |
| ---: | --- |
| 0 | 全部 feature 合并并 push 成功 |
| 1 | 门闸未满足、工作区不可写、锁占用 |
| 5 | `stop.signal` |
| 6 | `conflict_features[]` 非空 |
| 7 | push 失败（权限/网络/保护分支等） |

## 输出

| 位置 | 说明 |
| --- | --- |
| git 主干 | 各 feature 分支已 `--no-ff` 合并并推送 |
| `.pipeline/stages.json` | `stages.merge_push`：`target_branch`、`merged_features[]`、`final_commit` |

## 解锁

`stages.merge_push.status=completed` 且 `outputs.final_commit` 非空 → 可运行 **build**。

---
