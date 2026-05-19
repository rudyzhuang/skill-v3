# Git 配置（`docs/config.dev.json` → `git`）

[← 规范索引](std4.md)

`docs/config.dev.json` 的 **`git`** 段为流水线 Git 行为的**真源**；`setup` 会将其同步到 `.pipeline/stages.json` → `pipeline.project.git`，供 `merge_push` 等读取。

| 字段 | 类型 | 默认（模板） | 行为 |
| --- | --- | --- | --- |
| `remote` | string | `origin` | `git push` / `git fetch` 的 remote 名 |
| `default_branch` | string | `main` | 初始化与 merge_push 目标分支 |
| `remote_url` | string | `""` | 非空时 `setup` / sync 会 `git remote add/set-url` |
| `auto_commit` | boolean | `false` | `true` 时各 stage 完成（prd / prd-review / design / design-review）后由 `git-stage-sync.cjs` **commit** 跟踪路径 |
| `allow_push` | boolean | `false` | `true` 且在 commit 之后、remote 可用时 **push**（含 `merge_push` 与 `pipeline-recovery`） |

实现：`ai-std4/scripts/libs/git-stage-sync.cjs`（编排）+ `ai-auto3/scripts/lib/git-pipeline-sync.cjs`（底层 commit/push）。

**注意**：仅设 `auto_commit=true` 不会 push；需另设 `allow_push=true` 并配置 remote。
