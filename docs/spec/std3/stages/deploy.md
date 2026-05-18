# deploy 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 部署到配置的云平台。

## 脚本

`deploy.cjs`

## 上游门闸

`stages.build.status=completed`。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.build.outputs.artifacts[]` | 产物路径 |
| `docs/config.dev.json` | `deploy.enabled`、`deploy.provider`、服务映射 |
| `docs/config.env` | 云平台凭证（不进 git） |

**Destructive 保护**：autorun 路径须 `config.dev.json.pipeline.autorun.allow_destructive_deploy=true`；手工路径须 `--explicit-confirm`；两者均缺 → 退出码 **1**。

## 处理逻辑

1. 若 `deploy.enabled=false` → 写 `stages.deploy.status=skipped`，退出 0（smoke 仍可用配置 URL 运行）。
2. 否则按 provider（cloudflare/manual/…）执行部署（带 PID 锁、超时、心跳）。
3. 部署成功后把各端 URL 写入 `stages.deploy.outputs.services[]`，供 smoke/ui_e2e 解析。

## 输出

| 位置 | 说明 |
| --- | --- |
| 线上/本地服务 | 依 provider |
| `.pipeline/stages.json` | `stages.deploy`：`environment=dev`、`outputs.services[]`（url、version） |

## 解锁

`stages.deploy.status=completed` 或 `skipped` → 可运行 `smoke`。

---
