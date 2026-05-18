# build 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 按 client_target 执行构建命令。

## 脚本

`build.cjs`

## 上游门闸

`stages.merge_push.status=completed`。

## 输入

| 来源 | 要求 |
| --- | --- |
| 主干最新代码 | `stages.merge_push.outputs.final_commit` 对应 HEAD |
| `docs/config.dev.json` | `build.commands.build`（可按端分别配置）、`build.client_targets[]`、`timeouts.stages.build_s` |

## 处理逻辑

1. 获取 PID 锁（`build`）。
2. 读 `config.dev.json.build.client_targets`（若空则取 `stages.prd.outputs.client_targets`）。
3. 对每个端执行对应构建命令（`runWithTimeout`）。
4. 汇总产物路径列表，按端写入 `stages.build.outputs.artifacts[]`（`client_target`、`artifact_path`、`status`）。
5. 任一端构建失败 → `status=failed`，退出码 **1**。

## 输出

| 位置 | 说明 |
| --- | --- |
| `dist/`（或配置路径） | 各端产物 |
| `.pipeline/stages.json` | `stages.build.outputs.artifacts[]`、`status` |

## 解锁

`stages.build.status=completed` → 可运行 `deploy`。

---
