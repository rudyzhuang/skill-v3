# merge_push 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 合并 feature 分支并 push 远端。

## 脚本

`merge-push.cjs`

## 上游门闸

`stages.code_review.status=completed` 且 `outputs.decision ≠ failed`。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.codegen.features[]` | 每个 feature 的 worktree 路径与 feature 分支名 |
| `docs/config.dev.json` | `git.default_branch`（默认 `main`）、`git.remote`（默认 `origin`） |

## 处理逻辑

1. **脚本**：
   - 获取 PID 锁（`merge_push`）防止并发。
   - 对每个 feature 分支（`features/v3-<feature_id>`）：
 - `git fetch origin`。
 - `git checkout <default_branch> && git pull`。
 - `git merge --no-ff features/v3-<feature_id> -m "feat(<feature_id>): merge codegen implementation"`。
 - 若 merge 冲突 → 写 `stages.merge_push.outputs.conflict_features[]`，退出码 **4**（需人工解决后重跑）。
   - 所有 feature 合并完成后 `git push origin <default_branch>`。
   - 若 push 失败（远程有新提交） → `git pull --rebase` 后重试；仍失败 → 退出码 **7**（push failed）。
   - 写 `stages.merge_push`：`status=completed`、`outputs.merged_features[]`、`outputs.target_branch`、`outputs.final_commit`。

## 输出

| 位置 | 说明 |
| --- | --- |
| git 主干 | 所有 feature 分支已合并并推送 |
| `.pipeline/stages.json` | `stages.merge_push`：`target_branch`、`merged_features[]`、`final_commit` |

## 解锁

`stages.merge_push.status=completed` → 可运行 `build`。

---
