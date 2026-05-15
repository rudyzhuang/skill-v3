# ai-code3 实现规格（Skill V3）

## 0. 文档角色与维护约定（**SSOT**）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 编写 **`ai-code3/SKILL.md`** 与 **`ai-code3/scripts/**/*.cjs`** 时，**以本文为唯一规范来源**。不依赖口头约定或散落 PR 描述。 |
| **与仓库其它文档的关系** | **`docs/input-spec.md`** 描述全流水线跨界语义。本文**已把与 codegen～build 直接相关的硬约束摘录进附录 A**（与 **`docs/spec/prd3.md` §16 附录 A** 字母含义一致：总规摘录）；若未来 `input-spec` 与本文冲突，**以同一 PR 内同步修改为收束方式**：先改业务需求文字，再改本文，再改模板/实现。 |
| **与 `docs/templates/` 的关系** | **JSON / Markdown 字段形状**以 **`docs/templates/stages.json.template`**、**`docs/templates/config.dev.json.template`**（及 release 对档）为准。本文 **§19** 列出 **`stages.json`** 读写子集；**模板字段速查**见 **附录 C**（与 **prd3.md §18 附录 C** 字母含义一致：实现辅助与验收勾选项）；模板增删字段时，**同一维护周期**内更新本文 §19、附录 C 与相关脚本契约。 |
| **`inputs.summary_hash`（全局门闸）** | `input-spec.md` §4.4 要求各阶段维护 `stages.<stage>.inputs.summary_hash`。**`docs/templates/stages.json.template` v1 已在各 `stages.*.inputs` 下提供 `summary_hash` 占位**；ai-code3 在完成各阶段成功路径时须按本文 **§13** 写入/更新非空哈希（与 `input-spec.md` §9.1 additive 规则一致）。 |
| **与上一版 skill 的关系** | **不得**把 v2 仓库路径、SQLite `*_state`、业务仓内旧脚本契约写入 v3 默认实现；经验映射见 **§2**。 |

**维护流程（需求变更时）**：

1. 在本文修改行为/校验/门闸描述。  
2. 若涉及文件形状，同步 **`docs/templates/`** 与（必要时）**`docs/input-spec.md`**。  
3. 再改 **ai-code3** 实现与测试用例（**§16**）。

---

## 1. 定位与读者

| 项目 | 说明 |
| --- | --- |
| **Skill 名称** | `ai-code3` |
| **覆盖阶段** | `codegen`、`typecheck`、`test`、`code-review`、`merge-push`、`build`（对话与文档中 **`code-review`**、**`merge-push`** 用连字符；写入 **`.pipeline/stages.json`** 时键名为 **`code_review`**、**`merge_push`**） |
| **不在本 skill 内** | `prd` / `prd-review` / `design` / `contract` / `design-review`（由 **ai-prd3**、**ai-design3** 承担）；`deploy` / `smoke` / `report`（由 **ai-publish-dev3**、**ai-publish-release3**、**ai-auto3** 承担） |
| **上游** | **ai-design3**：**codegen** 仅当 **`stages.contract`** 与 **`stages.design_review`** 满足本文 **§7** 前置条件时可执行 |
| **下游** | **ai-publish-dev3**：消费 **`stages.build.outputs.artifacts[]`** 与 **`docs/config.dev.json`** 中 deploy 映射 |
| **读者** | 实现 ai-code3 的工程师、维护 `SKILL.md` 与脚本的成员、编排侧需核对门闸字段的开发者 |

**非目标**：不在本文内定稿具体云厂商 CLI、各语言工具链的穷尽列表；须遵守 **附录 A** 与本文 **§14–§15** 的退出码、超时、日志与锁约定。

---

## 2. 与上一版（v2）的关系（仅作心智模型，无兼容承诺）

| v3 | v2 对应 | 关键差异（实现时必须遵守） |
| --- | --- | --- |
| **ai-code3** | `ai-codegen2` + `ai-typecheck2` + `ai-test2` + `ai-code-review2` + `ai-git2` + `ai-build2` | 六段合一；状态真源为 **`.pipeline/stages.json`**，**不**读 v2 SQLite `*_state`、**不**依赖业务仓内 skill 脚本副本 |
| **合并与推送** | ai-git2 | **`stages.merge_push`** 独立门闸；退出码 **6/7** 与总规一致 |
| **迁移** | 各端 `deployment_plan.json` 等 | v3 **不**自动迁移；一次性脚本见 **`docs/input-spec.md` §9.3** |

---

## 3. 设计原则（对齐 `input-spec.md` §3.3）

1. **确定性进脚本**：schema 校验、读写 **`stages.json`**、子进程/超时、git 调度、**diff-guard**、**`inputs.summary_hash`（§13）**、退出码、日志路径，一律在 **`*.cjs`** 中实现。  
2. **创造性进 LLM**：worktree 内实现/测试修补、code-review 清单归纳等，由 **`SKILL.md` 引用的 `prompts/*.md`**（若存在）驱动；**禁止**让 LLM「假装执行」脚本已承担的校验。  
3. **脚本不复制进业务仓**：所有 `*.cjs` 仅存在于 **`<cursor_skills_root>/ai-code3/scripts/`**；调用时必须传入 **`--project=<业务项目根绝对路径>`**；脚本**不得**依赖 `process.cwd()` 推断项目根（**除非**仅用于日志相对路径解析且已用 `--project` 锚定根）。  
4. **`SKILL.md` 保持轻薄**：触发词、I/O 路径表、**§4.3** 子命令表、退出码、与 **ai-design3** / **ai-auto3** 的衔接话术；算法与门闸细节放在本文与脚本。  
5. **模块格式**：Node **CommonJS**（`.cjs`），建议统一入口：  
   `node <skill_dir>/scripts/run.cjs <子命令> --project=<root> [选项]`  
   子命令表见 **§4.3**。

---

## 4. Skill 目录与入口命令

### 4.1 目录结构

```text
ai-code3/
├── SKILL.md
├── SPEC.md                    # 可选：安装到 ~/.cursor/skills 时指向本仓 docs/spec/code3.md
├── prompts/                   # 可选：code-review、test 修复循环等
└── scripts/
    ├── run.cjs                # 建议：唯一 CLI 入口，分发子命令
    ├── preflight.cjs
    ├── codegen.cjs
    ├── typecheck.cjs
    ├── test.cjs
    ├── code-review.cjs
    ├── merge-push.cjs
    ├── build.cjs
    └── lib/
        ├── stages-io.cjs      # 读合并写 stages.json；schema 版本；additive 缺省补齐
        ├── run-with-timeout.cjs
        ├── summary-hash.cjs
        └── secret-scan.cjs   # 附录 B；preflight 可选调用
```

**脚本职责表**（文件名允许微调，但 **门闸 / 状态写回 / 子进程** 不得合并成不可测试的黑盒）：

| 脚本 | 职责 |
| --- | --- |
| `run.cjs` | 解析 `--project`、`--from-stage`、`--to-stage`、`--feature`、`--force-rerun`、`--dry-run`、`--session-id`；串联子流程；统一退出码；日志中带 `failed_stage=` |
| `preflight.cjs` | 校验项目根、`docs/config.dev.json`、`.pipeline/stages.json` 可读及上游门闸；失败 **退出码 1** |
| `codegen.cjs` | **git worktree** 建/复用、契约与设计快照注入、**Cursor Agent（CLI 或 SDK）** 分相调度、可选确定性骨架、**diff-guard**、心跳与超时、回写 **`stages.codegen`**（算法见 **§7.5–§7.12**） |
| `typecheck.cjs` | 静态检查探测与执行；回写 **`stages.typecheck`** |
| `test.cjs` | 测试与 fix-loop；回写 **`stages.test`**、`rollback_to` |
| `code-review.cjs` | 合并 LLM 结构化结论；回写 **`stages.code_review`** |
| `merge-push.cjs` | 合并/推送、锁；回写 **`stages.merge_push`** |
| `build.cjs` | 按端与子平台构建；回写 **`stages.build`** |
| `lib/stages-io.cjs` | 原子写/文件锁、`_schema.version`、**`input-spec.md` §9.1** additive 规则 |
| `lib/run-with-timeout.cjs` | SIGTERM 宽限 → SIGKILL；超时 **退出码 3**；`timed_out` / `duration_ms` / `timeout_reason` |
| `lib/summary-hash.cjs` | **§13** 与 **附录 A · A.3** 跳过判定 |
| `lib/secret-scan.cjs` | **附录 B**：`config.*.json` 键名/值形态扫描；由 **preflight** 可选调用 |

**最小可行路径（MVP）**：可先将逻辑内联在 `run.cjs`，但 **SKILL.md** 须承诺最终目录结构与入口，避免长期单文件不可维护。

### 4.3 `run.cjs` 建议子命令

| 子命令 | 行为 |
| --- | --- |
| （缺省）或 `all` | 自 **codegen** 顺序执行至 **build**（遵守 **附录 A · A.3**「已完成则跳过」三条件） |
| `preflight` | 仅 `preflight.cjs` |
| `codegen` / `typecheck` / `test` / `code-review` / `merge-push` / `build` | 仅执行对应阶段；仍须执行该阶段前置门闸 |

**约定**：校验/门闸失败时退出码 **1**（或 **§14** 规定的其它码），且须将当前阶段 `stages.*.status` 更新为 **`failed`**（或 **`blocked`**，与 **§7–§12** 一致）、`validation.passed=false`，不得长时间滞留 **`running`** 而无 `completed_at`/`failed` 终态（与 **`docs/spec/prd3.md` §4.3** 精神一致）。

---

## 5. 业务项目侧路径契约

路径均相对于 **`<project_root>/`**。

| 路径 | 职责 |
| --- | --- |
| `.pipeline/stages.json` | 编排门闸真源；键名 **`code_review`**、**`merge_push`** 等下划线形式 |
| `docs/config.dev.json` | **timeouts**、**build**、**git** 等非敏感配置；阶段超时与子命令默认由此读取 |
| `docs/config.release.json` | 结构与 dev 对齐；本 skill 默认以 **dev** 配置驱动构建/测试（若将来支持 release 构建须在本文增订） |
| `docs/config.env` | **可选依赖**：默认 typecheck/test/build **不要求**文件存在；仅当脚本显式需要凭证时读取 |
| `.agent-sessions/` | 会话日志、锁、长日志子目录（**应**被 `.gitignore`） |
| **worktree** | 由 **codegen** 创建；路径写入 **`stages.codegen.outputs.worktrees[].worktree_path`** |

**`client_target` 允许值**（与 `stages.json.template` → `client_targets.allowed_values` 一致）：  
`website` / `admin` / `backend` / `miniapp` / `mobile` / `desktop` / `agent`。

---

## 6. 阶段依赖链与「跳过」总览

| 阶段 | `stages.json` 键 | `inputs.requires_stage`（模板） | 附录 A · A.9（`input-spec.md` §7.2）重跑语义（手工） |
| --- | --- | --- | --- |
| codegen | `codegen` | `design_review` | overwrite，须二次确认 |
| typecheck | `typecheck` | `codegen` | idempotent |
| test | `test` | `typecheck` | idempotent |
| code-review | `code_review` | `test` | idempotent |
| merge-push | `merge_push` | `code_review` | destructive，须 explicit confirm |
| build | `build` | `merge_push` | overwrite 产物，默认不须二次确认 |

**跳过**：须**同时**满足 **附录 A · A.3** 三条件（`completed` + `validation.passed` + **`inputs.summary_hash`** 与上游一致）。**`--force-rerun=<stage>`** 忽略 hash 条件；**merge-push** / **codegen** 的 destructive/overwrite 仍须遵守 **`input-spec.md` §7.2** 与本文 **§11**/**§7**。

---

## 7. 阶段：`codegen`

### 7.1 意图

在隔离 worktree 中按契约生成实现与测试代码；**严禁**修改契约产物；diff-guard 未通过则 **退出码 5**。

### 7.2 前置门闸（定稿）

须**同时**满足：

1. **`stages.design_review.status=completed`** 且 **`validation.passed=true`** 且 **`outputs.decision=passed`**（**`needs_design_fix` / `needs_contract_fix` / `failed` / `pending`** 均阻断）。  
2. **`stages.contract.status=completed`** 且 **`validation.passed=true`** 且 **`outputs.human_approval.status`** 为 **`approved`** 或 **`not_required`**（**`pending` / `rejected`** 阻断；若团队只接受其一，须在实现与 `SKILL.md` 写死）。  
3. **`stages.contract.outputs.artifacts[]`** 可解析出五类契约路径（相对 **`<project_root>/`**）。

### 7.3 行为与约束

- **worktree**：按 feature 创建/复用；路径写入 **`worktrees[]`**。  
- **共享代码层**：若设计中指明多端共享修改，须遵守 **`input-spec.md` §8 阶段 3**（与 **`stages.design.outputs.design_specs[].shared_changes[]`** 对齐，字段以当时模板为准）。  
- **diff-guard**：在业务仓**主工作区**对 `stages.contract.outputs.artifacts[]` 解析出的五类契约路径做 **`git diff --exit-code`**（或等价），**在进入会改写文件的 codegen 主路径之前**执行；失败 → **`validation.contract_diff_guard_passed=false`**，退出码 **5**。worktree 内生成结束后，**仍须**对同一批契约路径做「worktree 相对基线分支的 diff 中不得出现契约篡改」的二次守护（语义对齐 v2 **ai-codegen2** diff-guard；实现可合并为单次比较，但不得漏检）。  
- **Agent 真实生成**：在隔离 worktree 的上下文中，分相调用 Agent 完成实现与测试代码落地；调度、超时、跳过与可观测性见 **§7.5–§7.12**。  
- **`inputs.summary_hash`**：见 **§13.1**（**不得**把 Agent 模型名或随机种子纳入哈希；哈希仅绑定确定性输入）。

### 7.4 扩展目标：从「占位完成」到「worktree + Agent 真实生成」

当前 **`ai-code3/scripts/codegen.cjs`** 的过渡实现可在门闸通过后**直接**将 **`stages.codegen`** 标为完成；本节的**目标形态**是：在**不回头改契约**的前提下，为每个待生成 **`feature_id`** 建立（或复用）**git worktree**，注入契约与设计快照上下文，**调用 Cursor Agent** 在允许路径内写入实现与测试代码，并将分支、路径、变更文件列表、子阶段状态写回 **`stages.codegen.outputs`**，供 **typecheck** 及后续阶段消费。

**非目标（仍由其它阶段承担）**：不在 codegen 内做完整业务测试套件（归 **§9**）；不把 **merge / push** 作为 codegen 成功必要条件（默认策略见 **§7.11**）；不把「全量云构建」放在 codegen（归 **§12**）。

### 7.5 与 v2（`ai-codegen2`）能力映射

| v2 概念 / 模块 | v3 落点 |
| --- | --- |
| SQLite **`codegen_state`** 行 | **`stages.codegen.outputs.worktrees[]`** 中**按 `feature_id` 一条**；行级 **`impl_codegen_status` / `test_codegen_status`** 与模板枚举一致 |
| **`generate --feature`** / 批量拓扑 | **`--feature=`** 解析结果 + **`prd_review.review.phase_plan`** 并集；多 feature 时建议读取 **`design_snapshot`（或等价）中的 `depends_on`** 做批次内拓扑序（与 v2 批量 `generate` 一致），**环依赖**须 stderr 警告并退回字典序 + 人工处理 |
| **`.ai-pipeline/worktrees/fc-<id>`** | 推荐 **`<project_root>/.pipeline/worktrees/v3-fc-<feature_id>/`**（与 **`.pipeline/stages.json`** 同根，便于备份/清理约定）；团队可配置覆盖，但**必须**写回 **`worktrees[].worktree_path`** 为**绝对路径** |
| **`invoke-codegen-agent.cjs`（`phase=impl` \| `test`）** | **`ai-code3/scripts/lib/invoke-codegen-agent.cjs`**（规划名）：由 **`codegen.cjs`** 调用；**两相**（实现 → 测试）或「仅实现」由 **`test_spec` 是否要求生成测试**决定 |
| **`post-ai-codegen2-enhance.cjs` 骨架** | **`ai-code3/scripts/lib/codegen-scaffold.cjs`**（规划名）：纯确定性；从 **`design_snapshot`** 的 **`file_plan`** / 契约路径生成占位与目录，**已存在且非占位策略由团队配置**（默认：不覆盖已有实现文件内容，仅保证路径存在） |
| **verify-compile-lint + verify-fix-loop** | **默认**：**主质量门**仍在 **typecheck**（与本 skill **§8** 一致），避免与 v2 重复两套 tsc/eslint 规则。可选 **「codegen 内预科验」**（仅 `--project` 下单 worktree、快速失败）由配置开关控制，**不得**绕过 typecheck |
| **repair-diagnosis + `AI_CODEGEN_EXTRA_CONTEXT`** | **test / code-review / typecheck** 失败后的「回到 codegen」路径：由编排或人工设置 **`AI_CODE3_CODEGEN_EXTRA_CONTEXT`**（规划名，字符串），在 **impl** 相 Agent prompt 头部附加；结构化诊断脚本是否 port 为 **`repair-diagnosis.cjs`** 由实现阶段决定，**语义**须与 **`input-spec.md`** 回退建议一致 |

### 7.6 执行分层（确定性 vs Agent）

与 **§3** 原则一致，边界固定为：

1. **`codegen.cjs` + `lib/*.cjs`**：读 **`stages.json`**、解析 **`artifacts[]`**、创建/挂载 worktree、`git` 状态检查、**diff-guard**、子进程超时、**`run-with-timeout.cjs`**、心跳写 **`.agent-sessions/<session_id>.log`**、收集 **`files_changed`**、更新 **`stages.codegen.status`**（**`running` → `completed` \| `failed`**）、**`inputs.summary_hash`**。  
2. **Agent**：仅在「已给出明确文件边界与契约只读上下文」的前提下，对 **worktree 根目录** 做编辑；**禁止**让 Agent 执行「代替 diff-guard」或「代替 schema 校验」的叙述。  
3. **`SKILL.md` / `prompts/*.md`**：给人与 IDE Agent 的操作说明与提示词模板；**可**与脚本内嵌 prompt 并存，但**同一相**须单一真源（建议：**脚本引用 `prompts/codegen-impl.md` / `codegen-test.md`**）。

### 7.7 Worktree 策略

- **基线分支**：默认 **`project.git.default_branch`**（见 **`stages.json.template`** 的 `project.git`）；允许 **`docs/config.dev.json`** 增加覆盖键（若增加，须同步 **`config.dev.json.template`** 与 **`input-spec.md`**）。  
- **分支命名**：默认 **`v3-fc-<feature_id>`**（与目录后缀一致）；**不得**与 **`merge_push`** 目标保护分支硬冲突；若分支已存在，**`--resume`**（规划 CLI 旗标）或检测到「未完成 **`running`**」时走 **复用挂载**，否则由 **`AI_CODE3_CODEGEN_RESET_BRANCH=yes`** 一类**显式**开关决定是否重置（默认不重置，失败退出 **1** 以免丢工作）。  
- **创建命令语义**：`git worktree add` + **检出基线**；共享 monorepo 下**单仓单 worktree**；**`shared_changes[]`** 只在**被指派为主实现端的 feature** 的 worktree 内修改（与 **`input-spec.md` §8 阶段 3** 一致），其它 feature **不得**重复改同一共享路径。  
- **清理**：**不**在成功路径自动 `git worktree remove`（供 typecheck/test 复用）；提供独立子命令或文档化 **`clean`** 流程（可对标 v2 **`run.cjs clean`**），且须 **destructive** 二次确认。

### 7.8 Agent 调度与可观测性

- **调用面（二选一或并存，实现须写死优先级）**：  
  1. **Cursor Agent CLI**（与 v2 一致：显式二进制路径 **`AI_CODE3_AGENT_BIN`** 或兼容 **`AI_CODEGEN_AGENT_BIN`** 的只读回退）；  
  2. **`@cursor/sdk`** 本地/云端 **headless Agent**（适用于 CI；凭证与网络策略不在本文展开，见 **`docs/input-spec.md`** 与发布运维约定）。  
- **超时**：单相 Agent 调用须有**子超时**（环境变量或 `config.dev.json` 的 **`timeouts.subcommand.*`**）；**所有**子调用累计须在 **`timeouts.stages.codegen_s`** 内结束，否则 **退出码 3**，并写 **`outputs.timed_out=true`**。  
- **跳过 Agent**：**`AI_CODE3_SKIP_AGENT=1`**（或兼容 **`AI_CODEGEN_SKIP_AGENT=1`**）时**不得**调用外部 Agent；仅执行 worktree + 骨架（若启用）；**`outputs.agent.skipped=true`** 与 **`skip_reason`** 写入 **`stages.json`**（见模板）；**`impl_codegen_status` / `test_codegen_status`** 不得假装 **`success`**——应 **`failed`** 或 **`skipped`**（与 **`input-spec.md` §7.1** 枚举一致），除非团队显式允许「骨架即完成」（须在 **`SKILL.md`** 声明为实验模式）。  
- **日志**：每次 Agent 调用将 **request id / session 片段 / 失败摘要** 写入 **`.agent-sessions/`**；stdout/stderr 须含 **`failed_stage=codegen`** 与 **`feature_id=`**（多 feature 时）。

### 7.10 分相流程（推荐实现顺序）

对**单个 `feature_id`**，推荐顺序如下（可在 `codegen.cjs` 内拆函数，但对外仍单次 `run.cjs codegen`）：

1. **`status=running`**：写 **`started_at`**，**`impl_codegen_status=test_codegen_status=pending`**（或进入 **`running`** 子状态，须与 **§7.1** 枚举一致）。  
2. **解析输入**：该 feature 的 **`artifacts[]`** 行（五类路径）+ **`design_snapshot` JSON**（**`file_plan`**、**`depends_on`**、路由/验收摘要）。若 **`design_snapshot`** 缺失且无法从 **`design_specs[].spec_path`** 推导 → **退出 1**。  
3. **Worktree 就绪**：创建或挂载；记录 **`branch`**、**`worktree_path`**。  
4. **（可选）确定性骨架**：`codegen-scaffold`；**lib-research** 类依赖安装若存在 **`lib-research.json`**，复用 **ai-design3** 同源助手脚本的策略（静默失败与否写入 **`validation.warnings`**）。  
5. **Agent · impl 相**：上下文包含：只读契约文件内容或路径清单、**`file_plan.new_files/modify_files`**、**`AI_CODE3_CODEGEN_EXTRA_CONTEXT`**；**不得**包含主仓未提交的契约 diff。  
6. **worktree 内 diff-guard**：确认契约路径相对 **HEAD/基线** 无篡改 → 否则 **退出 5**。  
7. **Agent · test 相**（若 **`test_spec`** 要求且存在测试生成目标）：否则 **`test_codegen_status=skipped_no_spec`**。  
8. **收集产物**：对比 **`file_plan`** 得到 **`files_expected`** vs **`files_changed`**；测试文件同理。缺失 **expected** → **退出 4**（实现质量门）或 **1**（由实现固定，须在 **`SKILL.md`** 二选一并与 **§14** 不冲突）。  
9. **（可选）预科验**：tsc/eslint 快速探测；失败可 **退出 4** 或仅写 **`validation.warnings`**（默认不写死，避免与 typecheck 重复）。  
10. **`summary_hash` 写入**、**`status=completed`**、**`validation.passed=true`**；若默认 **auto-commit**：将 **`commit`** 写入对应 **`worktrees[]`** 元素；**`--no-commit`** 时为空字符串并写 **`validation.warnings`**。

### 7.11 配置、环境与 CI

- **阶段超时**：**`timeouts.stages.codegen_s`**（默认 **1800**，见 **`input-spec.md` §6.1**）。  
- **心跳**：**`timeouts.subcommand.heartbeat_interval_s`**（默认 **30**）向会话日志追加 **`alive: stage=codegen`**。  
- **CI 建议**：默认 **`AI_CODE3_SKIP_AGENT=1`** 跑「门闸 + worktree 创建 + 骨架」冒烟；**真实填码**在开发者本机或受凭证保护的 runner 上执行。  
- **与 `merge-push` 的边界**：codegen **默认**在 worktree 内 **`git commit`**（与 v2 默认一致）；**禁止**在 codegen 内 **`git push`**。

### 7.12 状态写回与下游对齐

- **`stages.codegen.outputs.worktrees[]`**：每个元素须含模板所列字段；**`worktree_path`** 为绝对路径；**`commit`** 在 **`--no-commit`** 时允许空字符串。  
- **`impl_codegen_status` / `test_codegen_status`**：对多 feature 聚合规则：**任一端 `failed` → 整体 `validation.passed=false`**；**`skipped`** / **`skipped_no_spec`** 须可解释并在 **`validation.summary`** 简述。  
- **`outputs.agent`**：见 **`stages.json.template`**；记录 **`mode`**（如 **`cursor_cli` / `cursor_sdk` / `none`**）、**`model`**、是否 **`skipped`**。  
- **下游 typecheck**：继续以 **`stages.codegen.outputs.worktrees[]`** 为唯一 worktree 列表真源（与当前 **`typecheck.cjs`** 一致）。

---

## 8. 阶段：`typecheck`

### 8.1 意图

在 **codegen** 工作区跑静态检查；**不**运行业务测试套件（归 **§9**）。

### 8.2 前置与行为

- **前置**：**codegen** 成功且 **`worktrees`** 路径有效。  
- **探测**：`tsc` / `eslint` / `mypy` / `pyright` 等；未探测到工具时 **`skipped`/`tool_missing`** 须有 **`skip_reason`**（与 **`input-spec.md` §8 阶段 7** 一致）。  
- **失败**：任一已执行工具非 0 → 推荐 **退出码 4**（或 **1** 表示「环境缺失」——须在 **`SKILL.md` 与实现二选一并固定**）。

---

## 9. 阶段：`test`

### 9.1 意图

运行测试；有限次 **fix-loop**；**不得**在循环内修改契约；失败时写 **`rollback_to`**。

### 9.2 行为

- 命令优先 **`docs/config.dev.json.build.commands.test`**；否则探测 `npm`/`pytest`/`cargo` 等。  
- **`build.commands.test_max_fix_attempts`**（默认 **3**）为上限。  
- **`stages.test.outputs.result`** 枚举与 **`rollback_to`** 见模板与 **`input-spec.md` §7.1**。

### 9.3 与编排的职责划分

**不**由本 skill 直接调用 **ai-design3** / **ai-code3** 的上游子流程；仅写 **`rollback_to`** 建议，由 **ai-auto3** 或人工决定续跑入口（**`input-spec.md` §5** 与 **§8 阶段 8**）。

---

## 10. 阶段：`code-review`

### 10.1 意图

对照契约做完整性检查；**critical** 问题阻断 **merge-push**。

### 10.2 通过条件（默认 strict）

- **`critical_issues===0`** 且 **`outputs.decision=passed`**。  
- **`passed_with_warnings`**：默认视为质量门失败（**退出码 4**）；仅当将来 **`config.dev.json`** 增加显式开关（如 **`code_review.strict_warnings=false`**）且为 **false** 时允许视为通过——**开关不存在时禁止静默放宽**。

### 10.3 字段隔离

**不得**篡改 **`stages.test`** / **`stages.typecheck`** / **`stages.codegen`** 的通过/失败字段。

---

## 11. 阶段：`merge-push`

### 11.1 意图

合并 worktree 回目标分支；可选 **push**；只写 merge/push 状态，**不**改写测试结果。

### 11.2 锁与路径

- 锁：**`.agent-sessions/locks/merge-push.pid`**（**附录 A · A.5**）。  
- **`push_status`** 枚举仅 **`not_requested` / `pending` / `pushed` / `failed`**（**无** `skipped`）。

### 11.3 退出码

合并冲突 → **6**；推送失败 → **7**。

---

## 12. 阶段：`build`

### 12.1 意图

为需编译产物的端生成 **artifact**；**不在本阶段调用云 API**（**退出码 8** 保留给误用云 CLI 时的语义一致性）。

### 12.2 行为

- **`build.client_targets.<target>.sub_platforms[]`**（见 **`input-spec.md` §8 阶段 11**）。  
- **命令优先级**：`build.client_targets.<target>` 覆盖 > 顶层 **`build.commands.build`/`install`** > 探测；**`client_targets: {}`** 时须容忍并走回退链。  
- **`backend`** 可 **`not_applicable`** 并记录原因。  
- 产物写入 **`stages.build.outputs.artifacts[]`**，含 **`artifact_path`**、**`log_path`**。

---

## 13. `inputs.summary_hash`（跨阶段漂移门闸）

**算法固定为 SHA-256**，输出 **64 位小写十六进制字符串**，写入各阶段 **`stages.<stage>.inputs.summary_hash`**（模板已占位）。

### 13.1 `stages.codegen.inputs.summary_hash`

建议在标记 **codegen** 完成前计算，输入字节序列至少包含（UTF-8、换行规范化、键名排序稳定后拼接）：

- 本期 **`feature_id`** 列表（来自 **`prd_review.review.phase_plan`** 或脚本参数 `--feature` 的解析结果）；  
- **`stages.contract.outputs.artifacts[]`** 指向的各契约文件 **canonical 全文**；  
- **`stages.design_review.outputs.decision`** 与 **`alignment_summary`**（或等价摘要字段）。

### 13.2 `stages.typecheck` / `test` / `code_review`

建议在上游阶段 **`summary_hash`** 与 **worktree 路径列表**稳定后，对「上游 hash + 本阶段相关 `worktrees[]` 子集 + 本阶段用到的 `config.dev.json` 片段（如 `build.commands`）」做规范序列化后 SHA-256。

### 13.3 `stages.merge_push` / `build`

- **merge_push**：建议包含 **code_review.inputs.summary_hash**、**目标分支名**、**`git.allow_push`** 意图。  
- **build**：建议包含 **merge_push.inputs.summary_hash**、**`build.client_targets` 中与构建相关的 canonical JSON 子树**。

**说明**：全局「谁负责把下游 `validation.passed` 打回 false」可由 **ai-auto3** 或独立漂移检测实现；ai-code3 **负责在成功完成各阶段时写入正确哈希**。

---

## 14. 退出码

与 **`docs/input-spec.md` §5** 一致（摘录见 **附录 A**）。**ai-code3** 常用子集：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 前置失败、schema、门闸、配置缺失 |
| 2 | 用户取消 |
| 3 | 超时 / 外部工具或 Agent 异常（可重试） |
| 4 | 质量门失败（typecheck / test / code-review / build） |
| 5 | 契约被破坏（diff-guard） |
| 6 | Git 合并冲突 |
| 7 | Git 推送失败 |
| 8 | 云平台 API 失败（本 skill **默认不应**触发） |

**合成 skill**：stderr/日志须含 **`failed_stage=codegen|typecheck|...`**。

---

## 15. 超时与观测

- **配置键**：`docs/config.dev.json` → **`timeouts.stages.codegen_s`**、**`typecheck_s`**、**`test_s`**、**`code_review_s`**、**`merge_push_s`**、**`build_s`**（键名与 **`config.dev.json.template`** 一致）。  
- **子命令超时**：`timeouts.subcommand.*`；不得超过当前阶段超时；超时 → **退出码 3**，并写 **`outputs.timed_out` / `duration_ms` / `timeout_reason`**（**附录 A · A.6**）。  
- **心跳**：**codegen** / **test** / **build** 长时阶段按 **`heartbeat_interval_s`** 写入 **`.agent-sessions/<session_id>.log`**。  
- **手工单跑**：受阶段超时约束；**不受** **`autorun_total_s`** 约束（无外层 autorun）。  
- **日志与锁路径**：见 **附录 A · A.5**；**merge-push**、可选 **build** 锁 scope 与锁文件 JSON 行格式。

---

## 16. 测试与验收（实现者自检）

| 用例 | 期望 |
| --- | --- |
| 无 `.pipeline/stages.json` | **退出 1**，stderr 可定位路径 |
| **design-review** 非 `passed` 启动 codegen | **退出 1** |
| 契约文件被 touch 后 diff-guard | **退出 5**，`contract_diff_guard_passed=false` |
| typecheck 全 skip | 有 **`skip_reason`**；工具失败 | **退出 4**（若实现选 **1** 须在 `SKILL.md` 固定） |
| test 耗尽 **`test_max_fix_attempts`** | **`result`** 为 **`failed_max_attempts`** 或等价；**`rollback_to`** 有建议 |
| code-review **`critical_issues>0`** | **退出 4**；不改写 **test** 结果字段 |
| merge 冲突 | **退出 6** |
| **`allow_push=false`** | **`push_status=not_requested`**（枚举无 `skipped`） |
| build **website** 有 **`artifact_path`**；**backend** 可 **`not_applicable`** | |
| 人为缩短 **`typecheck_s`** 挂起子命令 | **退出 3** 且 **`timed_out=true`** |
| 跳过三条件满足后再次运行 | 打印「本阶段已完成」、不重复改 git |
| **`--force-rerun=merge_push`** 无确认 | **退出 1** 或拒绝执行 |

---

## 17. 模板与 skill 发布同步

1. **`docs/templates/`**（本仓）为模板 **authoring 真源**。  
2. 发布 **ai-code3** 时若随 skill 分发模板，须与上述目录**同版本**拷贝（或构建脚本同步）。  
3. **additive** 变更：旧项目缺键时脚本 **默认补齐**（**`input-spec.md` §9.1**）。  
4. **breaking** 变更：升 **`_schema.version`** + **`docs/templates/migrations/`** 文档；skill 遇高于支持版本的 schema **退出 1**。

---

## 18. 待决项（实现前关闭）

| ID | 内容 | 关闭条件 |
| --- | --- | --- |
| T1 | typecheck「工具全缺失」时 **退出 1** 与 **`skipped`+退出 0** 二选一 | 写入 **`SKILL.md`** + 本文 **§8.2** 定稿一句 |
| T2 | LLM 产出 JSON 的 **JSON Schema** 是否随 skill 分发 | 已定稿路径并入 **§4.1** 目录树 |

---

## 19. `stages.json` 读写子集检查表

读写 **`stages-io.cjs`** 时须保留其它阶段键（**merge** 策略与 **`docs/spec/prd3.md` §15** 一致）。ai-code3 关心的键：

**顶层**：`pipeline`（可选更新 **`current_stage`** / **`updated_by`** / **`updated_at`**，若实现统一编排指针）、`stages.codegen`、`stages.typecheck`、`stages.test`、`stages.code_review`、`stages.merge_push`、`stages.build`、`logs`（若写入会话索引）。

各阶段须维护：**`status`**、**`started_at`** / **`completed_at`**（或失败时的时间戳策略）、**`inputs`**（含 **`requires_stage`**、**`summary_hash`**）、**`outputs`**（含 **`duration_ms`**、**`timed_out`**、**`timeout_reason`**）、**`validation`**。

---

## 20. 附录 A：从 `input-spec.md` 摘录的硬约束（ai-code3 相关）

以下条文直接约束 **ai-code3** 实现；**章节号为 `input-spec.md` 正文章节**（便于回去对读）。若 `input-spec` 修订导致冲突，以 **§0 维护流程**收束。

与 **`docs/spec/prd3.md` §16 附录 A** 字母含义一致：**附录 A = 总规（`input-spec.md`）摘录**。

### A.1 脚本与业务配置（§3、§3.3）

- **Skill 脚本**只保留在 skill 安装目录；**不**复制到业务项目维护。  
- **cjs** 承担：schema、I/O、**`stages.json`** 写回、前置 checklist、PID 锁、退出码、子进程与超时、git/构建 CLI 组合、日志归集。  
- **LLM** 不承担上述确定性流程。  
- 统一 **`node <skill_dir>/scripts/<name>.cjs --project=<root> ...`**；**CommonJS（`.cjs`）**。

### A.2 `stages.json` 真源与键名（§3.1）

- 路径：**`<project_root>/.pipeline/stages.json`**。  
- 正文阶段名用连字符，**JSON 键用下划线**（如 **`code_review`**、**`merge_push`**）。

### A.3 「已完成则跳过」与强制重跑（§4.4）

须**同时**满足：

1. **`stages.<stage>.status="completed"`**  
2. **`stages.<stage>.validation.passed=true`**  
3. **`stages.<stage>.inputs.summary_hash`** 与上游最新输出一致  

**`--force-rerun=<stage>`** 可忽略第 3 条；**destructive** 阶段须 **explicit confirm**（**`input-spec.md` §7.2**）。

### A.4 退出码表（§5）

全文语义表：**0 成功；1 前置/配置；2 取消；3 超时/可重试外部失败；4 质量门；5 契约破坏；6 合并冲突；7 推送失败；8 云 API**。  
**超时**统一映射为 **3**，并写 **`timed_out`**（**`input-spec.md` §6.1**）。  
**测试失败回退**：测试 skill **不越权**改写无关阶段；编排读 **`rollback_to`**（**`input-spec.md` §5** 末段）。

### A.5 日志、锁、轮转（§6）

- 会话日志：**`.agent-sessions/<session_id>.log`**；长日志：**`.agent-sessions/logs/`**。  
- **PID 锁**：**`.agent-sessions/locks/<scope>.pid`**；**`merge-push`**、**`build`** 为相关 scope。  
- 锁体：单行 JSON（**`pid`**、**`session_id`**、**`started_at`**、**`skill`**）。  
- 同 scope 已运行 → **退出 1**；过期 PID 锁可清理。

### A.6 超时默认值与心跳（§6.1）

与本 skill 相关的默认阶段超时（秒）：**codegen 1800**；**typecheck 600**；**test 1800**；**code-review 600**；**merge-push 300**；**build 1800**（配置键见 **`config.dev.json.template`**）。  
**软中断**：SIGTERM + **5s** 清理窗口 → SIGKILL。  
**心跳**：长时阶段约 **30s** 一次写入会话日志。

### A.7 阶段 I/O 总表摘录（§7，codegen～build）

| 阶段 | 要点 |
| --- | --- |
| **codegen** | 输入为已校验契约；输出为实现与测试生成状态；**严禁**改契约（diff-guard） |
| **typecheck** | 不跑单元测试；工具缺失须可解释跳过 |
| **test** | fix-loop 有上限；**`rollback_to`** |
| **code-review** | 对照契约完整性；**critical** 阻断合并 |
| **merge-push** | 不篡改测试通过字段；冲突/推送失败映射 **6/7** |
| **build** | 纯产物；**deploy** 不隐式重建；子平台与 **artifact** 校验见 **`input-spec.md` §8 阶段 11** |

### A.8 状态枚举摘录（§7.1，与本 skill 强相关）

- **`design_review.outputs.decision`**：**`pending` / `passed` / `failed` / `needs_design_fix` / `needs_contract_fix`**  
- **`code_review.outputs.decision`**：**`pending` / `passed` / `failed` / `passed_with_warnings`**  
- **`merge_push.outputs.push_status`**：**`not_requested` / `pending` / `pushed` / `failed`**（**不得**使用 **`skipped`**）  
- **`test.outputs.result`**、**`test.rollback_to`**、**`build.outputs.artifacts[].status`**：以模板与 **`input-spec.md` §7.1** 为准。

### A.9 重跑语义矩阵摘录（§7.2）

| 阶段 | 语义 | 手工二次确认 |
| --- | --- | --- |
| **codegen** | overwrite | 是 |
| **typecheck** | idempotent | 否 |
| **test** | idempotent；修复循环计数清零 | 否 |
| **code-review** | idempotent | 否 |
| **merge-push** | destructive | **是（强制）** |
| **build** | overwrite 产物 | 否 |

### A.10 执行一致性（§8.1）

手工单阶段与 **ai-auto3** 自动串联在**相同输入与规则**下，各阶段产出应对齐；**destructive** 须 explicit confirm。

### A.11 阶段约束草案摘录（§8）

- **阶段 6 codegen**：隔离实现；**契约保护**；测试代码同步；状态写 **`stages.codegen`**。  
- **阶段 7 typecheck**：工具探测；失败阻断 **test**。  
- **阶段 8 test**：**`max_fix_attempts`**；失败归因与 **`rollback_to`**；**不**在修复中改契约。  
- **阶段 9 code-review**：清单与分级；**字段隔离**。  
- **阶段 10 merge-push**：合并策略与冲突处理；**push** 失败区分。  
- **阶段 11 build**：多端探测；**子平台**声明；**产物校验**；与 **deploy** 边界。

### A.12 模板 schema 演进（§9.1）

- **additive**：可默认补齐缺失字段。  
- **breaking**：升 **`_schema.version`** + 迁移说明；高于 skill 支持版本 → **退出 1**。

---

## 21. 附录 B：`config.*.json` 密钥与键名扫描

与 **`docs/spec/prd3.md` §17 附录 B** 字母含义一致：**附录 B = `config.*.json` 安全扫描规则**。

**`preflight.cjs`**（或等价模块）在读取 **`docs/config.dev.json`** / **`docs/config.release.json`** 做门闸时，**建议**执行与 **ai-prd3** 同构的扫描（实现可 **`import`** / 拷贝 **`docs/spec/prd3.md` 附录 B** 所述逻辑到 `scripts/lib/secret-scan.cjs`**）：

1. 读取两份 JSON 中的 **`security.forbidden_json_key_patterns`** 数组，对 **所有嵌套对象的键名** 做**子串匹配**（大小写策略须固定，建议 **小写化后匹配**）；命中任一模式 → **失败**（退出码 **1**）。  
2. 对 string 值做常见密钥形态启发式（如 `BEGIN PRIVATE KEY`、`sk_live_` 等）——具体模式列表维护在脚本常量，**须写入单测**。  
3. **`docs/config.env`**：允许值为空或占位符；若值非空，**不得**在日志中打印完整值。

> **说明**：ai-code3 默认不强制要求 **`config.env`** 文件存在（见 **§5**）；但若 preflight 选择扫描 **`config.*.json`**，则**须**完整执行本条，与 **`input-spec.md` §3**「密钥与 JSON 隔离」一致。

---

## 22. 附录 C：模板速查与 `SKILL.md` 必备目录

与 **`docs/spec/prd3.md` §18 附录 C** 字母含义一致：**附录 C = 模板子集提示 + 实现后 `SKILL.md` 验收勾选项**。

### C.1 模板字段速查（ai-code3 相关）

实现时应以 **`docs/templates/stages.json.template`** 全文为准。

- **codegen**：`inputs.requires_stage: "design_review"`，`outputs.worktrees[]`，**`validation.contract_diff_guard_passed`**  
- **typecheck**：`inputs.worktrees`，**`outputs.tools[]`**  
- **test**：**`rollback_to`**，**`outputs.result`**  
- **code_review**：**`outputs.checklist[]`** 默认 **`key`** 列表  
- **merge_push**：**`merge_status`**、**`push_status`**（仅四类枚举）  
- **build**：**`outputs.artifacts[]`**（**`sub_platform`**、**`artifact_path`**）

### C.2 `SKILL.md` 必备目录（验收勾选项）

- [ ] Frontmatter：`name`、`version`、`description`（含触发词 **ai-code3**、第三代、codegen～build）。  
- [ ] §0 指向本文路径（仓库内相对路径 **`docs/spec/code3.md`**）。  
- [ ] 覆盖阶段 / **非**覆盖阶段（与 **§1** 一致）。  
- [ ] I/O 路径表（等同 **§5**）。  
- [ ] **`run.cjs` 子命令表**（等同 **§4.3**）。  
- [ ] **退出码表**（等同 **§14**）。  
- [ ] 与 **ai-design3**、**ai-publish-dev3**、**ai-auto3** 的衔接话术。  
- [ ] **禁止项**：不改契约、不隐式 deploy、不并行抢写 **`stages.json`**。  
- [ ] **`--force-rerun`** 与 **merge-push** destructive 确认约定（**附录 A · A.3** / **`input-spec.md` §7.2**）。  
- [ ] **preflight**：若扫描 **`config.*.json`**，须实现 **附录 B**（可与 **`docs/spec/prd3.md` §17** 共享 `secret-scan` 实现或文档对齐）。

---

## 23. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.1 | 2026-05-15 | 初稿 |
| 0.2 | 2026-05-15 | 评审修订：§0 SSOT、门闸收紧、`push_status`、summary_hash 等 |
| 0.3 | 2026-05-15 | 与 **`docs/spec/prd3.md` 同构**：章节重组（§0–§19 + 附录）；系统化摘录 **`input-spec.md`**（**0.4** 起该摘录固定为 **附录 A**，与 prd3 字母含义一致）；§0 与模板 **`summary_hash`** 占位描述对齐 prd3 |
| 0.4 | 2026-05-15 | 附录字母与 **prd3** 对齐：**附录 A** = `input-spec` 摘录；**附录 B** = `config.*.json` 密钥/键名扫描；**附录 C** = 模板速查 + **`SKILL.md`** 清单；全文交叉引用已更新 |

---

*文档版本：与 `docs/input-spec.md`、`docs/templates/stages.json.template` v1、`docs/templates/config.dev.json.template` v1 当前检入对齐；变更时请走 **§0** 维护流程。*
