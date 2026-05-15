# ai-code3 分阶段实施计划与评审门禁

本文档与 **`docs/spec/code3.md`** 对齐，给出**优先顺序**、分步交付边界与**两轮全量评审**规则。实现代码以 **`docs/spec/code3.md`** 为 SSOT。

## 1. 优先级与状态

| 阶段 | 优先级 | 范围 | 状态 | 备注 |
| --- | ---: | --- | --- | --- |
| **P0** | 1 | 附录 B secret-scan **单测** + 冒烟串联 | **完成** | `self-test-secret-scan.cjs` |
| **P1** | 2 | **`merge-push.cjs`**：真实 `git merge`、冲突 **6**、可选 `git push`（**7**） | **完成** | `lib/merge-git.cjs`、`self-test-merge-push.cjs`；**§11.4** |
| **P2** | 3 | **`codegen.cjs`**：`git worktree` 创建/复用、二次 diff-guard、绝对路径 worktree | **完成** | **`lib/codegen-worktree.cjs`**、**`lib/codegen-gates.cjs`** |
| **P3** | 4 | **`codegen-scaffold` / `invoke-codegen-agent`**、`outputs.agent`、`AI_CODE3_SKIP_AGENT` | **完成** | **`prompts/codegen-impl.md`** 为骨架；完整分相见 **§7.8–§7.12** |
| **P4** | 5 | **`test.cjs`**：Agent 式 fix-loop 定稿 + **`rollback_to`** 细化 | **部分** | **`build.commands.test_fix`** 间隙钩子；同命令重试仍无 Agent |
| **P5** | 6 | **`code-review.cjs`**：契约驱动结构化输出 + JSON Schema（§18 T2） | **部分** | **`AI_CODE3_CODE_REVIEW_JSON`** 导入；无内置 LLM |
| **P6** | 7 | **`build.cjs`**：`client_targets` × `sub_platforms` 矩阵 | **完成** | **`artifacts[]`** 字段级与 §12.3 仍可继续对齐 |
| **P7** | 8 | **`preflight.cjs`**：codegen 上游门闸预检 | **完成** | 默认关闭；**`AI_CODE3_PREFLIGHT_UPSTREAM_GATES=yes`** |
| **P8** | 9 | **§15 心跳** | **部分** | **codegen / test / build** + **`--session-id=`** |
| **P9** | 10 | **`prompts/*.md`**、`clean` 子命令 | **完成** | **`clean.cjs`**、**`AI_CODE3_CLEAN_CONFIRM`** |
| **P10** | 11 | **§16 自动化验收矩阵** | **部分** | secret + merge 自测 + smoke；可增 clean / upstream-gate 用例 |

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

### 4.2 文档核对（全量评审）

| # | 项 | 结论 |
| --- | --- | --- |
| 1 | **`docs/spec/code3.md` §0.1** 快照表与 **`ai-code3/scripts/**/*.cjs`** 行为一致 | OK |
| 2 | **`docs/spec/code3.md` §4.1** 脚本表区分「目标形态」与「当前仓库」且与 **§0.1** 一致 | OK |
| 3 | **`docs/spec/code3.md` §11.4** 与 **`merge-push.cjs` / `merge-git.cjs`** 一致 | OK |
| 4 | **`SKILL.md` §0** 指向 **§0.1**；冒烟命令与 **§4.1** 一致 | OK |

### 4.3 全量能力矩阵（相对 `code3.md`；细则见 **`code3.md` §0.1**）

| 能力 | 规格章节 | 实现 | 说明 |
| --- | --- | --- | --- |
| run 串联 / summary_hash 跳过 | 附录 A.3、§13 | **完成** | `run.cjs`、`summary-hash.cjs` |
| codegen 门闸 + 主仓 diff-guard | §7.2–§7.3 | **完成** | |
| codegen worktree + Agent | §7.4–§7.12 | **部分** | worktree / scaffold / 二次 diff-guard / **`outputs.agent`** / skip 已落地；完整 Cursor 分相与 **§7.10** 级验收见 SSOT |
| typecheck | §8 | **完成** | 全 skip 退出 0（T1） |
| test + rollback_to | §9 | **部分** | **`test_fix`** 钩子；重试无 Agent 修补 |
| code-review | §10 | **部分** | **JSON 导入**；无内置 LLM |
| merge-push 真 merge / 6 / push 7 | §11 | **完成** | `merge-git.cjs` |
| build 多端矩阵 | §12 | **完成** | **`artifacts[]`** 与 §12.3 可对齐收紧 |
| preflight secret-scan | 附录 B | **完成** | |
| preflight 上游门闸（可选） | §7.2 | **完成** | **`AI_CODE3_PREFLIGHT_UPSTREAM_GATES=yes`** |
| clean worktrees | §4.3 | **完成** | **`AI_CODE3_CLEAN_CONFIRM=yes`** |
| 附录 B 单测 | 附录 B | **完成** | |
| §15 心跳 | §15 | **部分** | codegen / test / build + **`--session-id=`** |

## 5. 已知局限（与 SSOT 一致）

- **codegen**：worktree / diff-guard / Agent 封装已落地；**§7.8–§7.12** 中与编排、多相 Cursor 集成的**穷尽**验收仍以 SSOT 为准。  
- **test**：无 Agent 式 fix-loop；**rollback_to** 语义可继续细化。  
- **code-review**：无内置 LLM；**JSON Schema（§18 T2）** 未接。  
- **§15 心跳**：未覆盖全阶段（见 **§0.1**）。  
- **§16 矩阵**：可增补 **clean**、**preflight 上游门闸** 等自动化用例。  
- **业务仓**应在 **`.gitignore`** 中忽略 **`.agent-sessions/`**，否则锁文件可能影响「干净树」门闸（§11.4）。

## 6. 评审记录

| 轮次 | 日期 | 范围 | 结论 |
| --- | --- | --- | --- |
| R1 | 2026-05-15 | §4.1～§4.3 + 文档 §11.4 / §4.1 表 | **PASS**（未实现项已标为未开始/部分，与 SSOT 无矛盾） |
| R2 | 2026-05-15 | 重复执行 §4.1 三条命令 + 抽查 §4.2 | **PASS** |
| R3 | 2026-05-15 | **全量**：对照 **`code3.md` §0.1** + §4.1 修正 + **`ai-code3`** 目录脚本逐项；§4.1 自动化 ×1 | **PASS** |
| R4 | 2026-05-15 | 与 R3 **相同**检查与 **§4.1** 自动化 ×1（连续第二轮） | **PASS** |
| R5 | 2026-05-15 | **P2–P9** 能力落地后：`self-test-secret-scan`、`self-test-merge-push`、`smoke` 各 ×1；**`code3.md` §0.1** 与本文 **§1** 同步 | **PASS** |

**结论**：**`docs/spec/code3.md` 全文目标形态仍有「部分」项**（见 **§0.1** 与 **§1** 中 **P4 / P5 / P8 / P10**）；**P2、P3、P6、P7、P9** 已按当前仓库实现对齐文档；**§4.1** 三条自动化门禁最近一次执行 **exit 0**。

*维护：完成阶段后更新 **§1 状态** 与 **§6**。*
