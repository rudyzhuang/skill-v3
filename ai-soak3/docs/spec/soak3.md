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

### 5.0 Soak 严格模式（`AI_SOAK3_STRICT=1`）

**ai-soak3 在 Round 开始前**须对当前 shell 及子进程导出：

```bash
export AI_SOAK3_STRICT=1
```

| 约束 | 说明 |
| --- | --- |
| **子 skill 只读** | ai-auto3 / ai-code3 / ai-e2e3 / ai-publish-dev3 **不得**在 `AI_SOAK3_STRICT=1` 时用「阶段已完成 + summary_hash 未变」跳过 **codegen、build、deploy、smoke、ui_e2e** |
| **autorun 参数** | 须传 **`--force-rerun=codegen,build,deploy,smoke,ui_e2e`**（或以 env 由 autorun 等价实现，见 **`docs/spec/auto3.md` §6.4**） |
| **Agent 门闸** | 子 skill 脚本尚未实现 strict 行为时，Agent **必须**执行 **§8 手工门闸**；任一失败 → Round 失败，**不得** overall success |
| **规范来源** | 完整动机与追溯矩阵见 **`docs/spec/rfc-soak3-req-fidelity.md`** |

```
Round N:
  export AI_SOAK3_STRICT=1
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

#### 6.2.1 响应体内容指纹（**必须**，非仅 HTTP 状态码）

在 **`AI_SOAK3_STRICT=1`** 或常规 soak 轮次中，对 **生产/dev 部署 URL**（来自 `stages.deploy.outputs` 或 `config.*.json` + `inputs/req.md`）执行：

1. `GET <website_base>/`（或 req 声明路径，如 `/website/`）须 **HTTP 2xx/3xx**。
2. 响应体须满足 **至少一条**（由 Agent 从 `docs/prd-spec.md` / `inputs/req.md` 推导，并写入当轮 checkpoint）：
   - **`body_contains`**：如 `我的笔记`、`笔记`（与 website `index.html` 或 prd 标题一致）；
   - **`body_not_contains`**：已知错站特征（如 `TiddlyWiki`、`version.title` 等占位列表可维护于 `config.dev.json` → `soak.content_guards.website`）。
3. 本地 `dist/website/**/index.html` 与线上 body 关键子串 **一致**（防止「本地对、线上错」仍 pass）。

**失败**：进入 §5.1；**禁止**仅引用 `stages.smoke` 的 status code 通过作为 §6 依据。

### 6.3 Mobile（若声明了 mobile 端）

1. **build 成功**：`stages.build` 对应 mobile `completed`，或 `flutter build apk/ios --simulator` 返回 0。
2. **环境检查**：
   - `uname -s = Darwin`：可编译 iOS/Android。
   - `uname -s ≠ Darwin`：只能 Android；含 iOS 目标 → §5.2。
3. **模拟器安装冒烟**：启动可用模拟器 → `flutter run -d <emulator_id>` → 30s 内不崩溃 → pass。
4. 若有 `integration_test/`：`flutter test integration_test/ -d <emulator_id>` 通过。
5. 崩溃或测试失败 → §5.1 处理（非立即阻塞）。

#### 6.3.1 应用身份门闸（**必须**）

从 **`inputs/req.md`** 解析应用显示名（如「真实笔记」/ `RealNotes`），并写入 `config.dev.json` → `ui_e2e.mobile.expected_display_names`（实现 backlog）或当轮 checkpoint。

| 检查 | Android | iOS |
| --- | --- | --- |
| 显示名 | `aapt dump badging` 或 `adb shell dumpsys` 含 **中文名** 或 **RealNotes** | `Info.plist` → `CFBundleDisplayName` |
| **禁止** | 仍为 `Health Mobile`、`health_mobile`、`Health Multi-Page Demo` 等模板名 | 同上 |
| 包名/Bundle Id | 与 `ui_e2e.mobile.*.bundle_id` 或 `pubspec.yaml` `name` 一致，**不得**与无关历史 App 混用 |

**与 ui_e2e 关系**：`stages.ui_e2e` 为 completed 但 **§6.3.1 失败** → 整轮 **失败**（ui_e2e 门闸误绿）。

#### 6.3.2 功能 UI（笔记 CRUD）

mobile 须实现 req 声明的 **列表 / 创建 / 编辑 / 详情**（见 prd-spec mobile 节）。仅 Health API 探活页 **不满足** §6。

---

## 7. 最终成功判定

1. **A**：prd + prd_review `passed`，**`decision=passed`**；`client_targets` 与 `inputs/req.md` 一致；**`docs/prd-spec.md` §6 须覆盖 req 功能节每一条**（含品牌名、图标/启动图等，见 **`docs/spec/rfc-soak3-req-fidelity.md` §4**）。
2. **B**：autorun 全链路成功，report 无阻塞，stages 与 report 一致；**且** `stages.codegen.outputs.agent.skipped !== true`（strict 下禁止 skip agent 伪完成）。
3. **§6**：所有声明端验证通过（含 **§6.2.1 内容指纹**、**§6.3.1 应用身份**、mobile 笔记 UI），或有合理跳过记录（须写明原因，**不得**对 website/mobile 静默跳过）。
4. **证据包**：须附 **req→feature_id→端** 矩阵（可从 `.pipeline/reports/prd-implementation-summary.md` 摘录）。
5. 以上**连续 2 轮**（A→B→§6）均通过。

**禁止**：在 P1–P4（RFC §1）任一未解决时输出 **SKILL.md §9 最终证据包**或宣称 soak 成功。

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

## 10. Agent 手工门闸（脚本未落地 strict 前 **强制**）

每轮 B 之后、§6 之前，Agent **必须**执行并记录输出（写入 Round checkpoint）：

| # | 命令/检查 | 通过条件 |
| --- | --- | --- |
| H1 | `validate-prd` JSON 中 `requires_agent` | 为 false，或已完成 prd-spec 更新 + `write-prd` |
| H2 | `curl` website 部署 URL body | 含 prd 声明标题子串；**不含** `TiddlyWiki` |
| H3 | `curl` admin URL body | 含「管理」或 prd 声明关键词 |
| H4 | `grep -r` mobile `Info.plist` / `AndroidManifest.xml` | 显示名为 req 品牌名，非 Health |
| H5 | `test -f` mobile 图标路径 | `android/app/src/main/res/mipmap-*` 与 iOS `AppIcon` 存在（若 req 要求图标） |
| H6 | 读 `stages.codegen.outputs.agent` | `skipped` 不为 true（strict） |
| H7 | 读最新 ui_e2e report | 每场景 `run_mode` 为 `agent` 或 `integration_test`，**非**「无 agent 自动 pass」|

任一失败 → §5.1，不得进入 Round N+1 的成功结论。

---

## 11. §4.A 与 req 漂移（ai-prd3 衔接）

当 `validate-prd` / `detect-raw-input` 输出 **`requires_agent: true`** 或 **`functional_requirements_changed: true`** 时：

1. Agent **必须**按 **`prompts/raw-input-impact.md`** 先做 **四类分流（C/O/I/N）**（见 **`docs/spec/rfc-soak3-req-fidelity.md` §2.5**）。
2. **功能需求** → **`docs/prd-spec.md` §6** + 派生稿；**配置类** → **`apply-raw-input-config`** 写入 `config.*.json` 对应区。
3. **正交新 feature（O/N）**：**不得**影响无关 feature 的源码、契约与 `stages` 已完成态。
4. **受影响 feature（I）**：仅对命中 id 重跑 pipeline；codegen **incremental**；**增量评审 ×2** + **该 feature 全量评审 ×1**。
5. **全新 feature（N）**：该 id 从 design 起完整阶段链。
6. 运行 `validate-prd` → `write-prd`（必要时 `--force`）→ `finalize-prd-review`。
7. **禁止**在仅执行 `validate-prd-review` 且 prd-spec 未更新时进入 B 阶段。

---

## 12. 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| 0.1.0 | 2026-05-16 | 从 `inputs/agent-prompt.md` 迁出，提升为正式 skill |
| 0.2.0 | 2026-05-16 | 新增：退出条件重新定义（成功=真正跑通）、不可解阻塞 §5.2、部署与端完整验证 §6、skill 评估步骤、mobile 模拟器安装冒烟要求 |
| 0.3.0 | 2026-05-17 | RFC soak3-req-fidelity：§5.0 strict、§6.2.1/§6.3.1、§7、§10 手工门闸、§11 req 漂移 |
| 0.3.1 | 2026-05-17 | RFC §2.5：req 四类分流 C/O/I/N；§11 与 prd3/auto3/code3 衔接 |
