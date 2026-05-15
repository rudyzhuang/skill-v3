# ai-code3 分阶段实施计划与评审门禁

本文档与 **`docs/spec/code3.md`** 对齐，给出**优先顺序**、分步交付边界与**两轮全量评审**规则。实现代码以 **`docs/spec/code3.md`** 为 SSOT。

## 1. 优先级与状态

| 阶段 | 优先级 | 范围 | 状态 | 备注 |
| --- | ---: | --- | --- | --- |
| **P0** | 1 | 附录 B secret-scan **单测** + 冒烟串联 | **完成** | `self-test-secret-scan.cjs` |
| **P1** | 2 | **`merge-push.cjs`**：真实 `git merge`、冲突 **6**、可选 `git push`（**7**） | **完成** | `lib/merge-git.cjs`、`self-test-merge-push.cjs`；**§11.4** |
| **P2** | 3 | **`codegen.cjs`**：`git worktree` 创建/复用、二次 diff-guard、绝对路径 worktree | **未开始** | 仍为过渡：门闸后直接 `completed`（§7.4） |
| **P3** | 4 | **`codegen-scaffold` / `invoke-codegen-agent`**、`outputs.agent`、`AI_CODE3_SKIP_AGENT` | **未开始** | §7.8–§7.12 |
| **P4** | 5 | **`test.cjs`**：Agent 式 fix-loop 定稿 + **`rollback_to`** 细化 | **部分** | 当前为同命令重试 |
| **P5** | 6 | **`code-review.cjs`**：契约驱动结构化输出 + JSON Schema（§18 T2） | **未开始** | 依赖人工预填或 stub |
| **P6** | 7 | **`build.cjs`**：`client_targets` × `sub_platforms` 矩阵 | **部分** | 单命令 + 简化 artifacts |
| **P7** | 8 | **`preflight.cjs`**：codegen 上游门闸预检 | **未开始** | 门闸在各阶段脚本 |
| **P8** | 9 | **§15 心跳** | **未开始** | |
| **P9** | 10 | **`prompts/*.md`**、`clean` 子命令 | **未开始** | |
| **P10** | 11 | **§16 自动化验收矩阵** | **部分** | secret + merge 自测 + smoke |

## 2. 分步完成定义（每阶段）

- **代码**：门闸、`stages.json` 原子写、锁语义不弱化。  
- **文档**：行为变化须同步 **`code3.md` / 模板 / `input-spec.md`**（§0）。  
- **验证**：本阶段相关 **`node …/self-test-*.cjs`** 与 **`smoke.cjs`** 通过。

## 3. 两轮评审规则（连续通过）

1. **R1**：对照 **§4.1** 自动化命令 + **§4.3** 全量矩阵 + **`ai-code3/SKILL.md`** 与 **`code3.md`** 已实现段落。  
2. **修复**：处理 R1 阻塞项。  
3. **R2**：**相同命令与相同矩阵**再执行一遍；阻塞项为 0、且无新增回归。  
4. **通过定义**：§4.1 全 PASS；§4.3 中「**须与实现一致**」项无矛盾（未实现项保持 **未开始/部分**，须在 SSOT §7.4 / §11 等标明或与 §5 一致）。

## 4. 评审检查表

### 4.1 自动化门禁（R1 / R2 须两次均 exit 0）

| # | 命令 | R1 | R2 |
| --- | --- | --- | --- |
| 1 | `node ai-code3/scripts/self-test-secret-scan.cjs` | PASS | PASS |
| 2 | `node ai-code3/scripts/self-test-merge-push.cjs` | PASS | PASS |
| 3 | `node ai-code3/scripts/smoke.cjs` | PASS | PASS |

### 4.2 文档核对（本轮已核对）

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | **`docs/spec/code3.md` §4.1** 目录树含 **`merge-git.cjs`**；脚本表 **`merge-push`/`merge-git` 职责** 与实现一致 | OK |
| 2 | **`code3.md` §11.4** 描述干净树门闸、分支来源、push、stub 与脚本一致 | OK |
| 3 | **`SKILL.md`** 冒烟节含 secret + merge 自测指针 | OK |

### 4.3 全量能力矩阵（相对 `code3.md`）

| 能力 | 规格章节 | 实现 | 说明 |
| --- | --- | --- | --- |
| run 串联 / summary_hash 跳过 | 附录 A.3、§13 | **完成** | `run.cjs`、`summary-hash.cjs` |
| codegen 门闸 + 主仓 diff-guard | §7.2–§7.3 | **完成** | 二次 worktree diff-guard **未**做 |
| codegen worktree + Agent | §7.4–§7.12 | **未开始** | 过渡直写 `completed` |
| typecheck | §8 | **完成** | 全 skip 退出 0（T1） |
| test + rollback_to | §9 | **部分** | 重试无 Agent 修补 |
| code-review | §10 | **部分** | 外部填结论或 stub |
| merge-push 真 merge / 6 / push 7 | §11 | **完成** | `merge-git.cjs` |
| build 多端矩阵 | §12 | **部分** | |
| preflight secret-scan | 附录 B | **完成** | 上游门闸 **未**在 preflight |
| 附录 B 单测 | 附录 B | **完成** | |
| §15 心跳 | §15 | **未开始** | |

## 5. 已知局限（与 SSOT 一致）

- **codegen**：§7.4 过渡实现；无真实 worktree/Agent、无 **`outputs.agent`**、无二次契约 diff-guard。  
- **code-review / build / test fix-loop / preflight 上游 / 心跳**：见 **§4.3**「部分/未开始」。  
- **业务仓**应在 **`.gitignore`** 中忽略 **`.agent-sessions/`**，否则锁文件可能影响「干净树」门闸（§11.4）。

## 6. 评审记录

| 轮次 | 日期 | 范围 | 结论 |
| --- | --- | --- | --- |
| R1 | 2026-05-15 | §4.1～§4.3 + 文档 §11.4 / §4.1 表 | **PASS**（未实现项已标为未开始/部分，与 SSOT 无矛盾） |
| R2 | 2026-05-15 | 重复执行 §4.1 三条命令 + 抽查 §4.2 | **PASS** |

---

*维护：完成阶段后更新 **§1 状态** 与 **§6**。*
