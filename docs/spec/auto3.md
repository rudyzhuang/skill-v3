# 第三代自动编排规格（Auto3 / ai-auto3）

## 0. 文档角色与维护约定（**SSOT**）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 编写 **`ai-auto3/SKILL.md`**、**`ai-auto3/scripts/**/*.cjs`**（含 **`autorun.cjs`**、**`gen-report.cjs`**）以及本机 **`~/.cursor/skills/_registry/registry.sqlite`** 的初始化/升级逻辑时，**以本文为规范来源**。编排行为不依赖口头约定。 |
| **与 `docs/input-spec.md` 的关系** | 全流水线跨界语义（阶段链、退出码表、日志与 PID 锁、三层超时、`stages.json` 真源、**destructive** 与 **opt-in**、`inputs.summary_hash` 跳过规则等）以 **`docs/input-spec.md`** 为总纲。本文把 **仅与 ai-auto3 相关的条款** 收束为可执行规划；若冲突，收束顺序：**先改 `input-spec` + `docs/templates/` → 再改本文 → 再改 skill 实现**。 |
| **与 `docs/templates/` 的关系** | **`stages.json`** 中 **`report`** 与 **`pipeline.*`**（**项目侧**编排状态）等键、**`config.dev.json.timeouts`**（含 **`autorun_total_s`**、各 **`stages.*_s`**）、**`config.dev.json.pipeline.autorun.allow_destructive_deploy`**（**配置侧** dev autorun deploy 授权，勿与 **`stages.json` 的 `pipeline` 节**混淆）以对应 **`* .template`** 为字段真源。模板演进遵守 **`input-spec.md` §9.1**（additive / breaking）。 |
| **与上一版（v2）的关系** | 本版 **不**读取业务仓内 v2 **`autorun` / `autorun-pro` 脚本副本**、v2 **`stages.json`** 旧路径或 v2 编排专用 SQLite 作为默认真源。心智映射：**ai-auto3** ≈ **autorun** + **autorun-pro**；**ai-dash2** 的看板职能由 **`ai-dash3`** 承担（见 **`docs/spec/dash3.md`**）。**默认终点**为 **dev deploy + smoke + ui_e2e（可选）+ report**，**release 不默认跟随**（见 **`input-spec.md` §4.3**、**`docs/spec/e2e3.md`**）。 |

**维护流程（需求变更时）**：

1. 在本文修改编排顺序、门闸、脚本职责、CLI、验收清单。  
2. 若涉及 **`stages.json` / `config.*.json`** 形状或超时键名，同步 **`docs/templates/`** 与（必要时）**`docs/input-spec.md`**。  
3. 再改 **ai-auto3** 实现，并跑通 **§12** 验收项。

---

## 1. 文档目的、读者与自身完整性

| 项目 | 说明 |
| --- | --- |
| **目的** | 作为创建 **Cursor Agent Skill：`ai-auto3`** 及其 **`scripts/*.cjs`**（核心是 **`autorun.cjs`**、**`gen-report.cjs`**）与 **本机 registry SQLite** 的**详细规划与实施指引**：目录布局、CLI、启动前置 checklist、阶段循环与子 skill 调用契约、PID 锁与超时、退出码传递、**report** 收口、与 **`ai-design3` / `ai-code3` / `ai-publish-dev3`** 的边界。 |
| **读者** | 实现与 review **ai-auto3** 的工程师或 Agent；维护其它 **ai-*3** 时需核对「编排层会何时调用我、会传什么超时」的成员。 |
| **自身完整性** | 未读 **`input-spec.md`** 的读者仍可依 **§2–§11** 完成 **MVP**；**§13** 为与全仓文档的交叉索引；**§12** 为验收清单。 |
| **非目标** | 不在本文内定义各业务阶段的 LLM prompt、契约格式、云厂商 CLI；这些分别由 **ai-design3**、**ai-code3**、**ai-publish-dev3** 等规格与模板承担。 |

---

## 2. 定位：单一 skill、明确起止

### 2.1 一句话职责

**ai-auto3** 实现 **pipeline 的自动推进**：自 **`design`** 起，按固定阶段链调用各 **ai-*3** 子流程，并提供 **前置校验、PID 锁、子进程退出码解读、停跑策略、末尾 report** 四类托底（对齐 **`input-spec.md` §4.3**）。**只看进度、不自动跑**请使用 **`ai-dash3`**（**`docs/spec/dash3.md`**），避免与本 skill 混淆。

### 2.2 默认阶段链（自动序列）

自左向右为默认推进顺序（文档阶段名用**连字符**；写入 **`.pipeline/stages.json`** 时用**下划线**键名）：

`design` → `contract` → `design-review` → `codegen` → `typecheck` → `test` → `code-review` → `merge-push` → `build` → `deploy`（**dev**）→ `smoke` → `ui_e2e`（可选，`ui_e2e.enabled`）→ `report`

**刻意不包含**：

| 排除项 | 原因 |
| --- | --- |
| **`prd` / `prd-review`** | 须在 **ai-prd3** 内人工收敛完毕后再开自动编排，避免需求未评审即长跑（**`input-spec.md` §4.3**）。 |
| **`ai-publish-release3` / release 环境默认自动 deploy** | 降低误发线上风险；release 仅人工或独立策略触发（**`input-spec.md` §4.3**、**`docs/spec/publish3.md` §2.3**）。 |

### 2.3 子 skill 映射（实现时的「被调用方」）

| 阶段范围 | 调用的 skill（安装目录名） | 备注 |
| --- | --- | --- |
| `design` → `contract` → `design-review` | **ai-design3** | 须支持「仅跑某段」或「一次跑多段」；见 **`docs/spec/design3.md` §8**。 |
| `codegen` → `build` | **ai-code3** | 见 **`docs/spec/code3.md`**（含 **git worktree**、**Cursor Agent** 分相生成、**`stages.codegen.outputs.agent`** 与 **`worktrees[]`** 真源；编排层调用 **`run.cjs`** 时须传递 **`--project`**，并须遵守 **§5.6** 对 **`--feature`** 与并行的约定；阶段超时与心跳见 **`input-spec.md` §6.1**）。 |
| `deploy`（dev）→ `smoke` | **ai-publish-dev3** | 见 **`docs/spec/publish3.md`**。 |
| `ui_e2e`（可选） | **ai-e2e3** | 见 **`docs/spec/e2e3.md`**；须 **`ui_e2e.enabled===true`**。 |
| `report` | **本 skill** 的 **`gen-report.cjs`** | 不单独拆 skill（**`input-spec.md` §4.2**）。 |

**调用约定（推荐）**：子 skill 若提供 **`scripts/run.cjs`**，编排层应通过固定形态调用，例如：

`node <cursor_skills_root>/<skill_name>/scripts/run.cjs <子命令> --project=<业务项目根绝对路径> [其它选项]`

其中 **`<cursor_skills_root>`** 默认 **`~/.cursor/skills`**（与 **`input-spec.md` §一** 一致）。**禁止**依赖 `process.cwd()` 推断项目根；**必须**传入 **`--project`**（与 **§3** 一致）。

**ai-code3 特例**：凡由 **ai-auto3** spawn 的 **ai-code3** 调用，**必须**额外携带 **`--feature=...`**（非空），规则见 **§5.6**；不得依赖「未传 `--feature` 时由 ai-code3 从 `prd_review` 隐式展开」作为编排默认行为。

---

## 3. 架构原则（对齐 `input-spec.md` §3.3）

1. **确定性进脚本**：前置 checklist、读写 **`.pipeline/stages.json`（仅限编排允许改写的键，见 §5.2）**、PID 锁、子进程启停与超时、退出码分类、**registry 导入/对齐**、日志路径解析，一律在 **`.cjs`** 中实现。  
2. **创造性不进编排核心**：不向 LLM 索取「是否该进入下一阶段」等决策；阶段完成与否以 **`stages.json`** 与 **§6** 的跳过规则为准。  
3. **脚本只驻留在 skill 目录**：`<cursor_skills_root>/ai-auto3/scripts/**`；**不**复制到业务项目。  
4. **`SKILL.md` 保持轻薄**：触发词、必读路径表、**如何一行命令开跑**、退出码、与 **ai-prd3 / ai-design3 / ai-publish-dev3** 的衔接话术；**不**内联阶段循环伪代码。  
5. **CommonJS**：统一 **`.cjs`**；启动方式 **`node <skill_dir>/scripts/<name>.cjs ...`**。  
6. **状态真源**：业务仓库内 **`<project_root>/.pipeline/stages.json`**；本机 **`registry.sqlite`** 仅为缓存与索引，须可从 **`stages.json`** 重建（**`input-spec.md` §3.2**）。

---

## 4. Skill 目录与入口规划

### 4.1 目录结构（定稿建议）

```text
ai-auto3/
├── SKILL.md
├── SPEC.md                    # 可选：安装到 ~/.cursor/skills 时指向本仓 docs/spec/auto3.md
└── scripts/
    ├── autorun.cjs            # 自动推进主入口：checklist → 锁 → 阶段循环 → gen-report
    ├── gen-report.cjs         # report 生成器：读 stages + 日志索引，写报告文件 + stages.report
    ├── preflight.cjs          # 可选：从 autorun 拆出 §5.1 六项，便于单测
    ├── registry-sync.cjs      # 可选：project 导入/对齐 SQLite
    ├── registry-export.cjs    # 只读导出 registry → JSON（供 ai-dash3 Web 等消费）
    └── lib/
        ├── paths.cjs          # --project 解析、docs/.pipeline/.agent-sessions 路径
        ├── stages-io.cjs      # 读合并写 stages.json；仅允许改写键见 §5.2
        ├── checklist.cjs      # §5.1 实现
        ├── pid-lock.cjs       # §8.1；scope = pipeline
        ├── run-with-timeout.cjs
        ├── exit-codes.cjs     # §7 映射与向上传递
        ├── child-invoke.cjs   # 统一 spawn、env 注入、日志 tee
        └── registry-db.cjs    # SQLite DDL 与 upsert
```

**最小可行路径（MVP）**：可将 **preflight / registry-sync** 内联进 **`autorun.cjs`**，但 **§12** 验收项仍须全部满足。

### 4.2 `SKILL.md` 应写清的内容

- 触发词（示例）：「**ai-auto3**」「第三代自动编排」「从设计自动跑到 dev 冒烟」「autorun」。  
- **前置条件**：**ai-prd3** 已完成 **`prd` + `prd-review`** 且 **`stages.json`** 满足 **§5.1**。  
- **必读路径**：**`.pipeline/stages.json`**、**`docs/config.dev.json`**、**`docs/config.release.json`**、**`docs/config.env`**、**`.agent-sessions/`**。  
- **默认不包含 release**；如何人工跑 **ai-publish-release3** 的话术（指向上游规格）。  
- **退出码表**（**§7**）与 **日志/PID 锁**（**§8**）指针。  
- **显式调用脚本**：例如「在项目根于 Agent 中执行：`node ~/.cursor/skills/ai-auto3/scripts/autorun.cjs --project=$(pwd)`」。

### 4.3 `autorun.cjs` CLI（建议形态）

| 选项 / 位置参数 | 必填 | 说明 |
| --- | --- | --- |
| **`--project=<abs_path>`** | 是 | 业务项目根目录绝对路径。 |
| **`--from-stage=<stage>`** | 否 | 默认 **`design`**；不得早于 **`design`**（若传入 **`prd`** 等应退出码 **1**）。 |
| **`--to-stage=<stage>`** | 否 | 默认跑到 **`report`**；若仅跑到 **`build`** 等，仍须在序列末尾调用 **`gen-report.cjs`** 与否由产品决定——**本版定稿**：默认序列**始终**以 **`report`** 收尾（与 **`input-spec.md` §4.3** 一致）。 |
| **`--force-rerun=<stage>`** | 否 | 忽略 **§6**「已完成」判定，强制重跑该阶段；**destructive** 阶段仍须满足 **§6.3** 与 **`input-spec.md` §7.2**。 |
| **`--session-id=<id>`** | 否 | 若缺省则由脚本生成 UUID；用于 **`.agent-sessions/<session_id>.log`** 与锁 JSON 内字段。 |
| **`--dry-run`** | 否 | 只打印将执行的阶段与跳过原因，不申请锁、不 spawn 子 skill（可选 MVP+）。 |
| **`--features=<id[,id...]>`** | 否 | **仅影响 ai-code3 段**：限定本期自动跑 **`codegen`→`build`** 所覆盖的 **`feature_id`** 集合；须为 **`stages.prd_review.review.phase_plan[*].feature_ids`** 去重后的**子集**；非法或越界 id → 退出码 **1**。缺省时默认等于「phase_plan 合并全集」（与 checklist 非空一致）。**spawn 时**按 **§5.7** 先分组，再对每个 group 显式传 **`--feature=<组内 id 列表>`**（见 **§5.6**）。 |

**子命令（可选扩展）**：

| 子命令 | 职责 |
| --- | --- |
| **`node .../autorun.cjs run`** | 与无子命令同义，默认全序列。 |
| **`node .../autorun.cjs preflight-only`** | 仅执行 **§5.1**，用于 CI 或 Agent 预检。 |
| **`node .../autorun.cjs sync-registry`** | 仅执行 **§5.1#6 + §9**，不写 report。 |
| **`node .../registry-export.cjs`** | 只读：stdout 单行 **`ai-auto3.registry-export.v1`** JSON（项目列表、**`project_runtime_state`**、**`active_runs`**）；供 **ai-dash3** 等消费，**不**写 DB。 |

---

## 5. `autorun.cjs` 行为规格

### 5.1 启动前置 checklist（须全部满足）

开跑前逐项检查；**任一失败 → 退出码 1**，stderr/stdout 给出**人类可读**说明（缺什么文件、缺哪个键、哪条规则失败）。条款与 **`input-spec.md` §4.3.1** 对齐，落地为：

1. **`prd` 完成**：`stages.prd.status === "completed"` 且 `stages.prd.validation.passed === true`。  
2. **`prd-review` 完成且可进入 design**：`stages.prd_review.status === "completed"`、`outputs.decision === "passed"`（**`conditional_passed` 不放行**）；`stages.prd_review.review.phase_plan[*].feature_ids` 合并去重后**非空**。  
   读取全部已声明端 `docs/<target>/feature_list.md`，构建本项目 feature 全集；若存在未进入 `phase_plan` 且未显式 `deferred` 的 `feature_id`，则 preflight 失败（退出码 1）。  
3. **配置文件存在且通过 schema**：`docs/config.dev.json`、`docs/config.release.json` 存在且 **`_schema.version`** 与本 skill 支持版本一致；**`config.dev.json`** 中 **`deploy.provider`** 与 **`deploy.services[]`** 与本期需部署的端一致（细则可与 **publish3** 对齐）；**`config.release.json`** 即使 **`release.enabled=false`** 亦须能通过校验。  
4. **`docs/config.env`**：存在；包含所选 provider **必填密钥的变量名**；若 **`deploy.enabled === true`**，则对应密钥**值**非空。  
5. **密钥与 JSON 隔离**：对 **`config.dev.json` / `config.release.json`** 执行 **`security.forbidden_json_key_patterns`** 静态扫描（键名或值形态，规则来源以 **`config.*.json.template`** 为准），命中 → 失败。  
6. **Git 工作区**：当前分支可解析；**`git status`** 无未提交单文件 **> 50 MB**；允许小改动但在 **report** 中 **warnings** 提示（**`input-spec.md` §4.3.1#4**）。  
7. **PID 锁**：**`.agent-sessions/locks/pipeline.pid`** 不存在，或其中 PID 已不存活（**§8.1**）。  
8. **registry 对齐**：若 **`registry.sqlite`** 无本项目 **`project_id`** 记录，则从 **`.pipeline/stages.json`** **导入或 upsert**（**§9**）；导入失败 → 退出码 **1**。

**说明**：第 3 条中「与本期需要部署的端匹配」实现上可与 **`stages.prd.outputs.client_targets`** 或 **`client_targets.declared`** 交叉校验，细节以项目模板为准。**dev deploy 的 `pipeline.autorun.allow_destructive_deploy` 门闸**在**即将 spawn deploy** 时执行（**§5.4 步骤 4**），**不**作为本节开跑前的前置项（允许配置里 **`deploy.enabled=true`** 但本轮 autorun 不部署）。

### 5.2 `autorun.cjs` **允许**改写的 `stages.json` 键（窄接口）

编排脚本**不是**各阶段业务字段的写入者。除下列情况外，**禁止**修改 **`stages.design` … `stages.smoke`** 的业务输出子树：

| 场景 | 允许操作 |
| --- | --- |
| **`contract` 等待人工审批** | 将 **`stages.contract.status`** 置为 **`blocked`**（**`human_approval.status === "pending"`** 时，**`input-spec.md` §8 阶段 4**）；**不得**代用户 **`approved`**。随后**停跑**并进入 **§5.4**（失败路径仍生成 report）。 |
| **`stages.json` 内 `pipeline` 元数据** | 更新 **`.pipeline/stages.json`** 根下 **`pipeline.current_stage`**、**`pipeline.last_completed_stage`**、**`pipeline.updated_at`**、**`pipeline.updated_by: "ai-auto3"`**（若模板提供这些键）。**注意**：勿与 **`docs/config.dev.json.pipeline`**（配置里的 autorun 开关）混淆。 |
| **`logs.pipeline_logs`** | **additive** 追加本次编排会话索引项（路径、**`session_id`**、起止时间），不删除用户历史。 |

**禁止**：修改 **`stages.design.outputs.*`**、**`stages.test.outputs.result`** 等由各 **ai-*3** 负责的字段；**禁止**替子 skill 写其会话日志正文。

### 5.3 五类核心职责（验收对照）

与 **`input-spec.md` §4.3**「必须负责 5 件事」一一对应：

1. **前置 checklist** → **§5.1**。  
2. **PID 锁** → **§8.1**（scope **`pipeline`**）。  
3. **退出码读取** → **§7**。  
4. **停跑判断** → **§5.4**；遇 **`failed` / `blocked`** 或 **`prd_review.outputs.decision`** 仍为 **`conditional_passed`** 等未解除状态，**不得**继续下一阶段。  
5. **自动推进 + 末尾汇总** → 阶段循环 **§5.4**；最后 **`gen-report.cjs`**（**§10**）。

### 5.4 主循环（逻辑顺序）

1. 执行 **§5.1**；失败则跳到步骤 7（仍生成 report 时：须带失败原因）。  
2. 申请 **pipeline** PID 锁（**§8.1**）。  
3. 自 **`from-stage`** 起遍历阶段链至 **`smoke`**：  
   默认采用 **Phase 外循环**（见 **§5.8**）：先按 `phase_plan` 顺序选择当前 phase（第一个通常为 `mvp`），在该 phase 内完成 `design → contract → design-review`，再进入 `codegen → ... → build → deploy → smoke`，完成后生成 phase 报告，再切到下一 phase。  
   - 若 **§6** 判定「已完成」且无 **`--force-rerun`** → 打日志「跳过」并 continue。  
   - 若本阶段为 **`contract`** 且 **`human_approval.status === "pending"`** → **§5.2** 写 **`blocked`** → **停跑**（退出码按子 skill 最近一次或 **1** 择定，须在 **§7** 文档化）。  
   - 否则 **spawn** 对应子 skill（**§2.3**），传入 **`--project`** 与本阶段 **`timeouts.stages.<stage>_s`**（从 **`docs/config.dev.json`** 读取，缺省按模板）；若被调用方为 **ai-code3**，还须遵守 **§5.6** 与 **§5.7**（**`--feature`** 非空、**feature group** 划分与并行上限、**`merge-push`** 前汇合）。  
   - 子进程非 **0** → **停跑**，退出码 **§7**。  
   - 子进程 **0** → 可选：重新读取 **`stages.json`** 校验该阶段 **`status/completed`** 与 **`validation.passed`** 一致，防止子进程谎报。  
4. 调用 **`ai-publish-dev3`** 执行 **dev** **`deploy` + `smoke`** 前：须满足 **`input-spec.md` §7.2** 与 **`docs/spec/publish3.md` §5.1.1**。具体地，当 **`docs/config.dev.json.deploy.enabled === true`** 时，必须 **`docs/config.dev.json.pipeline.autorun.allow_destructive_deploy === true`**（缺键或 **`false`** 均视为未授权）；**否则不得 spawn deploy**，**退出码 1**，**`gen-report.cjs`** 须在正文中写明原因（可引用 **`pipeline.autorun.allow_destructive_deploy`** 路径）。**`deploy.enabled === false`** 时跳过本约束（无自动 deploy）。**不得**仅以 **`deploy.enabled === true`** 代替 **`allow_destructive_deploy`**。spawn 前 **`autorun.cjs`** 应调用 **ai-publish-dev3** `preflight` 校验 **artifact 一对一**；若失败且本轮曾 **skip build**（`summary_hash`），须 **强制重跑 build 一次** 后再试；仍失败则以 **preflight 可读错误** 停跑（**退出码 1**）。  
5. 调用 **`gen-report.cjs`**（**§10**）。  
6. **`autorun.cjs`** 在 **`gen-report.cjs`** 成功后**仅追加**一行会话日志（指向 **`report_path`**、最终 **`overall_result`**），**不**写入 report 正文。  
7. 释放 PID 锁；进程退出码与 **§7** 一致。

### 5.5 与「测试失败回退建议」的配合

**`stages.test.rollback_to`**（**`codegen` / `contract` / `null`**）由 **ai-code3** 写入；**ai-auto3** **不**直接越权改写其它阶段状态，但应在 **report** 与 stdout 中**显著提示**「建议从何处人工或带参续跑」（**`input-spec.md` §5**）。**可选增强**：识别 **`rollback_to`** 后自动调整 **`--from-stage`** 仅当用户显式传入 **`--follow-rollback`** 之类开关（若实现该开关，须写入 **`SKILL.md` 与本文**）。

### 5.6 调用 **ai-code3** 时的 **`--feature`** 与多进程并行（定稿）

本节只约束 **ai-auto3 → ai-code3**；**人工**直接调用 **ai-code3** 时是否省略 **`--feature`** 仍由 **`docs/spec/code3.md`** 与 **`ai-code3/SKILL.md`** 描述（可与编排不同）。**`autorun.cjs`** 在 **`codegen`～`code-review`** 波次对多 feature 的默认切分、排队与并行上限以 **§5.7** 为准；本节 **形态 A / B** 仍描述**单次** spawn 的命令行合法性（编排可对每个 group 选用形态 A）。

1. **显式 feature（必须）**  
   - 每一次 **spawn** **`node .../ai-code3/scripts/run.cjs`**（子命令为 **`all`**、**`codegen`**、**`typecheck`**、**`test`**、**`code-review`**、**`merge-push`**、**`build`** 等任一形式）时，命令行**必须**包含 **`--feature=<非空列表>`**。  
   - **允许形态 A（单进程多 id）**：**`--feature=id1,id2`**（逗号分隔、trim 后非空），由 **ai-code3** 在单进程内按 **`docs/spec/code3.md`** 约定顺序处理。  
   - **允许形态 B（多进程并行，推荐用于多 feature 提速）**：对 **K 个** **`feature_id`** 发起 **K** 次子进程，**每次** **`--feature=<单个 id>`**；**每次**须使用**不同**的 **`--session-id=`**（或由编排器生成的从属会话 id），便于日志区分。  
   - **`merge-push` / `build` 的取值**：此二阶段虽对仓库为**全局**操作，编排层 spawn 时**仍不得省略** **`--feature=`**；应传入**本轮待合并或已纳入产物的 feature 集合**的显式列表（推荐与 **`--features`** 解析结果或并行波次 id **全集**一致的 **`--feature=id1,id2,...`**），以便审计与 **`inputs.summary_hash`** 维度对齐。  
   - **禁止**：编排层为图省事省略 **`--feature`**，依赖 **ai-code3** 在未传参时从 **`stages.prd_review.review.phase_plan`** 聚合本期全部 id 作为**自动编排**的隐式范围（避免与 **`--features`** 子集、多仓模板差异及审计不一致）。

2. **并行边界与 `stages.json` 一致性**  
   - **目标**：多个 **ai-code3** 子进程可同时推进**不同 feature** 的 **codegen / typecheck / test / code-review**（以 **`worktrees[]`** 按 **`feature_id`** 隔离为前提）。  
   - **硬约束**：**`merge-push`** 与 **`build`** 对仓库与 **`stages.json`** 的写入具有**全局**语义；**在进入 `merge-push` 之前**，编排层**必须** **`await`** 上述并行波次**全部**成功退出（退出码 **0**），再**单次串行** spawn **`merge-push`**（必要时 **`build`**），除非未来 **ai-code3** 规格与实现提供**已文档化**的安全多写者合并协议。  
   - **竞态**：在整文件 **`writeStagesSync`** 模型下，多进程同时回写同一 **`stages.*` 段**会导致丢失更新；**实现 ai-auto3 时**须采用**已选择且写入 `SKILL.md` 的策略**之一：**串行化子结果合并**、**单写者编排器聚合**、或 **ai-code3 侧按 feature 分片原子更新**（以后者为准时须同步 **code3.md** 与模板）。**禁止**在无明确定义的情况下多进程盲写 **`.pipeline/stages.json`**。

3. **与 checklist 的关系**  
   - **`§5.1#2`** 已要求 **`phase_plan[*].feature_ids`** 非空；**`--features`**（**§4.3**）若存在，必须为该集合的子集，否则开跑前失败。

4. **超时传递**  
   - 每个子进程仍须继承 **`timeouts.stages.<stage>_s`** 与 **`--project`**；并行时**总墙钟**可能受最慢子进程支配；**`autorun_total_s`** 仍封顶整条编排（**§11**）。

### 5.7 Feature group 编排（**ai-code3** 段默认策略）

本节约束 **`autorun.cjs`** 在 **`codegen`～`code-review`** 各波次如何**划分 feature 集合**、**如何并行 spawn** **ai-code3**，与 **§5.6** 的关系为：**§5.6** 仍约束「每次 spawn 须非空 **`--feature=`**」「**`merge-push`/`build` 前须汇合**」「**`stages.json` 多写者竞态**」；本节在遵守上述前提下，把「按 id 盲目 K 路并行」收敛为「**依赖闭合的 group** + **端型优先级** + **有上限的组间并行**」。

#### 5.7.1 目的

- **正确性**：有 **`depends_on`**（或等价有向边）的 feature **不得**拆到**并行**的两路 **ai-code3** 里，以免破坏 **ai-code3** 单进程内拓扑/codegen 顺序假设（见 **`docs/spec/code3.md` §7.5**）。  
- **效率**：无依赖关系的 feature **不必**强行塞进同一次超长调用；在**安全并行度**内多 group 可同相并行。  
- **可观测性**：一次 **ai-code3** 调用对应**一个 group**、**一条**命令行 **`--feature=id1,id2,...`**（组内 id 顺序由 **ai-code3** 按 **`depends_on`** 拓扑排序，与 **code3.md** 一致）。

#### 5.7.2 Group 划分（依赖闭合）

1. **输入 id 集合**：先取 **`--features`** 解析结果；若缺省则为 **`phase_plan[*].feature_ids`** 合并去重全集（与 **§4.3**、**§5.1#2** 一致）。仅对该集合分组。  
2. **依赖边真源（定稿，方案 A）**：对每个待编排的 **`feature_id`**，在 **`stages.contract.outputs.artifacts[]`** 中定位 **`artifacts[].feature_id`** 与之相等的那一项，取其 **`artifacts[].design_snapshot`** 为**设计快照 JSON 文件路径**（相对 **`<project_root>`** 或绝对路径，解析规则与 **`docs/templates/stages.json.template`**、**`docs/spec/design3.md`** 一致）；读取该文件 JSON，取其内的 **`depends_on`**（**`string[]`**，元素为其它 **`feature_id`**），作为有向边 **`u → v`**（**u** 依赖 **v**，**v** 应先于 **u** 在同一 codegen 批次内被拓扑处理），语义与 **`docs/spec/code3.md` §7.5** 一致。若**无匹配 artifact**、路径不可读、JSON 解析失败或 **`depends_on` 缺失/非数组**：该 id 在依赖图中视为**无依赖边**的孤立点，并在编排日志 **`warnings`** 中记录原因。  
3. **分组规则**：对每条依赖边 **`(u,v)`**（由 **§5.7.2#2** 解析得到）做 **并查集合并**（**u** 与 **v** 必须落在**同一 group**）。无连边的 feature 各自为独立连通分量，即**自成一组**。  
4. **环**：若图中存在环，并查集仍将环上全体置于**同一 group**；**ai-code3** 对环的告警与字典序回退仍按 **code3.md** 执行。  
5. **组间先后**：在 **group** 粒度构造 DAG：若存在 **f∈G**、**g∈H** 且 **f** 依赖 **g**，则加边 **G→H**（**G 在 H 之后**执行）。对该 DAG **拓扑排序**；同一拓扑层内的 groups **彼此无依赖**，允许并行（受 **§5.7.4** 上限约束）。**不得**在组间 DAG 未满足时启动下游组。

#### 5.7.3 端型优先级 P0～P3（组内代表优先级 / 同层排队）

用于**同一拓扑层**内多个 ready group 的**启动次序**及日志/报告中的**人类可读排序**（**不**改变组间 DAG 必须满足的先后关系）。

**真源路径与读取顺序（定稿，仅方案 A）**

对给定 **`feature_id`**，**P0～P3 与跨端判定**一律按下述顺序解析；**不**使用 **`stages.json`** 内其它并行投影表（例如不在 **`stages.design.outputs`** 下维护第二套 feature 端型索引）作为真源。

1. **定位契约产物行**：在 **`stages.contract.outputs.artifacts[]`** 中查找 **`artifacts[].feature_id`** 与该 **`feature_id`** 相等的项。  
2. **若无匹配项**：视为**元数据缺失** → 该 feature 的端型按 **§5.7.3 末段**处理（**P3** + **`warnings`**）。  
3. **读取快照文件**：将该项的 **`artifacts[].design_snapshot`** 解析为**可读**的 JSON 文件路径（相对 **`<project_root>`** 或绝对路径），读取 UTF-8 JSON。若文件不存在、不可读或解析失败 → **元数据缺失**。  
4. **字段读取（均在上述快照 JSON 根对象上，除非 `design3.md` 对某字段另有唯一钉死的子路径——若存在子路径，以 `design3.md` 与本文同一 PR 内一致为准）**：  
   - **`cross_client`**：可选 **`boolean`**。若为 **`true`** → 该 feature **直接定为 P0**。  
   - **`client_targets`**：**`string[]`**，每项须为 **`stages.client_targets.allowed_values`**（或与 **`docs/templates/stages.json.template`** 一致的端 slug 枚举）中的合法值；非法项须剔除并 **`warnings`**；剔除后若数组为空且 **`cross_client` 不为 `true`** → **元数据缺失**。  
5. **若未触发 `cross_client: true` 且 `client_targets` 可用**：按下表由 **`client_targets`** 推导 **P0～P3**；若 **`client_targets.length >= 2`**（去重后仍 ≥2 个不同 slug）→ **P0**（跨端）。

| 等级 | 含义（在 **§5.7.3** 上述读取成功且未因 `cross_client: true` 已定为 P0 时，由 **`client_targets`** 推导） |
| --- | --- |
| **P0** | **`client_targets`** 去重后 **≥ 2** 个不同 slug（跨端）。 |
| **P1** | **单端**且唯一 slug 为 **`backend`**。 |
| **P2** | **单端**且唯一 slug 为 **`admin`**。 |
| **P3** | **单端**且 slug 为 **`website` / `miniapp` / `mobile` / `desktop` / `agent`** 之一；或其它在枚举内但未列入 P1/P2 的单端 slug。 |

**多字段异常**：若快照中同时出现 **`cross_client: true`** 与长度 **1** 的 **`client_targets`**，仍以 **`cross_client: true`** 为准，定 **P0**，并 **`warnings`** 提示数据自相矛盾待人工修正。

**组优先级**：取组内 feature 的 **min（P 数值越小越高）** 作为该 **group** 的代表优先级；同层 **ready** 队列中 **P0 组先于 P1** 启动，以此类推；仍并列时按 **`feature_id` 字典序** 稳定决胜。

**元数据缺失**（含无 artifact、快照不可用、无有效 **`client_targets`** 且 **`cross_client` 不为 true**）：该 feature 的端型**默认按 P3** 处理，并在编排日志 **`warnings`** 中列出 **`feature_id`** 与原因。

#### 5.7.4 并行度配置

- **键名**：**`docs/config.dev.json` → `pipeline.autorun.feature_group_max_parallel`**（**integer ≥ 1**）。  
- **默认**：键缺失时视为 **`3`**（与 **`input-spec.md` §9.1** additive 默认一致）。  
- **语义**：在 **codegen**、**typecheck**、**test**、**code-review** 各阶段波次中，**同一时刻**处于 **running** 的 **ai-code3** 子进程数（**按 group 计**）**不得超过**该值；下一 ready group 须等待空槽。  
- **`1`**：退化为**完全串行**（最保守，利于规避 **§5.6.2** 多进程整文件写 **`stages.json`** 的竞态，直至 **ai-code3** 提供分片原子写回或编排器单写者聚合）。

#### 5.7.5 与 **§5.6** 的硬衔接

- **每次 spawn**：仍须 **`--feature=<本 group 内 id 逗号列表>`**（非空）；**禁止**省略。  
- **`merge-push` / `build`**：仍须在 **`codegen`～`code-review` 全组**（本期 **`--features`** 范围内**所有** group）均**成功结束后**，**单次串行** spawn，**`--feature=`** 为本期 id **全集**（与 **§5.6.1** 一致）。  
- **`stages.json` 竞态**：多 group 并行**不**免除 **§5.6.2**；若当前实现仍为整文件覆盖写回，**推荐**将 **`feature_group_max_parallel` 默认保持为较低值**或实现「单写者合并 / 分片更新」后再提高并行度。

### 5.8 按 Phase + 优先级执行（定稿）

当 `stages.prd_review.review.phase_plan` 可用时，`autorun.cjs` 必须按以下顺序编排，而不是把全集 feature 一次性贯穿到尾：

1. **phase 选择**：按 `phase_plan` 顺序执行，默认首期为 `mvp`；后续依次进入下一 phase。  
2. **phase 内设计波次（先做完）**：当前 phase 的全部 feature 先完成 `design`、`contract`、`design-review`，未全部通过不得进入该 phase 的 code 波次。  
3. **phase 内开发波次（并行）**：在当前 phase 内按优先级（P0→P1→P2→P3）与依赖关系分组并行调用 **ai-code3**（沿用 §5.6、§5.7），直到该 phase 完成 `build`（以及启用时的 `deploy/smoke`）。  
4. **phase 报告**：每个 phase 结束后生成阶段性报告（建议落盘 `.pipeline/reports/phase-<phase>.md`，并在总 report 中索引）。  
5. **切换下一 phase**：仅当当前 phase 结果为可放行（`success` 或按团队策略允许的 `partial`）才进入下一 phase；否则停跑并输出阻塞原因。

**约束**：所谓「加载所有 feature」指启动时加载全集用于完整性校验与排队，但实际执行必须按 phase 分批推进；`mvp` 完成前不得提前执行后续 phase 的 code 波次。

---

## 6. 「已完成」跳过与强制重跑

### 6.1 精确判定（三条件同时满足）

与 **`input-spec.md` §4.4** 一致，阶段 **`S`** 视为可跳过：

1. **`stages.<S>.status === "completed"`**（键名用下划线：**`design_review`** 等）。  
2. **`stages.<S>.validation.passed === true`**。  
3. **`stages.<S>.inputs.summary_hash`** 与上游最新产物计算的哈希一致（**输入漂移**则不得跳过）。

### 6.2 `--force-rerun=<stage>`

跳过 **§6.1** 判定，强制以该阶段为入口重跑；其后序阶段行为：通常继续顺序推进（实现须在 **`SKILL.md`** 说明是否「只跑一段即退出」模式）。

### 6.3 destructive 与二次确认

**`merge-push` / `deploy`** 在重跑语义上为 **destructive**（**`input-spec.md` §7.2**）。**ai-auto3** 对 **dev deploy** 的自动授权键**固定**为 **`docs/config.dev.json.pipeline.autorun.allow_destructive_deploy`**（**`true`** 才允许 **autorun** spawn **deploy**；与 **`docs/spec/publish3.md` §5.1.1** 一致）。**`merge-push`** 在 autorun 内的确认策略（配置键或交互）若与 **ai-code3** 另有约定，须在 **`SKILL.md`** 与 **code3 规格**中交叉写明；缺失即 **退出码 1**，不得静默执行 destructive 步骤。

### 6.4 `AI_SOAK3_STRICT=1`（ai-soak3 调用）

当环境变量 **`AI_SOAK3_STRICT=1`**（由 **ai-soak3** 在 spawn autorun 前设置）：

| 规则 | 说明 |
| --- | --- |
| **禁止跳过** | 不得对 **`codegen`、`build`、`deploy`、`smoke`、`ui_e2e`** 应用 §6.1「已完成」跳过，**即使** `summary_hash` 未变 |
| **等价 CLI** | 须与 **`--force-rerun=codegen,build,deploy,smoke,ui_e2e`** 行为一致（实现可二选一：读 env 或要求 soak 显式传参） |
| **codegen 与 agent** | 若 **`AI_CODE3_SKIP_AGENT=1`** 或 **`stages.codegen.outputs.agent.skipped===true`** → **autorun 退出码 4**（或 **1**），**不得** `overall_result=success` |
| **report** | **`gen-report.cjs`** 须在正文列出「strict 重跑阶段」与 **req 追溯矩阵**引用（见 **`docs/spec/rfc-soak3-req-fidelity.md`**） |

**动机**：避免「上一轮 ui_e2e/deploy 已完成」掩盖 req 变更后的错站、错 App、假 PASS。

---

## 7. 退出码（编排层契约）

全表见 **`input-spec.md` §五**。编排层须遵守：

| 场景 | 行为 |
| --- | --- |
| 子 skill 退出 **0** | 继续下一阶段（或通过 **§6** 跳过）。 |
| 子 skill 非 **0** | **立即停止**自动推进；**`autorun.cjs` 最终退出码**建议与子进程**相同**，便于 CI/人诊断；若需归一化须在 **`SKILL.md`** 单列映射表。对 `codegen` 的 `--stub-remaining` 回退仅允许用于“已处于 stub 模式”的续跑（未探测到 agent 或显式 `force_stub_remaining=true`）；真实 Agent 模式失败不得静默降级为 stub 成功。 |
| **总超时 / 阶段超时 / 子命令超时** | 统一映射为 **3**，并在 **`stages.<stage>.outputs.timed_out`**、**`duration_ms`**、**`timeout_reason`** 留证据（由各 **ai-*3** 写入；编排层负责 kill 与传播退出码）（**`input-spec.md` §6.1**）。 |

---

## 8. 日志、锁与可观测性

### 8.1 PID 锁（`pipeline` scope）

| 项 | 约定 |
| --- | --- |
| **路径** | **`<project_root>/.agent-sessions/locks/pipeline.pid`** |
| **内容** | 单行 JSON：`pid`、`session_id`、`started_at`（ISO8601）、`skill: "ai-auto3"`（**`input-spec.md` §6**） |
| **冲突** | 若 PID **仍在运行** → **退出码 1**，打印锁路径与持有者 |
| **过期** | PID 不存在 → 删除锁文件后继续 |

### 8.2 会话日志

- **编排主日志**：**`.agent-sessions/<session_id>.log`**（与子 skill 各自日志并存；**`autorun` 不代写子 skill 日志**）。  
- **长时 tee**：**`.agent-sessions/logs/<meaningful>.log`**（可选）。  
- **心跳**：对 **`codegen` / `test` / `build` / `deploy`** 等长阶段，若本层封装了子进程，建议每 **30 s** 追加心跳行（**`input-spec.md` §6.1**）。  

### 8.3 report 阶段的清理建议

超过 **30 天**的会话日志列入 **report** 中「建议清理」清单；**失败**会话 **90 天内**不列入（**`input-spec.md` §6**）。**不自动删除**。

---

## 9. 本机 registry（`registry.sqlite`）

### 9.1 路径与职责

| 项 | 约定 |
| --- | --- |
| **默认文件** | **`~/.cursor/skills/_registry/registry.sqlite`** |
| **创建** | **ai-auto3**（或 **`registry-sync.cjs`**）首次需要时 **`mkdir -p`** 并初始化 DDL |
| **表（v0）** | **`projects`**（`project_id` 索引）、**`pipeline_runs`**（`project_id, started_at`）、**`stage_events`**（`run_id, stage`）、**`phase_runs`**（`run_id, phase`）、**`project_runtime_state`**（`project_id` 当前 phase/stage 快照）（**`input-spec.md` §3.2**） |
| **与 `stages.json` 冲突** | **以仓库内 `stages.json` 为准**；DB 在下次启动 **reconcile**（**`input-spec.md` §4.4**） |

### 9.2 最小 DDL 建议（实现可调整，但须兼容「可重建」）

- **`projects`**：`project_id`（PK）、`root_path`、`last_seen_at`、`stages_schema_version`。  
- **`pipeline_runs`**：`run_id`（PK）、`project_id`、`session_id`、`started_at`、`ended_at`、`exit_code`、`stopped_at_stage`。  
- **`stage_events`**：`id`（PK）、`run_id`、`stage`、`child_exit_code`、`duration_ms`、`skipped`（bool）、`notes`。  
- **`phase_runs`**：`id`（PK）、`run_id`、`phase`、`priority_bucket`、`started_at`、`ended_at`、`result`。  
- **`project_runtime_state`**：`project_id`（PK）、`active_run_id`、`current_phase`、`current_stage`、`pending_features_json`、`updated_at`（用于中断恢复）。

**可重建性**：删除整个 **`registry.sqlite`** 后，下次运行须能仅从各项目的 **`stages.json`** 恢复 **`projects`** 行并继续工作。

---

## 10. `gen-report.cjs` 规格

### 10.1 职责（单一）

1. 读取 **`<project_root>/.pipeline/stages.json`**。  
2. 读取 **`.agent-sessions/`** 下与本次 **`session_id`** 相关的日志索引（若 **`stages.logs`** 或各阶段 **outputs** 含路径则优先）。  
3. 生成**给人看的** Markdown（或 HTML，任选其一但须在 **`SKILL.md` 固定）报告文件，路径写入 **`stages.report.outputs.report_path`**；并更新 **`stages.report.outputs.overall_result`**（**`success` / `partial` / `failed` / `blocked` / `pending`**，与 **`input-spec.md` §7.1** 枚举一致）。  
4. 将 **`stages.report.status`** 置为 **`completed`**（若生成失败则为 **`failed`**），**`validation.passed`** 与报告是否「可用」一致；**`duration_ms`** 等可观测字段写入。  
5. **禁止**篡改 **`stages.design` … `stages.smoke`** 的历史事实字段；**仅**写 **`report`** 自有块与 **`logs`** 索引（若需要）。

### 10.2 报告正文最低内容

- 本次范围（**`feature_ids`**、**`client_targets`**）。  
- 各阶段一行摘要：**`status`**、**`validation.passed`**、**`duration_ms`**、失败时指向日志路径。  
- **deploy URL / smoke 结果** 若存在于 **`stages.json`**。  
- **失败 / 阻塞** 时的「下一步建议」（含 **contract 待审批** → 调用 **ai-design3** `approve-contract` / `reject-contract` 的指引，见 **`docs/spec/design3.md` §8**）。  
- **超时** 时：标出阶段、配置上限、**`timeout_reason`**（**`input-spec.md` §6.1**）。

### 10.3 与 `autorun.cjs` 的分工

- **report 正文**仅由 **`gen-report.cjs`** 写入。  
- **`autorun.cjs`** 在调用 **`gen-report.cjs`** 之后**仅追加**编排会话的一行指针日志（**`input-spec.md` §4.3**）。

---

## 11. 超时与配置键

| 层级 | 配置键（`docs/config.dev.json`） | 默认 | 说明 |
| --- | --- | --- | --- |
| **总超时** | **`timeouts.autorun_total_s`** | **7200** | 覆盖整个 **`autorun.cjs`** 一次 run |
| **阶段超时** | **`timeouts.stages.<stage>_s`**（如 **`design_s`**） | 见模板 | 传给子 skill 或作为 wrap 上限 |
| **子命令超时** | **`timeouts.subcommand.*`** | 见模板 | 主要在子 skill 内使用 |
| **组并行上限** | **`pipeline.autorun.feature_group_max_parallel`** | **3** | 见 **§5.7.4**；键缺失按 **3** |

**关系**：总超时与各阶段超时**嵌套封顶**（**`input-spec.md` §6.1**）；触发后子进程 **SIGTERM → 5s → SIGKILL**，退出码 **3**。

---

## 12. 验收清单（实现完成前勾选项）

- [x] **`SKILL.md`** 含触发词、**`--project`** 必填、前置依赖 **ai-prd3**、默认 **design→report**、**不含 release**、退出码指针。  
- [x] **`autorun.cjs`** 实现 **§5.1** 全项；失败信息可定位到文件路径与键。  
- [x] **PID 锁** **`pipeline`** 行为符合 **§8.1**。  
- [x] 子 skill **非 0** 时停跑且退出码行为符合 **§7**。  
- [x] **`contract` + `human_approval.pending`** 时写 **`blocked`** 且**不**自动批准（与 **design3.md §8** 一致）。  
- [x] **`gen-report.cjs`** 写入 **`stages.report`** 与报告文件；**`overall_result`** 与事实一致。  
- [x] **`registry.sqlite`** 可删后重建；**`project_id`** 与 **`stages.json`** 一致。  
- [x] **不**修改各阶段业务 **`outputs`**（**§5.2** 窄接口除外）。  
- [x] **`deploy.enabled === true`** 时 **`pipeline.autorun.allow_destructive_deploy === true`** 才 spawn dev deploy；否则 **1** 且有 **report**（与 **`publish3.md` §5.1.1** 一致）。  
- [x] 与 **`docs/templates/stages.json.template`** 中 **`report`**、**`pipeline`** 字段兼容。  
- [x] 每次 spawn **ai-code3** 均带**非空** **`--feature=`**；**§5.7** 下按 **group** 调用（组内多 id 逗号拼接），**`pipeline.autorun.feature_group_max_parallel`** 生效；**§5.6.2** 竞态策略与 **`SKILL.md`** 一致（**无**未协调的整文件盲写）。
- [x] 按 **Phase 外循环**执行：`mvp`（或 phase_plan 首项）先完整跑完 `design` 到 `smoke/report` 再进入下一 phase。  
- [x] 当前 phase 内按优先级（P0→P3）与依赖分组并行调用 ai-code3，`merge-push/build` 仍单次汇合。  
- [x] 编排中间态（当前 phase/stage、待处理 feature 队列、phase 结果）均落到项目级 DB 记录，可在中断后恢复。

---

## 13. 交叉索引

| 主题 | 文档 |
| --- | --- |
| 全流水线阶段语义、退出码、日志 | **`docs/input-spec.md`** |
| **ai-design3**、**contract** 审批停跑 | **`docs/spec/design3.md` §8** |
| **ai-code3**、**merge-push/build**、**`--feature` / 编排并行 / feature group** | **`docs/spec/code3.md`**、**`docs/spec/auto3.md` §5.6、§5.7** |
| **ai-publish-dev3**、**deploy/smoke**、**`pipeline.autorun.allow_destructive_deploy`** | **`docs/spec/publish3.md` §2.3、§4.2、§5.1.1** |
| **ai-prd3** 与 **ai-auto3** checklist 对齐 | **`docs/spec/prd3.md` §8.5** |
| **字段真源** | **`docs/templates/stages.json.template`**、**`config.dev.json.template`** |
| v2 → v3 迁移 | **`docs/input-spec.md` §9.3** |
| **只读看板**（**不**自动推进） | **`docs/spec/dash3.md`**（**`ai-dash3`**） |

---

## 14. 与上一版实现的对照（经验参考）

上一版仓库：**https://github.com/rudyzhuang/skills.git**（**`input-spec.md` §一**）。可借鉴：

- **统一退出码**、子进程 **tee**、**PID 锁**防并发。  
- **autorun / autorun-pro** 的阶段循环与并行增强思路。

**不得**照搬：v2 业务仓内脚本路径、v2 **`stages.json`** 字段、各端 **`deployment_plan.json`**、**`scripts/config.env`** 等（**`input-spec.md` §9.2**）。
