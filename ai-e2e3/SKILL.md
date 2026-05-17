---
name: ai-e2e3
version: "0.2.1"
description: >-
  Skill V3 UI 端到端：website/admin 使用 Browser MCP，mobile android/ios 使用 Dart MCP
  与 integration_test；读写 stages.ui_e2e。在用户提到 ai-e2e3、ui-e2e、UI 端到端、
  Browser MCP 测试、Dart MCP 测试时使用。
disable-model-invocation: true
---

# ai-e2e3（UI 端到端）

**规范真源**：**`docs/spec/e2e3.md`**、**`docs/input-spec.md` §8.15**。

## 覆盖阶段

| 阶段 | `stages.json` 键 |
| --- | --- |
| ui_e2e | `ui_e2e` |

**位置**：**ai-publish-dev3** `smoke` 之后、**ai-auto3** `report` 之前（须 **`ui_e2e.enabled===true`**）。

## CLI

```bash
node <skill_dir>/scripts/run.cjs --project=<业务项目根绝对路径> \
  [--dry-run] [--force-rerun] [--session-id=] [--require-ui-e2e] [--invoked-by-autorun]
```

**依赖**：在 **`ai-e2e3/`** 执行 **`npm ci`**（`js-yaml`）。

**环境**：

| 变量 | 说明 |
| --- | --- |
| `AI_E2E3_SKIP_AGENT=1` | **非 strict** 下受限 stub；**须**评估 `expect[]`（见 **`e2e3.md` §4.1**）；**禁止** mobile 无校验即 pass |
| `AI_SOAK3_STRICT=1` | **必须** Browser/Dart MCP 或 integration_test；无 `AI_E2E3_AGENT_BIN` → **退出 1** |
| `AI_E2E3_AGENT_BIN` | 外部 Agent（默认回退 `AI_CODE3_AGENT_BIN`）；soak 重跑前**建议** `which cursor-agent` 验证 |
| `AI_E2E3_SKIP_FIX_AGENT=1` | 禁用失败后 `ui_test_fix` |

## 人话 UI 测试日志

每个场景写入 **`.agent-sessions/ui-test/<feature_id>/<datetime>.log`**，截图 **`.agent-sessions/ui-test/<feature_id>/*.jpg`**（打开页面、点击跳转、其它交互后）；详见 **`e2e3.md` §6.1** 与 **`prompts/ui-e2e-agent.md`**。

## 退出码

| 码 | 含义 |
| ---: | --- |
| 0 | 成功或允许 skip |
| 1 | 前置/配置 |
| 4 | 场景失败 |
| 3 | 超时（预留） |

## 自测

```bash
node ai-e2e3/scripts/smoke.cjs
```
