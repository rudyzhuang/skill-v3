# UI E2E Agent（Browser / Dart MCP）

环境变量：

- **`AI_E2E3_PROJECT`**：业务项目根
- **`AI_E2E3_UI_E2E_OUTPUT`**：结果 JSON 路径
- **`AI_E2E3_MODE`**：`browser` | `dart`
- **`AI_E2E3_UI_TEST_LOG`**：人话测试日志路径（**必须**追加写入）
- **`AI_E2E3_UI_TEST_SCREENSHOT_DIR`**：截图目录（**`.agent-sessions/ui-test/<feature_id>/`**）

## 人话日志与截图（必做）

在 **`AI_E2E3_UI_TEST_LOG`** 中用中文追加可读记录（每行以本地时间前缀书写亦可，脚本会统一格式）。须写清：

1. **测试用例**：正在执行的场景 ID、步骤摘要。
2. **测试工具**：`cursor-ide-browser`（网页）或 `user-dart`（Android/iOS）。
3. **测试对象**：网页完整 URL，或 Android/iOS 上的应用与设备 ID。

在下列时机**必须**对测试目标截图，保存为 **`AI_E2E3_UI_TEST_SCREENSHOT_DIR` 下的 `*.jpg`**（建议命名：`01-打开后.jpg`、`02-点击后-xxx.jpg`）：

| 时机 | 说明 |
| --- | --- |
| 打开 app / 页面后 | `navigate` 或启动应用完成后 |
| 点击 / 跳转后 | 每次 `click` 或路由变化后 |
| 其他交互后 | `scroll`、`drag`、`swipe`、`fill` 等完成后 |

每次保存截图后，**立即**在人话日志中写一行：**截图绝对路径** + 简要说明（如「登录页打开后」）。

## 结果 JSON

写入 **`AI_E2E3_UI_E2E_OUTPUT`**：

```json
{
  "scenario_id": "...",
  "passed": true,
  "error": "",
  "step_failed": null,
  "screenshots": [
    { "path": "/abs/path/to/01-打开后.jpg", "moment": "打开页面后" }
  ]
}
```

## 其它

1. 使用 **cursor-ide-browser**（web）或 **user-dart**（mobile）按场景 `steps` 执行。
2. 对照 `expect` 断言；失败时写清 `step_failed`。
3. 不得修改 **`docs/contracts/**`**；不得打印密钥。
