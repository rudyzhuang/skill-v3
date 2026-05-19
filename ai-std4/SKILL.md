# ai-std4 — 独立全量流水线 Skill

ai-std4 是一个**自包含全量流水线 Skill**，从需求初始化到部署上线全链路自动化，不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 等其他 skill 脚本。

## 触发词

当用户说「ai-std4」「/ai-std4」「全量流水线」「std4 流水线」「run std4」「运行 std4」或要求执行 setup/prd/codegen/deploy 等阶段时使用。

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

# 查看流水线状态看板
node ai-std4/scripts/run-dash.cjs --project=<路径>
```

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
| `.pipeline/` | 锁、`stop.signal`、`worktrees/`、编排 recovery 包等运行时 |
| `.pipeline/logs/` | 全局与各 stage/feature 日志 |

读取 `stages.json` 时兼容旧路径 `.pipeline/stages.json`（只读回退）。

## 规范文档

完整规范见 `docs/spec/std4/std4.md` 及各 stage 文档。

## stage 失败自动修复

`run-pipeline.cjs` 在 stage 可恢复失败（默认退出码 3/4）时，按 [std4 §3.4](docs/spec/std4/std4.md#34-stage-失败后的编排级自动修复run-pipeline) 调用 **pipeline-recovery**：组装错误包（含 worker 摘录 / 错误签名 / recovery_hints）→ Agent 修复 → **self-test-pipeline-recovery.cjs** 门闸 → commit/push → 清理 stale codegen worker → 重跑该 step。按 **(step, exit_code)** 计次。配置见 `docs/config.*.json` → `pipeline.recovery`。
