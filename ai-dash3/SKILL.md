---
name: ai-dash3
description: >-
  Skill V3 流水线看板（只读）：聚合 .pipeline/stages.json、.pipeline/reports/、可选 pipeline PID 锁提示；
  输出进度表、阻塞摘要与「下一步建议」；不 spawn 子 skill、不写 stages、不持锁。
  用户说「ai-dash3」「第三代看板」「只看流水线进度」「卡在哪」时使用。
disable-model-invocation: true
---

# ai-dash3（第三代看板）

**规范真源**：仓库内 [`docs/spec/dash3.md`](../docs/spec/dash3.md) 与 [`docs/input-spec.md`](../docs/input-spec.md) §4.2.1。脚本仅驻留在 **`ai-dash3/scripts/**`**。

## 触发词

「**ai-dash3**」「**第三代看板**」「**只看进度**」「**流水线卡在哪**」「**dashboard**（Skill V3 语境）」。

## 与 **ai-auto3** 的边界

| **ai-dash3** | **ai-auto3** |
| --- | --- |
| **只读**诊断 + 建议 | **autorun** 自动推进 + **registry** + **PID 锁** + **gen-report** |
| **不**执行 `ai-design3` / `ai-code3` / `ai-publish-*` | **会** spawn 上述 skill |

需要 **本机 registry 对齐**时：请用 **`ai-auto3`** 的 **`sync-registry`**（见 **`docs/spec/auto3.md`**），**不是**本 skill。

## 一行命令

```bash
node ~/.cursor/skills/ai-dash3/scripts/run.cjs status --project=$(pwd)
```

（**`--project` 必须为业务项目根的绝对路径**；本 skill **零** npm 依赖，**不必** `npm install`。）

## CLI（`dash3.md` §3.3）

| 子命令 | 说明 |
| --- | --- |
| **`status`**（默认） | 人类可读看板 → **stdout** |
| **`json`** | 单行 **JSON** → **stdout**（`dash3.md` §7） |
| **`write-md`** | 写入 **Markdown**；**`--out=`** 默认 **`.pipeline/reports/dash-status.md`** |

## 退出码（`dash3.md` §8）

| 码 | 含义 |
| --- | --- |
| **0** | 成功生成看板（含 **`stages.json` 缺失**时的空态与建议） |
| **1** | **`--project` 无效**、**`stages.json` 非法 JSON**、**`write-md` 写失败** |

## 参考

- 规格全文：**[`docs/spec/dash3.md`](../docs/spec/dash3.md)**
