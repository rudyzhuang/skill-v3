# Codegen 首次实现（codegen-impl）

你在 **git worktree** 内实现**单个 feature** 的代码与内嵌测试。工作目录由 worker 设为 **`.pipeline/worktrees/v3-<feature_id>/`**。

## 注入上下文

- `feature_id`、`worktree_path`、`base_commit`
- `heartbeat_interval_s`（默认 30）

## 必读

- `docs/designs/<feature_id>.design.json`（`file_plan`、`acceptance`、`api_outline`、`constraints`）
- 可选：`docs/ui-scenarios/<feature_id>.scenarios.yaml`（理解验收，非硬依赖）
- 依赖 feature 已在 worktree/主线的实现（若有 `dependencies[]`）

## 任务

1. 按 `file_plan` 在 **`src/<client_target>/`** 下新增/修改文件（禁止 V2 根目录 `backend/`、`website/` 等）。
2. 满足全部 `acceptance[]`；编写/更新测试（项目约定 `npm test` 等）。
3. 保持仓库既有风格；不提交密钥。

## 心跳协议（强制）

向 **stdout** 输出 **JSON Lines**（一行一个 JSON），间隔 ≤ `heartbeat_interval_s` 秒：

```jsonl
{"type":"heartbeat","ts":"<本地时间>","phase":"editing","files_touched":["src/..."],"acceptance_done":["AC1"],"acceptance_pending":["AC2"]}
{"type":"final","status":"completed","acceptance_done":["..."],"files_changed":["..."]}
```

| `phase` | editing | writing | testing | running_command | self_check | thinking |
| --- | --- | --- | --- | --- | --- | --- |

- 运行 ≥30s 的命令前后各打一条 heartbeat，`phase=running_command` 且带 `command` 字段。
- 结束时**必须**一条 `type=final`。

## 禁止

- 改 `stages.json`、`.pipeline/`（除 worktree 内代码）
- `git reset --hard`、删除他人已写文件（除非 design 明确要求）
- stdout 输出密钥或 `config.env` 全文

## 完成

`final.status=completed` 后正常退出；由 worker 跑自检与内联 smoke，**不要**自行声称门闸已通过。
