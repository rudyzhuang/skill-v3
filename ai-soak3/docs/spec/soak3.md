# ai-soak3 规范（Specification）

> 本文件是 ai-soak3 的**唯一规范真源（SSOT）**。  
> `SKILL.md` 保留编排与触发说明；脚本行为以本文为准。

---

## 1. 概述

**ai-soak3**（Skill V3 Unattended Soak Agent）是一个无人值守的端到端压测代理：

- 在目标业务项目中按状态机顺序执行 `ai-prd3 → ai-auto3`，持续迭代直至全链路门闸通过。
- 发现失败时优先归因 skill（`~/.cursor/skills/`）并修复，不在业务仓打补丁。
- 提供辅助脚本用于监控、诊断、会话健康检查。

---

## 2. 目录布局（Skill 仓内）

```
ai-soak3/
├── SKILL.md                       # 编排与触发说明（Agent 读取）
├── docs/
│   ├── spec/
│   │   └── soak3.md               # 本文件（规范 SSOT）
│   └── templates/
│       └── req-template.md        # inputs/req.md 模板
└── scripts/
    ├── ensure-req.cjs             # req.md 存在性与完整性校验
    ├── check-session-health.cjs   # codegen 会话卡住检测
    ├── diagnose-run.cjs           # 全面运行状态诊断
    └── start-and-monitor.sh      # 启动 autorun 并持续监控
```

---

## 3. 前置条件

| 项 | 说明 |
|----|------|
| **ai-prd3** | 已安装于 `~/.cursor/skills/ai-prd3/` |
| **ai-auto3** | 已安装于 `~/.cursor/skills/ai-auto3/` |
| **inputs/req.md** | 存在于业务项目根目录下（`ensure-req.cjs` 负责校验/生成） |
| **Node.js** | ≥ 18；`node` 可执行 |
| **网络代理** | 外网命令前须 `export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087` |

---

## 4. inputs/req.md 规范（§4）

### 4.1 必填字段

| 字段 | 对应模板标题 | 说明 |
|------|-------------|------|
| **功能需求** | `## 功能需求` | 至少一条非空描述（markdown list 或段落均可） |
| **云平台** | `## 云平台` | 非空，如 `Cloudflare`、`AWS`、`GCP` |
| **鉴权信息** | `## 鉴权信息` | 描述凭证位置（**不写真实密钥**），如 `见 inputs/config.env` |
| **主域名** | `## 主域名` | 非空，如 `notes.yunapp.com` |

### 4.2 校验规则（ensure-req.cjs）

`scripts/ensure-req.cjs --project=<path>` 执行以下逻辑：

1. 若 `inputs/req.md` **不存在**：从 `docs/templates/req-template.md` 拷贝，退出码 **1**，提示用户填写后重试。
2. 若文件存在但**必填字段空缺**（标题存在但内容仅为占位符）：退出码 **2**，列出缺失字段。
3. 所有必填字段已有实质内容：退出码 **0**，继续。

退出码 **0** 时，ai-soak3 才允许执行 §5 的 A 阶段。

---

## 5. 执行状态机

```
Round N:
  prereq-check (ensure-req.cjs)
    ↓ exit=0
  A: ai-prd3  (bootstrap → validate-prd → write-prd → finalize-prd-review)
    ↓ stages.prd + stages.prd_review = completed, decision=passed
  B: ai-auto3  (autorun: design → contract → design-review → codegen → … → report)
    ↓ autorun exit=0, overall≠failed
  §5: 本地轻量确认
    ↓ pass
  §6 检查
    → 全满足 + 连续 2 轮 → 输出证据包，结束
    → 未满足 → C（归因修 skill）→ Round N+1
```

### 5.1 可停止条件（仅三种）

| # | 条件 | 动作 |
|---|------|------|
| 1 | **§6 全满足**（连续 2 轮 A→B→§5 全绿） | 输出最终证据包，结束 |
| 2 | **硬性人工阻塞** | 输出阻塞清单 + 用户唯一操作项 |
| 3 | **上下文/时长耗尽** | 输出未完成项 + 续跑指令块 |

---

## 6. 最终成功判定（SKILL.md §7）

1. **A**：prd + prd_review `passed`，≥20 feature，含 mobile 派生，与 `inputs/req.md` 一致。
2. **B**：autorun 全链路成功，report 无阻塞，stages 与 report 一致。
3. **§5** 本地轻量确认通过（或与 report 结论一致）。
4. 以上**连续 2 轮**均通过。

---

## 7. 辅助脚本规范

### 7.1 ensure-req.cjs

| 参数 | 说明 |
|------|------|
| `--project=<abs>` | 业务项目根目录（必填） |
| `--skill-dir=<abs>` | skill 根目录（默认从脚本位置自动推导） |

**退出码**

| 码 | 含义 |
|----|------|
| 0 | req.md 存在且必填字段全部有实质内容 |
| 1 | req.md 不存在，已从模板创建，等待用户填写 |
| 2 | req.md 存在但必填字段空缺，列出缺失项 |

### 7.2 check-session-health.cjs

| 参数 | 说明 |
|------|------|
| `--project=<abs>` | 业务项目根目录（必填） |
| `--log=<file>` | 指定 autorun 主日志（默认：自动找最新） |
| `--stuck-min=<N>` | 卡住阈值（分钟，默认 15） |

**退出码**

| 码 | 含义 |
|----|------|
| 0 | 无卡住会话 |
| 2 | 检测到卡住会话 |

**副产物**：写 `<project>/.pipeline/reports/session-health.json`

### 7.3 diagnose-run.cjs

| 参数 | 说明 |
|------|------|
| `--project=<abs>` | 业务项目根目录（必填） |

**退出码**：发现问题时 1，否则 0。

**副产物**：写 `<project>/.pipeline/reports/diagnosis.md`

### 7.4 start-and-monitor.sh

```bash
bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh <PROJECT_ROOT> [CHECK_INTERVAL_SEC] [STUCK_MIN]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| PROJECT_ROOT | 必填 | 业务项目根目录 |
| CHECK_INTERVAL_SEC | 180 | 健康检查间隔（秒） |
| STUCK_MIN | 15 | 卡住阈值（分钟） |

**退出码**

| 码 | 含义 |
|----|------|
| 0 | autorun 成功完成 |
| 1 | autorun 失败（非卡住） |
| 2 | 检测到卡住，autorun 已强制停止，需 agent 介入 |

脚本自身通过 `"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` 推导 skill 目录，无需手动传路径。

---

## 8. 错误归因优先级

1. **skill 脚本/文档缺陷** → 改 `~/.cursor/skills/` 对应 skill，冒烟 2 轮后 commit+push。
2. **编排缺陷**（autorun gate 误杀、超时过短）→ 同上。
3. **业务仓配置缺失**（`config.dev.json` 域名/平台字段）→ 可在业务仓补，但**不得**以此绕过门闸。
4. **真实 codegen agent 缺失**（`cursor-agent` 未找到）→ 属 SKILL.md §3 #2 硬性人工阻塞。

---

## 9. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-05-16 | 从 `inputs/agent-prompt.md` 迁出，提升为正式 skill |
