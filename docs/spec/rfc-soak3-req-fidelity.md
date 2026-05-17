# RFC：ai-soak3 需求保真与端到端验收强化

| 项 | 值 |
| --- | --- |
| **状态** | 已采纳（文档阶段） |
| **版本** | 0.1.0 |
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

---

## 3. 跨 skill 变更摘要

| Skill | 规范文件 | 核心新增 |
| --- | --- | --- |
| **ai-soak3** | `soak3.md`, `SKILL.md` | §6 内容指纹、App 身份、req 矩阵；§4 强制 prd 漂移处理；导出 `AI_SOAK3_STRICT`；禁止误报 success |
| **ai-prd3** | `prd3.md`, `SKILL.md` | req 品牌/图标 **必抽 feature**；`requires_agent` 时 soak 不得 finalize |
| **ai-auto3** | `auto3.md` | strict 下 `--force-rerun` 白名单；codegen skip → 失败 |
| **ai-code3** | `code3.md` | strict 下禁止 `SKIP_AGENT` 伪 completed；Health 脚手架与 notes 互斥 |
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
| P1 | ai-prd3 | `extract-req-features.cjs` 或强化 validate 规则 |
| P1 | ai-code3 | soak 下 `SKIP_AGENT` → exit 4 |

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
