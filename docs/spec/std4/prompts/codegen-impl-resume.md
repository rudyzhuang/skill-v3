# Codegen 恢复实现（codegen-impl-resume）

你在**同一 worktree** 内**续跑**未完成的 feature 实现。上次 attempt 因超时/假死被 worker 中断，进度已快照。

## 必读（顺序）

1. **`.codegen-resume-context.json`**（worktree 根，**最高优先级**）
2. `git log -p <base_commit>..HEAD` 与 `git diff <base_commit>..HEAD`
3. `docs/designs/<feature_id>.design.json`

## 硬约束（来自 context.constraints，不得违反）

- **`do_not_overwrite[]`** 中文件：**仅增量 edit**，禁止清空、整文件重写、删除、重命名。
- **禁止** `git reset --hard`、`git checkout -- <path>`、`rm` 抹除已生成代码。
- **仅完成** `progress.acceptance_pending[]`；`acceptance_done[]` **不要**重复实现。
- 继续遵守 [codegen-impl.md](codegen-impl.md) 的 **JSON Lines 心跳**（间隔 ≤ `heartbeat_interval_s`）。

## 任务

1. 理解 `snapshot_commit` 与 `file_signatures` 所保护的内容。
2. 补齐 pending acceptance 与未完成测试。
3. 结束时输出 `type=final` 的 JSONL。

## 禁止

同 codegen-impl；额外禁止覆盖 `do_not_overwrite[]` 内文件的既有非空逻辑。
