# UI E2E Agent（Browser / Dart MCP）

环境变量：

- **`AI_E2E3_PROJECT`**：业务项目根
- **`AI_E2E3_UI_E2E_OUTPUT`**：结果 JSON 路径
- **`AI_E2E3_MODE`**：`browser` | `dart`

要求：

1. 使用 **cursor-ide-browser**（web）或 **user-dart**（mobile）按场景 `steps` 执行。
2. 对照 `expect` 断言；失败时写清 `step_failed`。
3. 将 `{ scenario_id, passed, error, step_failed }` 写入 **`AI_E2E3_UI_E2E_OUTPUT`**。
4. 不得修改 **`docs/contracts/**`**；不得打印密钥。
