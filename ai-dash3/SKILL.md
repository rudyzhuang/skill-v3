---
name: ai-dash3
description: >-
  Skill V3 流水线看板（只读）：读 `<skills_root>/_runtime/<project_id>/runtime.json 与业务仓 .pipeline/stages.json、reports/、Feature 流水线；
  CLI 或本地 Web（serve）展示进度、阻塞与 ai-auto3 正在跑什么；不 spawn 子 skill、不写 stages、不持锁。
  用户说「ai-dash3」「第三代看板」「流水线看板」「本地网页」「卡在哪」时使用。
disable-model-invocation: true
---

# ai-dash3（第三代看板）

**规范真源**：仓库内 [`docs/spec/dash3.md`](../docs/spec/dash3.md) 与 [`docs/input-spec.md`](../docs/input-spec.md) §4.2.1。脚本仅驻留在 **`ai-dash3/scripts/**`**。

## 触发词

「**ai-dash3**」「**第三代看板**」「**只看进度**」「**流水线卡在哪**」「**dashboard**（Skill V3 语境）」。

## 与 **ai-auto3** 的边界

| **ai-dash3** | **ai-auto3** |
| --- | --- |
| **只读**诊断 + 建议 | **autorun** 自动推进 + **runtime.json** + **PID 锁** + **gen-report** |
| **不**执行 `ai-design3` / `ai-code3` / `ai-publish-*` | **会** spawn 上述 skill |

多项目列表：扫描 **`~/.cursor/skills/_runtime/*/runtime.json`**（见 **`docs/spec/runtime-pipeline.md`**），**不**使用 **`registry.sqlite`**。

## Agent 会话（必读）

用户通过 **`/ai-dash3`**、触发词或「打开看板 / 本地网页」唤起本 skill 时，**不得**仅跑 **`status`** 就结束。须按序执行：

1. **后台**启动 Web（`block_until_ms: 0` 或等价后台方式），**`--project` 用业务仓绝对路径**：

```bash
node ~/.cursor/skills/ai-dash3/scripts/run.cjs serve --open --project=/abs/path/to/project
```

2. 向用户给出终端输出的 **`ai-dash3 web:`** URL（默认 **`http://127.0.0.1:9473/`**）。
3. **可选**：再跑 **`status`** 或 **`json`**，在对话里贴一段 CLI 摘要；**不能**用 CLI 摘要替代 Web。

用户明确只要终端快照（如「不要网页」「只要 status」）时，才仅用 **`status` / `json` / `write-md`**。

## 一行命令（脚本 / 人工）

```bash
node ~/.cursor/skills/ai-dash3/scripts/run.cjs serve --open --project=$(pwd)
```

（**`--project` 必须为业务项目根的绝对路径**；本 skill **零** npm 依赖，**不必** `npm install`。）

## CLI（`dash3.md` §3.3）

| 子命令 | 说明 |
| --- | --- |
| **`status`**（默认） | 人类可读看板 → **stdout** |
| **`json`** | 单行 **JSON** → **stdout**（`dash3.md` §7） |
| **`write-md`** | 写入 **Markdown**；**`--out=`** 默认 **`.pipeline/reports/dash-status.md`** |
| **`serve`** | 启动本地 Web 看板（默认 **`http://127.0.0.1:9473/`**）；**`--port=`**、**`--host=`**、**`--open`**（启动后用系统默认浏览器打开）、可选 **`--project=`** 默认选中项目 |

### 本地 Web 看板

```bash
node ~/.cursor/skills/ai-dash3/scripts/run.cjs serve --open --project=$(pwd)
```

**`--open`** 在 macOS / Linux / Windows 上调用系统命令打开 URL；设 **`AI_DASH3_NO_OPEN=1`** 可禁用。多项目列表来自 **`<skills_root>/_runtime/*/runtime.json`**（**零** npm 依赖）。页面每 3 秒自动刷新；顶栏两个停止按钮（见 **`docs/spec/dash3.md` §7.1**）：

| 按钮 | API | 作用 |
| --- | --- | --- |
| **停止本后台** | **`POST /api/stop-serve`** | 关闭**当前** ai-dash3 **serve** 进程（本页面实例） |
| **停止所有后台任务** | **`POST /api/stop?project=<abs>`** | 经 **ai-auto3** **`stop-pipeline.cjs`** 终止该项目的 autorun / ai-code3 / cursor-agent 等；CLI 等价：`node ~/.cursor/skills/ai-auto3/scripts/stop-pipeline.cjs --project=<abs>` |

## 退出码（`dash3.md` §8）

| 码 | 含义 |
| --- | --- |
| **0** | 成功生成看板（含 **`stages.json` 缺失**时的空态与建议）；**`serve`** 持续运行直至 Ctrl+C |
| **1** | **`status`/`json`/`write-md`**：**`--project` 无效**、**`stages.json` 非法 JSON**、**`write-md` 写失败**；**`serve`**：**`--port` 非法** |

## 参考

- 规格全文：**[`docs/spec/dash3.md`](../docs/spec/dash3.md)**
