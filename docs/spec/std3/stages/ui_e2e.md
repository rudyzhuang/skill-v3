# ui_e2e 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> MCP 驱动 UI 端到端场景。

## 脚本

`ui-e2e.cjs`

## 上游门闸

`stages.smoke.validation.passed=true`（或 `ui_e2e.require_smoke_passed=false`）**且** `config.dev.json.ui_e2e.enabled=true`。

若 `ui_e2e.enabled=false` → 整段 skip，退出 0。

## 输入

| 来源 | 要求 |
| --- | --- |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | `create-ui-scenarios` 阶段产出 |
| `stages.deploy.outputs.services[]` | 解析 `{base_url}` 占位符 |
| `docs/config.dev.json` | `ui_e2e.web.*.base_url_from`、`ui_e2e.mobile.*`（设备/bundle_id） |
| MCP | website/admin → **Browser MCP**；mobile → **Dart MCP** / `integration_test` |

## 处理逻辑

1. **脚本（preflight）**：解析每个 feature 的 scenarios，替换 `{base_url}` / `{test_user}`；验证 MCP 可用。
2. **Agent + MCP**：按场景执行：
   - web：Browser MCP 执行 `steps[]`，校验 `expect[]`（`text_present`、`url_contains`、`element_present`）。
   - mobile：Dart MCP 启动 app，执行 `steps[]`，校验 `expect[]`。
   - 截图写 `.agent-sessions/ui-test/<feature_id>/<timestamp>.jpg`，操作记录写 `.agent-sessions/ui-test/<feature_id>/<timestamp>.log`（人话格式）。
3. **修复环**：单场景失败后最多重试 `ui_e2e.commands.ui_test_max_fix_attempts`（默认 3）次；超过则标该场景 `failed`。
4. **脚本（write）**：写 `stages.ui_e2e`：`status=completed|failed`、`outputs.scenarios[]`（id、passed、fix_attempts）、`outputs.report_path`。生成 `.pipeline/reports/ui-e2e-<session>.md`。

## 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/reports/ui-e2e-<session>.md` | 场景级报告 |
| `.agent-sessions/ui-test/<feature_id>/` | 截图 + 人话操作日志 |
| `.pipeline/stages.json` | `stages.ui_e2e`：每场景结果 |

## 解锁

`stages.ui_e2e.status=completed` 或 `skipped` → 可运行 `report`。

---
