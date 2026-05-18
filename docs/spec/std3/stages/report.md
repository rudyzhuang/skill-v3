# report 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 汇总日志与门闸，输出最终报告。

## 脚本

`report.cjs`

## 上游门闸

pipeline 执行到末尾（无论成功/失败均运行，`--failure-reason=` 传入失败原因）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `.pipeline/stages.json` | 所有 stage 的 `status` / `validation` / `outputs` |
| `--session-id=`、`--failure-reason=` | 由 `run-pipeline.cjs` 传入 |

## 处理逻辑

1. **脚本**：推导 `overall`：
   - 任一核心 stage（prd→ui_e2e，**无**独立 smoke；HTTP 冒烟结果见 `stages.codegen.features[].smoke_checks[]` 与 `stages.deploy.outputs.inline_smoke_*`）`status=failed` → `failed`
   - `merge_push.outputs.conflict_features` 非空 → `blocked`
   - 全部 `completed` 或 `skipped` → `success`
   - 否则 `partial`
2. 生成 `.pipeline/reports/autorun-<session_id>.md`（Markdown）：overall、各 stage 摘要表、feature 覆盖列表、失败原因（若有）。
3. 写 `stages.report`：`status=completed`、`outputs.overall`、`outputs.report_path`。

## 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/reports/autorun-<session_id>.md` | 最终报告 |
| `.pipeline/stages.json` | `stages.report.outputs.overall` |

---
