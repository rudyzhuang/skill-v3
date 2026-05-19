# ai-std4 — 独立全量流水线 Skill

ai-std4 是一个**自包含全量流水线 Skill**，从需求初始化到部署上线全链路自动化，不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 等其他 skill 脚本。

## 触发词

当用户说「ai-std4」「/ai-std4」「全量流水线」「std4 流水线」「run std4」「运行 std4」、要求执行 setup/prd/codegen/deploy 等阶段、**查看进度/看板**、或**停止/停掉流水线/退出后台进程**时使用。

## 流水线阶段链

```
setup → prd → prd-review → design → design-review
→ create-ui-scenarios → codegen → code-review
→ merge_push → build → deploy → ui_e2e → report
```

## 调用方式

```bash
# 启动完整流水线
node ai-std4/scripts/run-pipeline.cjs --project=<业务项目根路径>

# 单独运行某阶段（如首次 setup）
node ai-std4/scripts/stages/setup.cjs --project=<业务项目根路径>

# 从某阶段续跑
node ai-std4/scripts/run-pipeline.cjs --project=<路径> --from-stage=setup
```

## 运行中操作（Agent 必读）

用户说「查看进度」「卡在哪」「流水线状态」或「停止 / 停掉 std4 / 退出后台」时，**在业务项目根**执行下列命令（勿猜测进程 PID）。

### 查看进度

任选其一（优先 TUI 看板）：

```bash
# 终端看板：阶段 + 逐 feature 状态（run-pipeline 启动时也会自动拉起）
node ai-std4/scripts/run-dash.cjs --project=<业务项目根路径>

# 只读快照（适合在对话里摘要）
cat <业务项目>/output-stages/stages.json
# 兼容旧路径：.pipeline/stages.json

# 排障：最近日志
ls <业务项目>/.pipeline/logs/
```

关注字段：`pipeline.current_stage`、`stages.<stage>.status`、`pipeline.stop_info`（若已请求停止）。

### 停止运行并退出所有后台进程

分两步，**顺序不可颠倒**：

1. **优雅停止**：写入 `stop.signal`，让当前 stage / Agent 在检查点退出（退出码 5）。
2. **收尾进程**：`pipeline-teardown.cjs` 对本 session 登记的 PID（`run-dash`、design/build tick、codegen worker、`.pipeline/locks/*.pid` 等）执行 SIGTERM → 5s → SIGKILL。

```bash
# ① 请求停止（只写信号，不 kill）
node ai-std4/scripts/stop-pipeline.cjs --project=<业务项目根路径> [--reason="用户请求"]

# ② 结束全部子进程与 detached 看板（从 stages.json 取 run_id 作 session-id）
RUN_ID=$(node -e "const s=require('./output-stages/stages.json');console.log(s.pipeline&&s.pipeline.run_id||'')")
node ai-std4/scripts/pipeline-teardown.cjs --project=<业务项目根路径> --session-id="$RUN_ID"
```

或使用一步命令（内部：写 `stop.signal` 后立即 teardown）：

```bash
node ai-std4/scripts/stop-pipeline.cjs --project=<业务项目根路径> --teardown [--reason="用户请求"]
```

说明：

- `stop-pipeline` **单独调用时不 kill**；必须再跑 `pipeline-teardown`（或加 `--teardown`），否则 `run-dash`、codegen worker 等可能仍在后台。
- 续跑：`node ai-std4/scripts/run-pipeline.cjs --project=<路径> --from-stage=<stopped_stage>`（`--from-stage` 会自动清除残留 `stop.signal`）。
- **禁止** teardown 时 `git reset --hard` 或删除 `output-stages/codegen/worktrees/`、`.pipeline/logs/`、`.pipeline/reports/`。

## 环境与 Agent

在业务项目 **`inputs/config.env`**（setup 从 `ai-std4/templates/config.env.template` 拷贝）中配置：

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CURSOR_API_KEY` | 是 | 所有 Agent stage（`@cursor/sdk`） |
| `CURSOR_SKILLS_ROOT` | 否 | Skill 根目录，默认 `~/.cursor/skills` |
| `PIPELINE_MODEL` | 否 | 默认 `composer-2`，同步到 `docs/config.*.json` |

`run-pipeline` 与各 stage 启动时会 `loadProjectEnv` 加载 `docs/config.env`。**不再使用** `AI_STD4_AGENT_BIN`。

**ui_e2e 场景执行**：默认 `ui-e2e-runner.cjs`（web：Playwright/HTTP；mobile：`ui-e2e-dart-runner.cjs` + Flutter/integration_test）。失败分诊仍用 SDK。回退：`--use-sdk-scenarios`。

## 业务项目目录约定

| 路径 | 内容 |
| --- | --- |
| `output-stages/stages.json` | 流水线状态真源 |
| `output-stages/<stage>/` | 各 stage 产出（评审 JSON、摘要 md、deploy 分诊等）；**merge_push** 仍写在 `.pipeline/` |
| `output-stages/codegen/` | codegen worktrees、worker 状态与内联脚本 |
| `.pipeline/` | 锁、`stop.signal`、编排 recovery 包等运行时 |
| `.pipeline/logs/` | 全局与各 stage/feature 日志 |

读取 `stages.json` 时兼容旧路径 `.pipeline/stages.json`（只读回退）。

## 规范文档

完整规范见 `docs/spec/std4/std4.md` 及各 stage 文档。

## stage 失败自动修复

`run-pipeline.cjs` 在 stage 可恢复失败（默认退出码 3/4）时，按 [std4 §3.4](docs/spec/std4/std4.md#34-stage-失败后的编排级自动修复run-pipeline) 调用 **pipeline-recovery**：组装错误包（含 worker 摘录 / 错误签名 / recovery_hints）→ Agent 修复 → **self-test-pipeline-recovery.cjs** 门闸 → commit/push → 清理 stale codegen worker → 重跑该 step。按 **(step, exit_code)** 计次。配置见 `docs/config.*.json` → `pipeline.recovery`。
