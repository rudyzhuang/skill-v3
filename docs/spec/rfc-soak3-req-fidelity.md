# RFC：ai-soak3 需求保真与端到端验收强化

| 项 | 值 |
| --- | --- |
| **状态** | 已采纳（文档阶段） |
| **版本** | 0.2.0 |
| **日期** | 2026-05-17 |
| **范围** | ai-soak3、ai-prd3、ai-auto3、ai-code3、ai-e2e3、ai-publish-dev3（publish3.md） |
| **实现** | 本文仅改规范；脚本实现见各 spec §「实现 backlog」 |

---

## 1. 背景与问题（来自 test-skill-v3 实跑）

| # | 现象 | 根因（规范/实现缺口） |
| --- | --- | --- |
| P1 | `req.md` 新增「真实笔记/RealNotes、图标启动图」未进报告与产品 | `detect-raw-input` 仅提示 Agent，soak 未强制改 prd-spec；无 branding feature 抽取规则；codegen 被 `AI_CODE3_SKIP_AGENT` 跳过仍 overall success |
| P2 | 真机为 **Health Mobile**，非笔记 App | 模板 Health 脚手架 + skip agent；soak §6 未校验 **display_name / bundle_id**；mobile 冒烟仅 `flutter run` 时长 |
| P3 | 报告 ui_e2e 14/14 PASS 但未用 Browser/Dart MCP | `AI_E2E3_AGENT_BIN` 空时 web 降级 HTTP GET stub、mobile **自动 pass**；stub **不执行** `expect[]`；soak 允许 **skip 已完成** ui_e2e |
| P4 | 线上 `/website/` 为 TiddlyWiki，非笔记站 | smoke 仅验 HTTP 状态码；deploy skip 不重传；soak §6 无 **响应体指纹** 门闸 |

**目标**：重跑 **ai-soak3** 时，规范迫使流水线 **需求→PRD→代码→部署→验收** 闭环，禁止「门闸绿、产品错」。

---

## 2. 设计原则

1. **Soak 严格模式（`AI_SOAK3_STRICT=1`）**：由 ai-soak3 在调用子 skill 前导出；子 skill 只读该 env，**不得**在 strict 下用「已完成 summary_hash」跳过 deploy/build/ui_e2e/codegen（除非本轮已重跑且 hash 含新产物指纹）。
2. **断言可执行**：凡 `test-spec.yaml` 中 `expect[]` 非空，**必须**由 Agent+MCP 或 **确定性脚本** 校验；禁止「无 agent 即 pass」。
3. **req 可追溯**：报告与证据包须含 **req→feature_id→端** 矩阵，且与 `inputs/req.md` 功能节逐条对应。
4. **分阶段落地**：文档定稿 → 脚本按 spec 实现；未实现脚本前，soak Agent **须**按 §8 手工门闸补位（列于 soak3.md）。
5. **增量分流（用户确认 §2.5）**：新增需求按 **配置 / 正交 feature / 受影响 feature / 全新 feature** 四类处理；**禁止**因 req 变更而整仓推倒重来或误伤无关 feature 的 pipeline 状态。

---

## 2.5 新增需求四类分流（用户确认，2026-05-17）

探测到 **`inputs/req.md`**（或内联 raw input）相对缓存**有新增或变更**时，Agent **必须先分类**，再决定重跑范围。分类结果须写入当轮 checkpoint 与（实现后）**`.pipeline/reports/raw-input-drift.json`** 的 **`feature_impacts[]`**。

### 规则 1 — 落盘：功能进 prd-spec，配置进 config

| 需求性质 | 落盘位置 | 动作 |
| --- | --- | --- |
| **业务能力**（功能、页面、端行为、品牌、图标等） | **`docs/prd-spec.md` §6** + 派生 `docs/<端>/prd.md`、`feature_list.md` | Agent 增删改 **feature 行**；`validate-prd` → `write-prd` |
| **部署/域名/URL/冒烟路径** 等 | **`docs/config.dev.json` / `config.release.json`** 对应区（`deploy` / `smoke` / `ui_e2e.web` 等） | **`apply-raw-input-config`**；**禁止**只改 config 不在 prd-spec 留痕 |
| **密钥引用** | **`docs/config.env`**（仅占位名） | 不入库真实密钥 |

**门闸**：未完成规则 1，**禁止**进入 ai-auto3 **codegen**。

### 规则 2 — 正交新增：不影响无关 feature

**定义**：新增的 `feature_id` 与既有 feature **无**共享 `client_target` 实现文件、**无**契约/API 依赖、**无**需修改既有 design/contract 条目。

| 允许 | 禁止 |
| --- | --- |
| 仅为新 feature 创建 `docs/designs/<NEW>.design.json`、契约目录、worktree | 重置 **无关** feature 的 `stages.codegen.outputs.worktrees[]` 条目 |
| 将新 id 加入 `prd_review.phase_plan` | 对无关 feature 执行 `--force-rerun` 或 `bootstrap --force` 全量派生 |
| 在 autorun 中 **仅**对 **新 feature_id 集合** spawn ai-code3（`--feature=NEW-...`） | 将全局 `stages.design` / `stages.contract` 标为 failed 或清空 |

**pipeline 状态**：无关 feature 已 `completed` 的阶段 **保持** `completed` + 原 `summary_hash`（除非本轮显式 `--force-rerun-features` 包含该 id）。

### 规则 3 — 受影响既有 feature：按增量重跑 + 增量改码 + 双次增量评审 + 全量 feature 评审

**定义**：新增/变更需求导致**既有** `feature_id` 的设计、契约或实现须修改（例如「真实笔记」改名影响 `MOB-FLUTTER-019`）。

**须重跑的阶段链**（**仅该 feature_id**，见 **`auto3.md` §6.5**）：

`design` → `contract` → `design-review` → `codegen` → `typecheck` → `test` → `code-review` →（若影响合并域）`merge-push` →（若影响该端产物）`build` →（若影响该端 URL）`deploy`/`smoke` →（若该 feature 含 ui_scenarios）`ui_e2e`

**codegen 模式（强制）**：**`incremental`**（见 **`code3.md` §7.13**）

- 在**已有** `src/`、worktree 产物上 **修改/扩展**，满足新增需求。
- **禁止** `greenfield` 全量覆盖：不得删除无关模块后整包重写，除非 code-review 记录明确「不可增量」理由。
- Agent prompt 须声明：**preserve existing behavior; patch for delta only**。

**评审（强制顺序）**：

1. **增量评审 ×2**（针对**本轮 req 变更切片**）：对「新增需求引入的 diff」连续两轮评审通过（可 Agent + checklist；实现 backlog：`delta-review` 子命令）。主题：变更是否**仅**服务于新 req、是否破坏既有验收。
2. **全量 feature 评审 ×1**：对该 **feature_id** 整体再做一次 **code-review**（含契约、测试、回归），`decision=passed` 后才可 merge-push。

**禁止**：仅做增量评审即标记全局 `code_review` completed 而不做第 2 步。

### 规则 4 — 全新 feature：该 feature 全流程

**定义**：新 `feature_id`，且需完整 design → contract → codegen → …（与规则 2 正交的区别：规则 2 强调**不扰动他 feature**；规则 4 强调**本 feature 不省略阶段**）。

- 从 **`design`**（该 feature）起完整执行至 **`code-review`**，再进入共享的 `merge-push` / `build` / `deploy` / `ui_e2e`（按 `client_target` 触发）。
- codegen 可用 **`greenfield`**（无旧实现）或 **`incremental`**（若已有脚手架）；默认 **greenfield**。

### 分类决策表（Agent / 脚本）

| 类型 | 代号 | 判定 | 重跑范围 |
| --- | --- | --- | --- |
| 仅配置 | **C** | `impact_hints` 仅 `domain` / deploy 映射，无 feature 表变更 | `apply-raw-input-config` + 按需 `deploy`/`smoke` |
| 正交 feature | **O** | 新 `feature_id`，无既有 id 在 `impacted_ids` | 仅 **O** 的 id 走规则 4；他 id 不动 |
| 受影响 feature | **I** | 既有 id 出现在 `impacted_ids` | 仅 **I** 的 id 走规则 3 |
| 全新 feature（独立域） | **N** | 新 id 且需完整契约/设计 | **N** 走规则 4；与 **O** 可合并为同一新 id 集合 |

同一轮可同时存在 **C + O + I**；autorun **不得**因存在 **I** 而对 **O** 以外所有 id 重跑。

---

## 3. 跨 skill 变更摘要

| Skill | 规范文件 | 核心新增 |
| --- | --- | --- |
| **ai-soak3** | `soak3.md`, `SKILL.md` | §6 内容指纹、App 身份、req 矩阵；§4 强制 prd 漂移处理；导出 `AI_SOAK3_STRICT`；禁止误报 success |
| **ai-prd3** | `prd3.md`, `SKILL.md`, `raw-input-impact.md` | req→feature/config 落盘；**§1.5 四类分流**；`feature_impacts[]` |
| **ai-auto3** | `auto3.md` | strict 下按 **feature 作用域** 重跑（§6.5）；禁止全 pipeline 推倒 |
| **ai-code3** | `code3.md` | **`incremental` codegen**；规则 3 双评审 + 全量 feature 评审 |
| **ai-e2e3** | `e2e3.md`, `SKILL.md` | strict stub 须验 expect；无 agent → exit 1；mobile 身份断言 |
| **ai-publish-dev3** | `publish3.md` | smoke `body_contains` / `title_contains`；deploy 产物指纹 |

---

## 4. 需求→验收追溯矩阵（示例：RealNotes）

| req.md 条目 | prd-spec feature（须存在） | 代码/部署验收 | 测试 |
| --- | --- | --- | --- |
| 笔记 CRUD 四端 | NOTE-* / API-NOTES-* | website/admin/api 行为 | ui_e2e + contract test |
| 中文 UI | 各端 NFR 或 WEB-* | 页面含中文关键词 | smoke `body_contains` |
| 真实笔记 / RealNotes | **MOB-BRAND-023**, **APP-ICON-024**（编号可模板化） | `CFBundleDisplayName` / `android:label` | ui_e2e `text_present` + soak §6 |
| 图标与启动图 | APP-ICON-024 | `mipmap` / `Assets.xcassets` 非默认 Flutter | build 产物检查 |
| website URL | DEPLOY-DOMAIN-021 | GET body 含 `我的笔记` 或 prd 声明标题 | smoke + Browser MCP |

---

## 5. 实现 backlog（代码阶段，本文不实现）

| 优先级 | 组件 | 任务 |
| --- | --- | --- |
| P0 | ai-e2e3 `execute-scenarios.cjs` | strict：评估全部 `expect`；mobile 禁止无 agent pass |
| P0 | ai-publish-dev3 `smoke.cjs` | 支持 `body_contains` / `title_not_contains` |
| P0 | ai-auto3 `autorun.cjs` | 读取 `AI_SOAK3_STRICT`，禁用关键阶段 skip |
| P1 | ai-soak3 `verify-deploy-content.cjs`（新） | §6 指纹 curl + 写 report |
| P1 | ai-prd3 | `extract-req-features.cjs`；`detect-raw-input` 输出 `feature_impacts[]` |
| P1 | ai-code3 | `incremental` 模式；`delta-review` ×2 + 全量 feature review |
| P1 | ai-auto3 | `--force-rerun-features=` 仅失效指定 id 下游 |

---

## 6. 文档评审记录

### 6.1 第一轮评审（2026-05-17）

| 检查项 | 结果 | 备注 |
| --- | --- | --- |
| P1 req 未进 PRD | ✅ 已覆盖 | prd3 §1.4 + soak §4.A 强制链 |
| P2 Health Mobile | ✅ 已覆盖 | soak §6.3.1 + code3 §7 + e2e3 mobile identity |
| P3 MCP 未执行 | ✅ 已覆盖 | e2e3 strict + 禁止 auto-pass |
| P4 错误部署仍 200 | ✅ 已覆盖 | publish3 smoke body + soak §6.2.1 |
| autorun skip 掩盖回归 | ✅ 已覆盖 | auto3 §6.4 |
| 仅有文档、脚本未改时 soak 能否执行 | ⚠️ 缺口 | **已补** soak3 §8 Agent 手工门闸清单 |
| prd「≥20 feature」与 req 驱动冲突 | ⚠️ 缺口 | **已改** soak3 §7 删除固定数量 |
| 新 feature_id 编号与现有 022 冲突 | ⚠️ 缺口 | **已改** prd3 用语义 ID 模板，不硬编码编号 |

**第一轮结论**：**不通过**（2 项缺口已在本轮修订中关闭）。

### 6.2 第二轮评审（2026-05-17）

| 检查项 | 结果 |
| --- | --- |
| 追溯矩阵可验证 P1–P4 | ✅ |
| strict 环境变量在各 spec 一致命名 | ✅ `AI_SOAK3_STRICT=1` |
| e2e3 与 SKILL 表述一致 | ✅ |
| codegen skip 与 soak success 互斥 | ✅ auto3 + code3 |
| 手工门闸可执行（curl/grep/flutter） | ✅ soak3 §8 |
| 与 input-spec 退出码不冲突 | ✅ e2e3 仍为 0/1/3/4 |

**第二轮结论**：**通过**。

### 6.3 第三轮评审（2026-05-17，连续通过第 2 次）

| 检查项 | 结果 |
| --- | --- |
| 重跑 soak 端到端路径无死锁（可先 prd 再 codegen） | ✅ |
| 不依赖用户记得 `--force-rerun` | ✅ soak 导出 strict + auto3 默认 force 列表 |
| 完善性：模板/config 字段有文档 | ✅ publish3 smoke check 扩展表 |
| 正确性：与实跑失败案例一一对应 | ✅ §1 表 |

**第三轮结论**：**通过**（**连续两轮评审通过**，可提交）。

### 6.4 第四轮评审（2026-05-17，用户四条增量规则）

| 用户条款 | 规范落点 | 结果 |
| --- | --- | --- |
| ① 新需求→feature / 配置→config | RFC §2.5 规则 1；prd3 §1.5 | ✅ |
| ② 无关 feature 不影响文件与 pipeline | RFC §2.5 规则 2；auto3 §6.5 | ✅ |
| ③ 有关 feature 全流程但 codegen 增量 + 双评审 + 全量评审 | RFC §2.5 规则 3；code3 §7.13 | ✅ |
| ④ 全新 feature 全流程 | RFC §2.5 规则 4 | ✅ |
| 与 strict/验收原文冲突 | 已核对：增量仅缩小重跑范围，不放宽 §6 指纹/MCP | ✅ |

**第四轮结论**：**通过**。

### 6.5 第五轮评审（2026-05-17，连续通过第 2 次）

| 检查项 | 结果 |
| --- | --- |
| 分类表 C/O/I/N 可指导 Agent 不分叉 | ✅ |
| merge-push/build/deploy 仅在受影响端触发 | ✅ auto3 §6.5 |
| 双次评审对象明确（req 切片 vs 整 feature） | ✅ |
| 实现 backlog 与文档阶段 soak 可用手工门闸衔接 | ✅ soak3 §11 |

**第五轮结论**：**通过**（**连续两轮评审通过**）。

---

## 7. 变更文件清单

- `docs/spec/rfc-soak3-req-fidelity.md`（本文件）
- `ai-soak3/docs/spec/soak3.md`
- `ai-soak3/SKILL.md`
- `ai-prd3/docs/spec/prd3.md`
- `ai-prd3/SKILL.md`
- `docs/spec/auto3.md`
- `docs/spec/code3.md`
- `docs/spec/e2e3.md`
- `ai-e2e3/SKILL.md`
- `docs/spec/publish3.md`
- `docs/input-spec.md`（§4.3 soak 摘录）
- `ai-prd3/prompts/raw-input-impact.md`（四类分流工作流）

**v0.2.0 增量**：§2.5 用户确认之四规则；§6.4–6.5 评审。
