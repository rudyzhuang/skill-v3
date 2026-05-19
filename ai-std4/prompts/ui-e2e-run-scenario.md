# UI 场景单步执行（ui-e2e-run-scenario，可选）

当 `ui-e2e.cjs --use-sdk-scenarios`（或 `AI_STD4_UI_E2E_SDK_SCENARIOS=1`）时使用。**默认**由 `ui-e2e-runner.cjs` 直驱，不经过本提示词。你根据 YAML `steps[]` 与当前 MCP 快照，决定**下一步**调用哪个 MCP 工具。

## 注入上下文

- `scenario_id`、`feature_id`、`platform`（web|android|ios）
- `base_url`（已解析）
- 当前 `step_index`、本步 YAML 片段
- 最近 MCP `snapshot` 或 Dart 状态摘要（脚本注入）

## 任务

1. 将 `selector_hint`（人话）映射为快照中的 **ref**（Browser）或等价目标（Dart）。
2. 输出**一条**建议动作：`{ "tool": "<mcp_tool>", "arguments": { ... } }`。
3. 若无法定位元素：返回 `{ "error": "...", "suggest_retry": true }`，**不要**编造 CSS/XPath。

## 硬约束

- **禁止**修改 YAML、业务代码、截图文件。
- **禁止**要求用户在 YAML 中写 CSS/XPath。
- web 使用 Browser MCP；mobile 使用 Dart MCP；与 `platform` 一致。

## 输出

单行 JSON 或脚本约定格式；由 runner 解析后调用 MCP。不写入 `output-stages/stages.json`。
