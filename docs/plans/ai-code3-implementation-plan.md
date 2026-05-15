# ai-code3 分阶段实施计划与评审门禁

本文档与 **`docs/spec/code3.md`** 对齐，给出**优先顺序**、分步交付边界与**两轮评审**规则。实现代码仍以 **`docs/spec/code3.md`** 为 SSOT。

## 1. 优先级（建议执行顺序）

| 阶段 | 优先级 | 范围 | 理由 |
| --- | ---: | --- | --- |
| **P0** | 1 | 附录 B secret-scan **单测** + CI/冒烟串联 | 低成本、确定性、满足 `code3.md` 附录 B「须写入单测」 |
| **P1** | 2 | **`merge-push.cjs`**：真实 `git merge`（worktree → 目标分支）、冲突 **6**、可选 `git push` 与 **7** | 阻塞「无 `--stub-remaining`」的端到端流水线；与 §11、下游 build 真依赖 |
| **P2** | 3 | **`codegen.cjs`**：`git worktree` 创建/复用、二次 diff-guard、写全 **`outputs.worktrees[]`** / 分支 / 路径 | 解除「假 completed」；与 typecheck/test 真源一致 |
| **P3** | 4 | **`lib/codegen-scaffold.cjs`** + **`lib/invoke-codegen-agent.cjs`**（Cursor CLI / SDK 优先级写死）+ **`outputs.agent`** + **`AI_CODE3_SKIP_AGENT`** 语义 | 文档目标形态 §7.4–§7.12；与 CI 跳过策略一致 |
| **P4** | 5 | **`test.cjs`**：fix-loop 与编排约定（可调用 Agent 或文档化「仅重试命令」二选一定稿）+ **`rollback_to`** 细化 | §9 与 `input-spec` 阶段 8 对齐 |
| **P5** | 6 | **`code-review.cjs`**：契约驱动的结构化输出 + 可选 JSON Schema 随 skill 分发（关 **§18 T2**） | §10、附录 C；当前依赖人工预填 |
| **P6** | 7 | **`build.cjs`**：`client_targets` × `sub_platforms`、产物矩阵 | §12 多端与下游 deploy 消费 |
| **P7** | 8 | **`preflight.cjs`**：可选/可开关的 codegen 上游门闸预检 | 与 §4.1 表「上游门闸」一致，避免与单阶段重复时须文档说明 |
| **P8** | 9 | **§15 心跳**：codegen / test / build 写 `.agent-sessions/<session_id>.log` | 可观测性；长任务运维 |
| **P9** | 10 | **`prompts/*.md`** 与脚本单一真源、**`clean`** 子命令（destructive 确认） | §4.1、§7.7 |
| **P10** | 11 | **§16 验收矩阵**：自动化用例（或最小 e2e 夹具）逐条覆盖 | 回归门禁 |

## 2. 分步完成定义（每阶段完成标准）

- **代码**：对应脚本/库实现 + 不弱化现有 **diff-guard**、`stages.json` **原子写**、锁语义。
- **文档**：若行为与 **`code3.md` / `input-spec.md` / 模板** 有差，同一 PR 内同步（见 `code3.md` §0）。
- **验证**：本阶段新增/修改的 `node …/self-test-*.cjs` 或 `smoke.cjs` 必须通过。

## 3. 两轮评审规则（连续通过才允许合并发布）

1. **第一轮（R1）**：对照 **`docs/spec/code3.md`** 全文 + **`docs/input-spec.md`** 附录 A 相关条 + **`ai-code3/SKILL.md`**，填写检查表（见 §4）；缺陷记入「待修复」。
2. **修复**：仅处理 R1 **阻塞项**与本轮范围相关项。
3. **第二轮（R2）**：**相同检查表**再跑一遍；**阻塞项须为 0** 且与 R1 相比无新增阻塞。
4. **连续两轮通过**：R1、R2 均为 **PASS**（允许「已知局限」在计划本文 §5 显式列出且 SSOT 已标明 MVP/过渡）。

全 skill **最终**两轮通过需待 **P1–P10** 按团队裁剪完成后执行；**本轮仓库变更**（计划 + P0）的评审范围见 §4「本轮」。

## 4. 评审检查表（摘录）

### 4.1 本轮交付物（计划 + P0）

| # | 项 | R1 | R2 |
| --- | --- | --- | --- |
| 1 | `docs/plans/ai-code3-implementation-plan.md` 存在且优先级与 SSOT 一致 | PASS | PASS |
| 2 | `node ai-code3/scripts/self-test-secret-scan.cjs` 退出 0 | PASS | PASS |
| 3 | `node ai-code3/scripts/smoke.cjs` 退出 0（含 secret-scan） | PASS | PASS |

### 4.2 全量（ai-code3 相对 `code3.md` — 供后续阶段打勾）

- §7 codegen：worktree、Agent、SKIP_AGENT、二次 diff-guard、outputs.agent、分相状态。
- §8 typecheck：与 worktree 联动（已实现基线需保持）。
- §9 test：fix-loop 语义与 rollback_to。
- §10 code-review：LLM/结构化与 strict_warnings。
- §11 merge-push：真 merge/push、6/7。
- §12 build：多端 artifacts。
- §13 summary_hash：各阶段写回（已实现基线需保持）。
- §15 心跳与会话日志。
- §16 自动化验收矩阵。
- 附录 B：键名/值扫描 + **单测**。

## 5. 已知局限（当前 SSOT 已写明的过渡行为）

- **`codegen.cjs`**：过渡实现，门闸 + diff-guard 后直接 `completed`（见 `code3.md` §7.4）。
- **`merge-push.cjs`**：非 stub 时未执行真 merge（见脚本 stderr 说明）。
- **`code-review.cjs`**：依赖外部预填或 `--stub-remaining`。

## 6. 评审记录

| 轮次 | 日期 | 范围 | 结论 | 执行人 |
| --- | --- | --- | --- | --- |
| R1 | 2026-05-15 | §4.1 本轮三项 | PASS | Agent |
| R2 | 2026-05-15 | §4.1 本轮三项（重复执行相同命令） | PASS | Agent |

---

*维护：每完成一阶段更新 §1 状态列（可选）与 §6 记录。*
