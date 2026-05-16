# ai-soak3 规范（Specification）

> 本文件是 ai-soak3 的**唯一规范真源（SSOT）**。  
> `SKILL.md` 保留编排与触发说明；脚本行为以本文为准。

---

## 1. 概述

**ai-soak3**（Skill V3 Unattended Soak Agent）是一个无人值守的端到端压测代理：

- 目标是让业务项目**真正跑通**：服务端部署上线、mobile 编译安装到模拟器、所有端测试通过。
- 在目标业务项目中按状态机顺序执行 `ai-prd3 → ai-auto3 → §6 部署与端完整验证`，持续迭代。
- 发现失败时，**先评估能否通过优化 v3 skill 解决**，可以则改 skill；不行才直接修业务代码；两条路都走不通才判定为不可解阻塞。
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
| **Flutter**（mobile 端） | `flutter doctor` 通过，且有可用模拟器（Android Emulator 或 iOS Simulator） |
| **macOS**（iOS 端） | 编译 iOS 目标须 Darwin 系统；非 macOS 仅支持 Android 目标 |
| **网络代理** | 外网命令前须 `export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087` |

---

## 4. inputs/req.md 规范

### 4.1 必填字段

| 字段 | 对应模板标题 | 说明 |
|------|-------------|------|
| **功能需求** | `## 功能需求` | 至少一条非空描述（markdown list 或段落均可） |
| **云平台** | `## 云平台` | 非空，如 `Cloudflare`、`AWS`、`GCP` |
| **主域名** | `## 主域名` | 非空，如 `notes.yunapp.com` |
| **鉴权信息** | `## 鉴权信息` | 描述凭证位置（**不写真实密钥**），如 `见 inputs/config.env` |

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
  prereq-check (ensure-req.cjs exit=0)
    ↓
  A: ai-prd3  (bootstrap → validate-prd → write-prd → finalize-prd-review)
    ↓ stages.prd + stages.prd_review = completed, decision=passed
  B: ai-auto3  (design → contract → design-review → codegen → merge-push → build → deploy+smoke → report)
    ↓ autorun exit=0, overall≠failed
  §6: 部署与端完整验证
    ↓ backend URL 可达 + website build + mobile 编译+模拟器安装冒烟
  §7 检查
    → 全满足 + 连续 2 轮 → 输出证据包，结束（条件 1）
    → 失败 → C（§5.1 失败处理链） → Round N+1
    → 不可解阻塞（§5.2）→ 输出阻塞详情，等待人工介入（条件 2）
    → 上下文耗尽 → 输出续跑块（条件 3）
```

### 5.1 失败处理链

1. **取证**：完整读 autorun report、stages 对应阶段、codegen 会话日志。
2. **归因与 skill 评估**：
   - 直接 skill 问题（门闸误杀、编排 bug、模板缺失）→ 改 skill。
   - 表面是业务代码/测试/配置问题：**评估**优化 v3 skill 是否可防止此类失败：
     - 可以 → 改 skill。
     - 不行 → 修业务代码。
     - 两条路都不通 → 判断 §5.2。
3. **skill 改动**：冒烟连续 2 轮 → commit+push。
4. **Round N+1**：同一对话内立即重跑。

### 5.2 不可解阻塞定义

以下情况允许停止等待人工介入（**必须提供明确证据**）：

| 类型 | 判定条件 | 所需证据 |
|------|---------|---------|
| **云平台鉴权失败** | deploy 输出含明确 401/403/权限拒绝，凭证需用户更新 | 具体错误日志 + 需更新的字段名（如 `CLOUDFLARE_API_TOKEN`） |
| **非 macOS / 无法编译 iOS** | `uname -s` ≠ `Darwin` 且项目含 iOS 目标 | `uname -s` 输出 + flutter iOS 报错；Android 不受影响可继续 |
| **AI 确认无法自动解决** | 至少 **2 次**不同修复尝试后仍无法解决 | 已尝试方法列表 + 每次失败输出 + 无法解决的原因 |

**不允许**以「可能有问题」「需要人工确认」等模糊表述宣布阻塞。

---

## 6. 部署与端完整验证（SKILL.md §6）

### 6.1 Backend（若声明了 backend 端）

- `stages.deploy.status = completed`，且 URL 可访问（`curl -i` 2xx/3xx）。
- `allow_destructive_deploy=false`：记录「deploy 跳过（配置禁用）」，不算失败。
- deploy 失败且非鉴权 → §5.1 处理。
- deploy 失败且为鉴权错误 → §5.2。

### 6.2 Website（若声明了 website 端）

- `stages.build` 对应 website `completed`。
- deploy URL 可访问，或 dev server 本机可访问。

### 6.3 Mobile（若声明了 mobile 端）

1. **build 成功**：`stages.build` 对应 mobile `completed`，或 `flutter build apk/ios --simulator` 返回 0。
2. **环境检查**：
   - `uname -s = Darwin`：可编译 iOS/Android。
   - `uname -s ≠ Darwin`：只能 Android；含 iOS 目标 → §5.2。
3. **模拟器安装冒烟**：启动可用模拟器 → `flutter run -d <emulator_id>` → 30s 内不崩溃 → pass。
4. 若有 `integration_test/`：`flutter test integration_test/ -d <emulator_id>` 通过。
5. 崩溃或测试失败 → §5.1 处理（非立即阻塞）。

---

## 7. 最终成功判定

1. **A**：prd + prd_review `passed`，≥20 feature，`client_targets` 与 `inputs/req.md` 一致。
2. **B**：autorun 全链路成功，report 无阻塞，stages 与 report 一致。
3. **§6**：所有声明端验证通过（backend deploy 可达，website 可访问，mobile 编译+模拟器冒烟通过），或有合理跳过记录。
4. 以上**连续 2 轮**（A→B→§6）均通过。

---

## 8. 辅助脚本规范

### 8.1 ensure-req.cjs

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

### 8.2 check-session-health.cjs

| 参数 | 说明 |
|------|------|
| `--project=<abs>` | 业务项目根目录（必填） |
| `--log=<file>` | 指定 autorun 主日志（默认：自动找最新） |
| `--stuck-min=<N>` | 卡住阈值（分钟，默认 15） |

**退出码**：0=无卡住 / 2=检测到卡住  
**副产物**：写 `<project>/.pipeline/reports/session-health.json`

### 8.3 diagnose-run.cjs

| 参数 | 说明 |
|------|------|
| `--project=<abs>` | 业务项目根目录（必填） |

**退出码**：发现问题时 1，否则 0  
**副产物**：写 `<project>/.pipeline/reports/diagnosis.md`

### 8.4 start-and-monitor.sh

```bash
bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh <PROJECT_ROOT> [CHECK_INTERVAL_SEC] [STUCK_MIN]
```

| 参数 | 默认 | 说明 |
|------|------|------|
| PROJECT_ROOT | 必填 | 业务项目根目录 |
| CHECK_INTERVAL_SEC | 180 | 健康检查间隔（秒） |
| STUCK_MIN | 15 | 卡住阈值（分钟） |

**退出码**：0=成功 / 1=失败（非卡住） / 2=检测到卡住已强制停止

脚本通过 `"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"` 推导 skill 目录，无需手动传路径。

---

## 9. 错误归因优先级

1. **skill 脚本/文档缺陷** → 改 `~/.cursor/skills/` 对应 skill，冒烟 2 轮后 commit+push。
2. **编排缺陷**（autorun gate 误杀、超时过短）→ 同上。
3. **可通过优化 v3 skill 防止的业务失败**（如 codegen 生成代码模式不当）→ 改 skill。
4. **纯业务代码/配置问题**（不涉及 skill 逻辑）→ 直接修业务仓，继续 Round N+1。
5. **不可解阻塞**（§5.2）→ 停止并等待人工介入。

---

## 10. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-05-16 | 从 `inputs/agent-prompt.md` 迁出，提升为正式 skill |
| 0.2.0 | 2026-05-16 | 新增：退出条件重新定义（成功=真正跑通）、不可解阻塞 §5.2、部署与端完整验证 §6、skill 评估步骤、mobile 模拟器安装冒烟要求 |
