# smoke 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> HTTP 冒烟检查部署可用性。

## 脚本

`smoke.cjs`

## 上游门闸

`stages.deploy.status=completed` 或 `skipped`（skipped 时 `smoke.checks[]` 须含完整 URL，不能有 `{deploy.*}` 未解析的占位符）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `docs/config.dev.json` | `smoke.checks[]`（含 url、method、expected_status，可选 body_contains） |
| `stages.deploy.outputs.services[]` | 解析 `{deploy.services.*.url}` 占位符 |

## 处理逻辑

1. 合并 config smoke checks 列表（没有 OpenAPI `x-smoke` 机制，直接用 config）。
2. 对每条 check 发 HTTP 请求（GET/HEAD 或标注 `safe=true` 的 POST），校验：
   - 状态码 == `expected_status`（默认 200）。
   - 若 check 含 `body_contains`：校验响应体包含该字符串。
3. 写 `stages.smoke.outputs.checks[]`（url、status_code、passed、body_snippet）。
4. 任一 check 失败 → `stages.smoke.status=failed`，退出码 **4**；超时 → 退出码 **3**。
5. 全部通过 → `status=completed`、`validation.passed=true`。

## 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | `stages.smoke`：`checks[]` 结果、`validation.passed` |

## 解锁

`stages.smoke.status=completed` 且 `validation.passed=true` → 可运行 `ui_e2e`（若启用）；否则直接可运行 `report`。

---
