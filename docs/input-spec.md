# Skill V3 需求说明（给人看的草稿）

本文档描述「这一版 skill 想做成什么样」，方便讨论和改字。不涉及具体技术怎么实现（脚本名、表名、CLI 细节可在业务仓与全局 skill 仓库里对稿）。

本版定位为「**完整重写、不向后兼容**」：在**业务语义**层面**借鉴**上一版流水线里已经验证过的概念（统一退出码、日志落盘习惯、各阶段输入输出、编排门闸思路），但**字段、文件、路径**全部以本文与 `docs/templates/` 为真源；上一版历史文件（旧 `stages.json` / 各端 `deployment_plan.json` / `scripts/config.env` 等）**不再被任何 ai-*3 读取**，迁移由人工或一次性脚本完成。skill 命名与阶段划分也做了调整（新增 **design-review**，文档化 **merge-push**，末尾 **report**）。详细的版本关系、迁移边界与字段级清单见 **§1**、**§9.2**、**§9.3**；skill 脚本归属、业务项目配置文件与编排状态文件见 **§3**。

---

## 一、和上一版的关系

- **上一版在 GitHub 上的仓库**：https://github.com/rudyzhuang/skills.git

**本版与上一版的关系定位**：

- **理念沿用**：阶段化推进、清晰输入输出、脚本/提示语串联，这些**思路**继续采用。
- **不向后兼容**：本版不读取上一版的 `stages.json`、各端 `deployment_plan.json`、`scripts/config.env` 等历史文件，也不在 ai-*3 中内置任何兼容回退；如需迁移老项目，由人工或一次性迁移脚本完成（参见 §9.2）。
- **字段以本版为准**：实现定稿时**不**回到上一版仓库核对字段；本版的字段级真源是本文 + `docs/templates/`。
- **skill 命名换代**：所有 skill 由 `*2` 升至 `*3`（含 ai-prd2/ai-design2/.../ai-deploy2 → ai-prd3/ai-design3/ai-publish-dev3 等），命名映射见 §4.2。

后续各节将围绕「输入更清楚、输出更可靠、阶段约束写清楚」展开；实现定稿时仍可参考上一版作为流程经验来源，但不作为字段兼容承诺。

---

## 二、这一版想多解决什么问题

上一版已经能跑通一条链路，这一版希望**再往前走一步**：

- skill 的**输入**要更清楚：每阶段「进来的是什么」要说死、说全，减少含糊和漏项。
- skill 的**输出**要更可靠：每阶段「交出去的是什么」要可核对、可对齐下一阶段的期待，减少对不上号的情况。
- 为此，要给**每一个阶段**单独补上「约束说明」：这一阶段允许什么、不允许什么、必须满足什么才算过关——先写在给人看的文档里，后面再落到机器可执行的规则里。

一句话：**更稳、更对、更完整**，主要靠「每个阶段的约束写清楚」来托底。

---

## 三、skill 脚本与业务项目配置（总体约定）

本版在**存放与调用方式**上与上一版做一个明确区分：**所有 skill 自带的脚本**（以及随 skill 分发的模板、校验逻辑等）**只保留在 skill 目录中**；人、Agent 或编排器触发某 skill 时，**执行入口也以该 skill 目录下的脚本为准**，**不再**把这些脚本**复制**到具体业务项目里维护，避免出现「仓库里一份、skill 里一份」的双源不一致。

业务项目不再承担「托管 skill 脚本副本」的职责，但仍要能被 skill **识别为哪一个项目、在什么环境下工作**。为此，在**文档目录**下约定**两份非敏感环境配置** + **一份敏感环境变量**；各阶段脚本在运行时**按实际需要**读取其中内容作为输入（不必每步全量加载，但缺关键字段时应能明确失败或提示补全）：

| 文件（路径均相对于 `<project_root>/docs/`） | 职责划分 |
| --- | --- |
| **config.dev.json** | **开发环境**侧非敏感、可结构化管理的项目信息：例如 Git 相关配置（远程、默认分支、与工作流有关的选项）、**编译与构建**选项、**dev 部署**所需的云服务**资源级**配置（区域、服务标识、功能开关、环境名等），以及 **`pipeline.autorun.allow_destructive_deploy`**（**ai-auto3** 自动执行 dev **deploy** 的显式授权，见 **`docs/spec/publish3.md` §5.1.1**）、**`pipeline.autorun.feature_group_max_parallel`**（**ai-code3** 段 **feature group** 并行上限，见 **`docs/spec/auto3.md` §5.7.4**）等你希望与 **ai-publish-dev3** / **ai-auto3** 门闸对齐的其它管理字段。上一版分散在各端 **`deployment_plan.json`** 里的「部署草案 / 资源级约定」类信息，**本版统一收敛到此文件（及 release 对档）**，**不再**为每端单独维护 `deployment_plan.json`。 |
| **config.release.json** | **正式发布环境**侧与上表同类的非敏感配置，供 **ai-publish-release3** 及发布类步骤读取；与 **config.dev.json** 结构对齐，便于 diff 与晋升，但允许值不同（例如域名、实例规格、发布通道）。 |
| **config.env** | 固定放在 **`<project_root>/docs/config.env`**，存放**凭证与密钥**：如云服务商的 API Key、访问令牌、账号标识等**敏感内容**；与上述 JSON **拆开**，便于单独做不入库、权限收紧或加密存储（具体纪律由团队模板与实现约定）。**禁止**把密钥写入 `config.dev.json` / `config.release.json`。 |

**模板总览（字段级 v0 契约）**：本版模板由 skill 分发，当前在本文档仓库中以 **`docs/templates/`** 作为字段级 v0 契约源维护。创建或初始化项目时，skill 应只把项目实际需要的模板复制/派生到业务项目中；候选 catalog 不应整份写入项目配置。

**环境术语固定**：本版的两个环境标识固定为 **`dev`**（开发环境）与 **`release`**（正式发布环境），分别对应 `config.dev.json._schema.environment="dev"` 与 `config.release.json._schema.environment="release"`。本文不再使用 `prod` / `production` / `staging` 等替换词，以避免与模板字段不一致。

| 模板 | 用途 |
| --- | --- |
| **`prd-spec/prd-spec.cn.md.template`** | **PRD 总源头默认模板**；创建 **`docs/prd-spec.md`** 时默认使用中文版本。 |
| **`prd-spec/prd-spec.en.md.template`** | 英文 PRD 总源头模板；仅在用户显式选择英文或传入语言参数时使用。 |
| **`feature_list.md.template`** | 各端 **`docs/<端>/feature_list.md`** 的结构模板。 |
| **`stages.json.template`** | 项目根 **`.pipeline/stages.json`** 的 v0 结构模板。 |
| **`config.dev.json.template`** | **`docs/config.dev.json`** 的 v0 结构模板。 |
| **`config.release.json.template`** | **`docs/config.release.json`** 的 v0 结构模板。 |
| **`config.env.template`** | **`docs/config.env`** 的占位模板；仅放密钥名与说明，不放真实密钥。 |
| **`.gitignore.template`** | 业务项目 **`.gitignore`** 默认片段（构建产物、worktree、会话目录等）；**`bootstrap` 合并写入**，不覆盖用户已有规则。 |
| **`deploy-services.catalog.json`** | 云平台与部署服务候选目录；用于生成 `config.dev.json` / `config.release.json` 时按用户选择和需求裁剪。 |

首次引导或初始化时，可将对应模板复制到业务项目的 `docs/` 或 `.pipeline/` 下；若文件已存在则**跳过覆盖**，除非用户明确同意覆盖。已存在文件缺少模板必填键时，应提示用户确认后安全补齐，不能静默删除用户已有键。

**项目文档目录约定**：如果没有特别说明，本文后面说到「文档目录」或「docs 目录」，都指业务项目根目录下的 `docs/`，也就是 `<project_root>/docs/`。后续阶段只需要写「文档目录」或「docs 目录」，不再反复展开完整路径。

### 3.4 主目录代码结构约定（按端归档）

为与上一版团队习惯保持连续性，本版补充并固定业务仓主目录下的代码归档结构：

- **主代码目录固定为** `src/`（相对于 `<project_root>`）。
- **按端分子目录**：`src/website/`、`src/admin/`、`src/backend/`、`src/mobile/`、`src/desktop/`、`src/miniapp/`、`src/agent/`。
- **merge-push 完成后的主线代码**应落在上述对应端目录（或其子目录）中；禁止把「最终并入主线的端代码」散落到端外临时目录。
- **禁止 V2 根目录落盘**：不得将端实现放在仓库根的 `backend/`、`website/`、`apps/<端>/` 等目录；**ai-code3** 的 **merge-push** 落位门闸会拒绝（见 **§阶段 10** / **`docs/spec/code3.md` §11.4**）。
- **项目级 `scripts/`**：业务仓根下 `scripts/` 仅用于构建/编排（如 `scripts/build.cjs`），与 skill 安装目录内的 `*.cjs` 无关。
- **共享层允许存在**：如 `src/shared/`、`src/common/`、`src/sdk/`；但凡某 feature 修改共享层，必须在对应端的 design/code-review 记录中显式标注影响范围。
- **初始化与补齐策略**：若仓库尚未存在 `src/` 或某端子目录，相关阶段可在首次落盘时创建；已存在目录结构不得被静默重排。

建议默认目录骨架如下：

```text
<project_root>/
|-- src/
|   |-- website/
|   |-- admin/
|   |-- backend/
|   |-- mobile/
|   |-- desktop/
|   |-- miniapp/
|   |-- agent/
|   |-- shared/            # 可选：跨端共享代码
```

### 3.5 Git 版本化与推送节奏（全阶段）

**原则**：本地仓库与远程仓库的**初始化**前移到 **prd 阶段开始**（**`ai-prd3` `bootstrap`**），不再由 **codegen** 隐式 `git init`。各阶段按约定路径 **commit**；在 **`docs/config.dev.json` → `git.allow_push=true`** 且仓库已配置对应 **`git.remote`** 时 **push**（推送命令失败 → 退出码 **7**；**`allow_push=true` 但尚无 remote** 时仅 **commit**、`push_status=not_requested`，**不**以 **7** 失败）。实现真源：**`ai-auto3/scripts/lib/git-pipeline-sync.cjs`**；**`.gitignore`** 真源：**`docs/templates/.gitignore.template`**。

| 阶段 | 纳入版本控制的路径（相对 `<project_root>/`） | 同步时机 |
| --- | --- | --- |
| **prd 开始前** | **项目根下全部路径**（`git add -A`，受 **`.gitignore`** 约束，**非**仅 `inputs/`） | **`bootstrap` 收尾**：先 **`git init`** + 合并 **`.gitignore`**，待目录/模板就绪后 **全仓 commit + push** |
| **prd 完成后** | `inputs/`、`docs/`、`.pipeline/` | **`write-prd` 成功**：在上述路径上 **commit + push** |
| **prd-review**、**design**、**contract**、**design-review** | 同上（尚无 `src/`） | **每个 `feature_id` 在本阶段 `features[].status=completed` 后**立即 **commit + push** |
| **codegen**、**typecheck**、**test**、**code-review**、**merge-push** | 同上 + **`src/`** | **从 codegen 起**将 `src/` 纳入跟踪；**每个 feature 在本阶段 completed 后** **commit + push**（merge-push 在合并该 feature 分支入主线后写回状态并同步） |

**远程仓库**：`bootstrap` 读取 **`docs/config.dev.json` → `git.remote_url`**（空则仅本地仓库）；写入 **`stages.project.git.remote_url`** 与 **`remote_configured_at`**。**`project_id`** 仍按 §8 阶段 1 规则（有 remote 用 sha1，无 remote 用 uuid）。

**`.gitignore`（必做）**：须忽略 **`.agent-sessions/`**、**`.pipeline/worktrees/`**、**`.pipeline/cache/`**、各端 **编译产物**（`dist/`、`build/`、`node_modules/`、移动端 `Pods/` / `DerivedData/` / `android/build/`、小程序 `miniprogram_npm/` 等）及其它临时文件；完整列表见 **`docs/templates/.gitignore.template`**。`docs/config.env` **默认**忽略（团队若加密入库可改）。

**与 merge-push 分工**：feature 级同步把 **docs / .pipeline / src** 推上远端；**merge-push** 仍负责 worktree 分支合入 **`git.default_branch`**，二者互补。**codegen 内禁止**再执行 `git init`；无仓库时 **退出码 1** 并提示先跑 **prd bootstrap**。

**状态字段（可选）**：`stages.prd.git_sync` 记录 **`initial_pushed_at`**（全仓首 push）、**`docs_pipeline_pushed_at`**（write-prd 后）等；各阶段可在 `validation.summary` 或日志中附带 `git_sync` 摘要。

### 3.1 阶段输入输出与编排状态：`.pipeline/stages.json`

各阶段（含 **prd**、**prd-review** 及后续阶段）的**输入摘要、输出摘要、校验结果、阶段完成标记**等，凡需**机器可读、供编排门闸与续跑**使用的信息，统一以 **JSON** 形式写入业务项目根目录的：

**`<project_root>/.pipeline/stages.json`**

约定原则：

- **一份项目一份文件**：路径固定在项目根下的 `.pipeline/` 目录；目录与文件可随首次写入创建。
- **命名约定（贯穿全文）**：阶段名在**正文与小节标题**中使用**连字符**形式（如 `prd-review`、`design-review`、`code-review`、`merge-push`），便于阅读；写入 **`.pipeline/stages.json`** 时**键名一律使用下划线形式**（`prd_review`、`design_review`、`code_review`、`merge_push`），与 **`docs/templates/stages.json.template`** 完全对齐。本文出现的 `stages.<stage>.*` 字段路径均按下划线形式书写。
- **与给人读的 Markdown 分工**：`docs/prd-spec.md`、各端 `prd.md`、**`feature_list.md`** 等仍以自然语言或约定正文为主；**`stages.json` 承担「门闸与编排真源（项目侧）」**，内容需与各阶段实际产物一致，避免口头状态与文件状态脱节。
- **各 skill / ai-auto3** 在更新某阶段状态时，应**读写同一份** `stages.json`（或等价地由单一模块合并写入），并遵守第九节「手工与自动跑法结果对齐」。
- **Feature × Stage 状态（可恢复、可查询）**：除 **`prd`** 外，每个阶段块在 **`stages.<stage>.features[]`** 中维护本期各 **`feature_id`** 在该阶段的 **`feature.status`**（见 **§7.1.1**）。行结构以 **`docs/templates/schemas/stages-feature-row.v1.schema.json`** 为 v0 契约；**仅当该阶段脚本实际处理某 feature 时**才更新对应行的 `feature.status`（见 **§7.1.1** 写回规则）。**`ai-dash3`** 以 **`features[]`** 为 feature 进度展示真源（辅以 `outputs` 产物路径等）。

### 3.2 Skill 目录内的运行时状态（本机多项目编排）

在 **skill 安装目录**（本机全局一处）按项目维护 **`runtime.json`**，用于：

- 记录**本机**上曾参与编排的**多个业务项目**的后台进程、当前 phase/stage、待处理 feature 队列与最近 run 摘要（须能按 **`project_id`** 与 **`root_path`** 区分项目，避免串项）。
- 供 **ai-dash3** 多项目 Web 看板、**ai-soak3** 监控、会话续跑与 IDE/Agent 展示；**不作为**业务仓库内的提交物。

**路径（定稿）**：

- **`<skills_root>/_runtime/<project_id>/runtime.json`**
- **`<project_id>`** 与 **`<project_root>/.pipeline/stages.json` → `project.project_id`** 一致，目录名经文件系统安全化（见 **`docs/spec/runtime-pipeline.md` §1**）。
- 字段真源模板：**`docs/templates/runtime.json`**；规格 SSOT：**`docs/spec/runtime-pipeline.md`**。

**与 `stages.json` 的关系（避免双真源冲突）**：

- **项目仓库内的权威**：以 **`<project_root>/.pipeline/stages.json`** 为**可恢复、可核对**的编排门闸真源（阶段 status、validation、outputs）。
- **skill 目录 runtime**：**本机后台与运行态索引**；须支持删除整个 **`<skills_root>/_runtime/`** 后，仅依据业务仓 **`stages.json`** 在下次 **autorun / soak** 时重建 **`project`** 与空 **`orchestration`**，**不应**出现「runtime 丢了就无法开跑」的情况。

**读写分工（摘要）**：

| 写入方 | 内容 |
| --- | --- |
| **ai-auto3** | **`orchestration.*`**、**`recent_runs[]`**、autorun **`processes[]`** |
| **ai-soak3** | soak / monitor 相关 **`processes[]`**、**`orchestrator: ai-soak3`** |
| **ai-code3** | 长时 codegen / agent **`processes[]`** |
| **ai-dash3** | 仅 **`services.dash_serve`**（可选）；**禁止**写阶段门闸 |

**`registry.sqlite`（已移除）**：

- 不再使用 **`~/.cursor/skills/_registry/registry.sqlite`**；**ai-auto3** **无** `better-sqlite3` 依赖。
- 本机运行态仅 **`<skills_root>/_runtime/<project_id>/runtime.json`**。详见 **`runtime-pipeline.md` §5**。

**小结**：**skill 侧**——脚本在 skill 安装目录，**本机运行态**在 **`<skills_root>/_runtime/<project_id>/runtime.json`**；**项目侧**——**`docs/config.*.json`** + **`<project_root>/.pipeline/stages.json`**。编排 **ai-auto3** 与各 **ai-*3** 在解析到业务项目根路径后，应能稳定定位上述文件，并把「缺文件 / 缺键 / 敏感项误入 JSON / `stages.json` 与文档不一致」等情况纳入前置校验与给人看的报错说明。

### 3.3 实现分层：cjs 脚本与 skill prompt 的分工

本版要求**显式区分**两类逻辑，避免把"确定性流程"塞进 LLM prompt、也避免把"创造性收敛"塞进脚本：

- **cjs 脚本（`*.cjs`，CommonJS）承担"确定性的事"**：
  - **schema 校验**（`stages.json` / `config.*.json` / `feature_list.md` 解析）
  - **文件 I/O 与状态写回**（读写 `.pipeline/stages.json`、生成各端骨架文件、计算 `inputs.summary_hash` 等）
  - **前置 checklist、PID 锁、退出码读取/映射**（见 §4.3 与 §6）
  - **子进程启停与超时控制**（见 §6.1）
  - **git / 构建 / 部署 CLI 调度**（只组合命令、解析输出，不替子工具决策）
  - **诊断与日志归集**（写 `.agent-sessions/logs/sessions|features|stages/`）
- **LLM prompt（写在 `SKILL.md` 或随 skill 分发的 prompt 文件中）承担"创造性的事"**：
  - 把用户原始想法收敛为 **prd-spec / design / contract / 评审结论 / report 文本** 等需要语义理解与归纳的产物
  - 在校验失败 / 缺口提示 / 修复建议 等场景下生成给人看的解释
  - **不**承担确定性流程；脚本能做的事不要再让 LLM 重做一遍。
- **skill 自身要轻薄**：
  - **`SKILL.md` 只描述触发场景、输入输出契约、调用入口、关键边界**；不内联实现代码、不复述脚本里已有的算法。
  - skill 的执行步骤应**显式调用** `<skill_dir>/scripts/*.cjs`（如 `prd-init.cjs`、`prd-validate.cjs`、`design-derive.cjs` 等），而不是让 LLM 用自由文本"模拟跑一遍"。
  - LLM 在 skill 中的作用应**集中在 prompt 输入与输出的语义环节**，确定性步骤一律走脚本。
- **脚本归属与执行入口**（与 §3 总则一致）：
  - 所有 `*.cjs` 脚本**只放在 skill 目录**：`<cursor_skills_root>/<skill_name>/scripts/*.cjs`，**不**复制进业务项目。
  - 执行时由 LLM / 编排器调用脚本，工作目录传入业务项目根路径作为参数；脚本内部以参数为准，不依赖 `process.cwd()` 推断。
  - 跨语言项目（Python / Go / Rust / 其它）只通过 cjs 调度其原生命令（如 `pytest`、`cargo test`、`go build`），cjs 自身**不**硬编码业务语言假设。
- **CommonJS（`.cjs`）的固定选择**：本版统一使用 CommonJS，避免 ESM 在 `~/.cursor/skills/` 跨节点版本下的兼容性问题；统一启动方式 `node <skill_dir>/scripts/<name>.cjs --project=<root> --stage=<stage> [...]`。后续若要切到 ESM，按 §9.1 breaking 规则演进。

---

## 四、路线图：阶段顺序与 skill 分工

读文档时建议先通读本节，再往下看各阶段说明。这里固定**阶段链**、**分段大 skill 的职责范围**，以及本版**自动编排**的起止点。

### 4.1 阶段链（与上一版对齐，并标出变化）

整体顺序延续上一版习惯，在此基础上：

- **新增**：在「契约」之后增加 **design-review**（设计侧再过一遍，把设计与契约对齐）；在流水线末尾增加 **report**（汇总结果，给人一份可读交代）。
- **改名说明**：**merge-push** 与上一版大家常说的 **merge / ai-git2** 一段职责相当：合并 worktree、处理推送等，仅在文档里统一用 **merge-push** 称呼。

**推荐固定的先后关系**（从左到右即默认推进顺序）：

`prd` → `prd-review` → `design` → `contract` → `design-review` → `codegen` → `typecheck` → `test` → `code-review` → `merge-push` → `build` → `deploy` → `smoke` → `ui_e2e` → `report`

**关于 deploy 和 smoke**：链路上仍是「先部署、再冒烟」；实际执行时会区分**开发环境**与**正式发布环境**，由不同 publish skill 承担，避免与「整条链的大顺序」混淆。

**关于 release**：本版**不**把 release 作为独立 stage 写入 `stages.json`，而是把「版本号、变更日志、打标、托管发布资产上传」等收敛为 **ai-publish-release3** 的内部子步骤，发生位置在 release 环境的 `deploy` 之前或之后（由 skill 内部决定），其结果以 `stages.deploy.outputs.release_meta`（或等价子字段）回写。如果未来要把 release 升级为独立门闸，必须**提升 `_schema.version`** 并提供迁移说明。

### 4.2 skill 与阶段：一对多

一个 **skill** 可以串联多段 **stage**，是**一对多**：既可以点某个大 skill 一次跑完它负责的几段，也可以按阶段手工拆着跑——只要遵守第九节里「不同跑法结果要对齐」的约定。

| skill 名称（本版） | 覆盖的阶段 |
| --- | --- |
| **ai-prd3** | prd，prd-review |
| **ai-design3** | design，contract，design-review |
| **ai-code3** | codegen，typecheck，test，code-review，merge-push，build |
| **ai-publish-dev3** | deploy（**dev** 环境），smoke |
| **ai-e2e3** | **ui_e2e**（**website/admin** Browser MCP；**mobile** android/ios Dart MCP + integration_test）；见 **`docs/spec/e2e3.md`** |
| **ai-publish-release3** | deploy（**release** 环境），smoke；以及上一版中常见的 **release**（版本、变更日志、打标、托管发布等）类职责 |
| **ai-dash3** | **无**独占 stage（**只读**看板）：读 **`<skills_root>/_runtime/<project_id>/runtime.json`** + 业务仓 **`.pipeline/stages.json`**、**`reports/`**、Feature 流水线；CLI 或 **`serve`** 本地 Web；**不** spawn 子 skill、**不**写 **`stages.*`**、**不**自动推进（见 **`docs/spec/dash3.md`**） |

**report** 不单独拆 skill：本版定为 **ai-auto3 的末尾职责**。当自动序列跑完 dev deploy + smoke + **ui_e2e**（若 `ui_e2e.enabled`）后，由 **ai-auto3** 读取 **`.pipeline/stages.json`** 与关键日志生成最终汇总。

**上一版 ↔ 本版 skill 映射（仅作迁移参考，不承诺兼容）**：

| 本版 skill | 上一版对应 | 备注 |
| --- | --- | --- |
| **ai-prd3** | ai-prd2 + ai-prd-review2 | 合并为一个 skill；产物结构按本版重写，**不**读上一版 `feature_list.md` 旧字段 |
| **ai-design3** | ai-design2 + ai-contract2 + 部分 ai-code-review2 | **新增 design-review** 作为本 skill 内最后一段 |
| **ai-code3** | ai-codegen2 + ai-typecheck2 + ai-test2 + ai-code-review2 + ai-git2 + ai-build2 | 6 段合一；阶段间状态字段全部按本版 `stages.json.template` 重写 |
| **ai-publish-dev3** | ai-deploy2(dev) + ai-smoke2(dev) | dev 路径；不再生成各端 `deployment_plan.json` |
| **ai-publish-release3** | ai-deploy2(release) + ai-smoke2(release) + 上一版 release 子流程 | 含 release 类内部子步骤（见 §4.1） |
| **ai-dash3** | **ai-dash2**（看板 / 状态洞察层） | 只读诊断与下一步建议；**不**承担 autorun 物理推进（见 **`docs/spec/dash3.md`**） |
| **ai-auto3** | **autorun** + **autorun-pro**（自动推进层） | 默认终点为 dev deploy + smoke + **ui_e2e**（可选）+ report；release 不默认跟随；**runtime.json** 初始化/对齐由 **ai-auto3** 负责（见 §3.2、§4.3.1#8） |
| **ai-e2e3** | （本版新增）UI 端到端 | 见 **`docs/spec/e2e3.md`**；默认在 **smoke** 之后、**report** 之前 |

**配置文件迁移**：上一版各端目录下的 `deployment_plan.json` 在本版**不再被读取**；其内容应一次性合并入 `docs/config.dev.json` / `docs/config.release.json` 后**人工删除**。本版 ai-*3 不会自动迁移这些文件。

### 4.2.1 看板与诊断 skill：**ai-dash3**

上一版 **ai-dash2** 承担的「**一眼看清流水线进度、阻塞点、报告入口**」在本版独立为 **ai-dash3**（名称换代为 3），与 **ai-auto3** 的 **autorun** 职责**显式拆分**，避免「只看状态却误触长跑编排」：

| 维度 | **ai-dash3** | **ai-auto3** |
| --- | --- | --- |
| **是否 spawn 子 skill** | **否** | **是**（按 §4.1 链路与 **`docs/spec/auto3.md`**） |
| **是否写 `.pipeline/stages.json`** | **否**（只读；**禁止**为「展示美观」回写任何 stage 字段） | **否**业务字段；仅允许编排契约已载明的 **`pipeline.*` / 停跑时 `contract` blocked 等**（见 **`docs/spec/auto3.md`**） |
| **PID 锁** | **不**申请、**不**释放；可**只读检测** `.agent-sessions/locks/pipeline.pid` 给人提示 | **必须**按 §6 管理 |
| **`<skills_root>/_runtime/<project_id>/runtime.json`** | **只读**（ **`serve`** 可写 **`services.dash_serve`**）；项目列表来自扫描 **`<skills_root>/_runtime/*/runtime.json`** | **ai-auto3** 主写 **`orchestration` / `recent_runs`**；**ai-soak3**、**ai-code3** 写 **`processes`**（见 **`runtime-pipeline.md`**） |
| **典型用途** | 会话开场快照、PR 描述贴进度、人工判断「卡在哪」；**`serve`** 本地 Web 看板跟踪多项目与 Feature 流水线 | 从 **design**（默认）起自动跑到 **report** |
| **本地 Web** | **`run.cjs serve`** → **`http://127.0.0.1:9473/`**（只读；见 **`docs/spec/dash3.md` §3.4、§7.1**） | — |

**实现入口**：以 **`<cursor_skills_root>/ai-dash3/scripts/run.cjs`** 为 CLI 真源（**`docs/spec/dash3.md`**）；**`SKILL.md`** 保持轻薄，仅触发词与必读路径表。

### 4.3 自动编排 skill：**ai-auto3**

本版把「从某一阶段起自动往下跑」的能力收敛到一个编排 skill 名下，命名为 **ai-auto3**（与上一版的 **autorun / autorun-pro** **概念连续**；**看板**职能由 **§4.2.1 `ai-dash3`** 承担，名称换代为 3）。

**ai-auto3 的核心职责（一句话）**：**实现 pipeline 的自动推进**——按 §4.1 阶段链顺序串联调用各 ai-*3 子流程，并在过程中提供**门闸、超时、停跑、汇总**四类托底，保证整条流水线"该停时停、该走时走、该报时报"。

**ai-auto3 必须负责的 5 件事**：

1. **前置 checklist**：开跑前一次性校验所有自动化条件（见 §4.3.1），不满足即停。
2. **PID 锁**：开跑时申请 `.agent-sessions/locks/pipeline.pid`，结束时释放；同 scope 已有实例在跑则直接失败（见 §6）。
3. **退出码读取**：把每个 ai-*3 子进程的退出码按 §5 与 §6.1 的语义解读为"成功 / 可重试 / 阻断 / 超时"等类别。
4. **停跑判断**：依据上一步的解读决定**继续向后推进**还是**立刻停下**；在 ai-*3 的 status 写为 `failed` / `blocked` / `conditional_passed` 未解除等情况下，**ai-auto3 必须停**，不允许"再赌一把往下跑"。
5. **自动推进 + 末尾汇总**：上一阶段被判定"可以前进"后，按阶段链调用下一阶段；序列末尾调用 `gen-report.cjs` 生成 report，并向用户给出明确的"成功 / 部分成功 / 失败 + 下一步"。

**实现分工（与 §3.3 一致）**：

- **`SKILL.md (ai-auto3)`**：只描述触发场景、入口参数、对外契约（起止阶段、是否覆盖 release 等），**不**内联编排算法。
- **`<ai-auto3_skill_dir>/scripts/autorun.cjs`**：本版**自动推进的物理实现**，承载上述 5 件事；除此之外**不**做任何业务干预——
  - **不**写各阶段的业务字段（如 `stages.design.outputs.*`、`stages.test.outputs.result` 等），那些由对应 ai-*3 自己写；
  - **不**替子 skill 写日志，**不**替 LLM 做决策；
  - **不**修改契约文件、源码、配置（这些由对应阶段 skill 控制）。
- **`<ai-auto3_skill_dir>/scripts/gen-report.cjs`**：单一职责的 report 生成器，读取 `.pipeline/stages.json` 与 `.agent-sessions/` 索引，输出报告文件并写入 `stages.report`；由 `autorun.cjs` 在序列末尾调用。
- **report 阶段的日志**：`autorun.cjs` 在调用 `gen-report.cjs` 后**仅追加一段会话日志**（指向 report 路径与最终状态），report **正文**由 `gen-report.cjs` 唯一写入；其它阶段的日志一律由该阶段对应 ai-*3 自己写入。

**ai-auto3 调用 ai-code3（`codegen`→`build`）的定稿约束**（与 **`docs/spec/auto3.md` §4.3、§5.6、§5.7** 一致，不重复细则）：

1. **必须显式 `feature_id`**：编排层每一次 spawn **`ai-code3/scripts/run.cjs`** 时，命令行**必须**包含**非空** **`--feature=...`**（含 **`merge-push` / `build`** 调用：须传**本轮 feature 全集**的逗号拼接，不得省略）；**`autorun.cjs`** 在 **`codegen`～`code-review`** 默认按 **`docs/spec/auto3.md` §5.7** 将本期 id 划分为 **feature group**，**每个 group 一次 spawn**，**`--feature=`** 为该组内 id 列表（形态 A）；**不得**依赖「未传 `--feature` 时由 ai-code3 从 `prd_review.phase_plan` 隐式聚合」作为**自动编排**的默认范围。可选 **`--features=`**（autorun 自有参数）用于把本期自动跑限定到 **`phase_plan`** 中某一子集；越界 id 须在开跑前失败。  
2. **多进程并行**：当本期存在多个 **group**（或经 **`docs/spec/auto3.md` §5.7** 退化为多路单 id）时，**允许**同时发起多路 **ai-code3** 子进程，且**同时 running 数**受 **`pipeline.autorun.feature_group_max_parallel`**（默认 **3**，见 **`docs/spec/auto3.md` §5.7.4**）约束；**在进入 `merge-push` 之前**必须等待该并行波次**全部**成功后再串行执行 **`merge-push` / `build`**（或采用 **`docs/spec/auto3.md` §5.6** 已文档化的其它无竞态合并策略）。**禁止**多进程在无协调的情况下并发整文件覆盖 **`.pipeline/stages.json`**。

**默认自动序列的起止（本版定稿）**：

- **起点**：**design**（**prd** 与 **prd-review** 已在 **ai-prd3** 内完成：**prd** 文件齐且校验通过，**prd-review** 放行进入设计，且 **`.pipeline/stages.json`** 已记录对应完成态；在此前提下从设计开始自动跑）。
- **终点**：**report** 完成。  
  换言之：自动编排覆盖 `design` → … → `build` → **ai-publish-dev3**（`deploy` + `smoke`）→ **ai-e2e3**（`ui_e2e`，仅当 **`ui_e2e.enabled===true`**）→ **gen-report**。

**刻意不纳入本版自动序列的内容**：

- **prd / prd-review**：**默认由 Agent 在 ai-prd3 内完成**（LLM 按 `prompts/prd-review.md` 产出 JSON → **`run.cjs finalize-prd-review --json=...`** 做合并与机器终检；**不设**单独人工签审节点；**给人看的结论**见 **`.pipeline/reports/prd-implementation-summary.md`**）。**ai-auto3** 自动编排仍**不从 prd 或 prd-review 起步**（避免在需求未成形或脚本未关门闸时长跑流水线）。
- **正式发布 / release**：**ai-publish-release3** 及其所带的 **release** 类步骤**不进入 ai-auto3 的默认自动序列**；正式发布留在人工触发或单独编排策略中处理，降低误发线上风险。
- **report**：作为 **ai-auto3** 的末尾步骤执行；它不触发正式发布，只负责生成本轮流水线汇总。

**与上一版习惯的对应关系（便于理解）**：上一版里「从评审之后一路自动跑」多由业务仓 **autorun** 或并行增强版承担；本版把这些编排语义收到 **ai-auto3** 名下，并把编排实现下沉到 **`autorun.cjs`** 这一确定性脚本（业务仓内不再放 autorun 副本），**自动终点**明确为 **dev 发布 + 冒烟 + report**，**release 不默认跟随**。上一版 **ai-dash2** 的「只看进度、不自动跑」由 **ai-dash3** 承接（**§4.2.1**）。

#### 4.3.1 ai-auto3 启动前置 checklist

ai-auto3 在自动序列开跑前，**必须**逐项校验下列条件；任一不满足即以退出码 1 失败，并以人类可读方式说明缺什么、在哪个文件：

1. **prd / prd-review 已完成**
   - `stages.prd.status="completed"` 且 `stages.prd.validation.passed=true`；
   - `stages.prd_review.status="completed"` 且 `stages.prd_review.outputs.decision="passed"`（`conditional_passed` 不放行）；
   - 至少存在一个进入本期的 feature：`stages.prd_review.review.phase_plan[*].feature_ids` 非空。
2. **配置文件齐备且通过 schema 校验**
   - `docs/config.dev.json` 存在、通过 `_schema.version=1` 校验、`deploy.provider` 与 `deploy.services[]` 至少与本期需要部署的端匹配；
   - `docs/config.release.json` 存在并通过 schema 校验（即使 `release.enabled=false`）；
   - `docs/config.env` 存在，且包含所选 provider 的所有必填密钥**变量名**（值可为空）；若 `deploy.enabled=true`，则对应密钥**值**必须非空。
3. **密钥与 JSON 隔离**：对 `config.dev.json` / `config.release.json` 跑一次 `security.forbidden_json_key_patterns` 静态扫描，命中即失败。
4. **git 工作区可用**：当前分支可解析、`git status` 中无未提交的大文件（> 单文件 50 MB），允许有未提交小改动但需在 report 中提示。
5. **本机锁文件无残留**：`.agent-sessions/locks/pipeline.pid` 不存在、或所指 PID 已不再运行（详见 §6）。
6. **skill DB 自动对齐**：若 skill 目录内 DB 缺失该 `project_id` 的索引，**ai-auto3 必须从 `stages.json` 自动导入并生成索引**，不要求用户手动登记（见 §3.2）；导入失败即以退出码 1 失败。

校验完成后，ai-auto3 才进入 design 阶段；任何一项失败都不应"先跑再说"。

#### 4.3.2 ai-soak3 严格模式（`AI_SOAK3_STRICT=1`）

当 **ai-soak3** 无人值守压测 spawn **ai-auto3** / **ai-e2e3** / **ai-publish-dev3** 时，应设置 **`AI_SOAK3_STRICT=1`**。子 skill 行为以 **`docs/spec/rfc-soak3-req-fidelity.md`** 为总览，分项见：

| 文档 | 约束摘要 |
| --- | --- |
| **`ai-soak3/docs/spec/soak3.md`** | §6 内容指纹、App 身份；§10 手工门闸 |
| **`docs/spec/auto3.md` §6.4** | 禁止 skip codegen/build/deploy/smoke/ui_e2e |
| **`docs/spec/e2e3.md` §4.1** | 必须 MCP 或 integration；禁止假 PASS |
| **`docs/spec/code3.md` §7** | 禁止 SKIP_AGENT 伪完成；禁止 Health 脚手架污染笔记 PRD |
| **`docs/spec/publish3.md` §7.4** | smoke 须 body_contains / body_not_contains |
| **`ai-prd3/docs/spec/prd3.md` §1.4–§1.5** | req→feature/config；**C/O/I/N 分流** |
| **`docs/spec/rfc-soak3-req-fidelity.md` §2.5** | 正交不扰动 pipeline；**I** 增量改码+双评审；**N** 全流程 |

**与 §4.3 默认序列的关系**：soak 在 **ai-prd3 完成后**调用 autorun；strict 下 **不得**因 `summary_hash` 跳过发布与 UI 验收阶段（**覆盖** §4.4 的常规跳过规则，见 **`auto3.md` §6.4**）。req 增量时 **autorun** 仅重跑命中 feature（**`auto3.md` §6.5**），**禁止**全量推倒 codegen。

### 4.4 编排门闸与「已完成则跳过」

下列原则在**理念上**与上一版编排、看板门闸一致，但**判定字段与文件路径以本版为准**，不读取上一版历史状态：

- **开跑前**：编排侧应校验后续阶段所需的**输入条件**；不满足时**立刻停下**，用自然语言说明缺什么、哪里不对，而不是带着缺口硬跑。
- **运行中**：若某阶段产出已存在且状态表明**该阶段已完成**，则**跳过重复执行**，明确提示「本阶段已完成」，再进入下一阶段。
- **「已完成」的精确判定**（适用于 ai-auto3 与各 ai-*3 的"跳过"逻辑）：必须**同时**满足下列三条，缺一即视为未完成、需重跑：
  1. **`stages.<stage>.status="completed"`**；
  2. **`stages.<stage>.validation.passed=true`**；
  3. **本阶段 `inputs` 摘要 hash 与上游最新输出一致**（每个 stage 应在 `stages.<stage>.inputs.summary_hash` 中记录上游产物的稳定 hash；上游若有更新但本阶段未重跑，视作"输入漂移"，自动失效本阶段的"已完成"判定）。
- **强制重跑**：用户可通过显式参数 `--force-rerun=<stage>`（或 ai-auto3 的等价开关）忽略上述判定，重新执行某阶段；该操作的"是否会覆盖已有产物"由 §8.1「执行方式上的总体约定」与 §7 重跑语义矩阵共同约束。
- **判定的真源**：以 **`.pipeline/stages.json`** 为准（见 §3.1），并与 skill 目录内 DB 索引一致；冲突时以 `stages.json` 为准，DB 在下一次启动时按 §3.2 重新对齐。
- **手工单跑与自动连跑**：在相同输入与相同规则下，**各阶段应交出的结果应对齐**（见第九节）；差别只在于谁触发、是否自动排队。

---

## 五、统一退出码与失败语义（各 skill / 脚本的「退出机制」）

上一版在多个 skill 中采用**同一套退出码语义**，便于编排脚本、CI 与人快速判断「该不该重试、该不该回退、是不是环境问题」。本版**沿用这套数值与分类**作为各 **ai-*3** 及其内部调用脚本的对外契约（理念沿用，并非字段兼容承诺；本版退出码以下表为准，与上一版历史脚本是否一致由各自约束）；**ai-auto3** 在串联子步骤时，也应把子进程退出码**如实向上传递或映射为可诊断的汇总**。

| 退出码 | 含义（给人看的说法） |
| --- | --- |
| 0 | 成功结束 |
| 1 | 兼容性或前置条件不满足（缺文件、缺配置、schema 不对、门闸未过、**凭证缺失或格式错误**等） |
| 2 | 用户主动取消 |
| 3 | AI 或外部工具调用失败（**往往可重试**：超时、偶发网络、Agent 异常退出等） |
| 4 | **质量门失败**：测试、类型检查、代码审查、冒烟等检查项未通过 |
| 5 | **契约被破坏**（例如实现阶段改动了契约文件、diff-guard 拦截类问题） |
| 6 | Git 合并冲突，需要人工解决或走合并策略分支 |
| 7 | Git 推送失败 |
| 8 | 云平台或托管侧 API 失败（含调用云 API 时鉴权被拒的 401/403；**凭证"缺失"归 1，凭证"被拒"归 8**） |

**使用说明**：

- **单阶段 skill**：某次调用对应某一阶段时，应以**上表**作为对外契约；特殊子命令若需额外码，应在 skill 内写清「仅该子命令适用」，避免与上表冲突。
- **合成 skill**（如 **ai-code3** 串多段）：对外仍建议**收敛到上表**；若内部子阶段失败，应在日志与最终摘要中标明**失败发生在哪一段**，便于回到该段单跑。
- **ai-auto3**：任一子阶段非 0 时，编排应**停止自动向后推进**；是否允许「从失败点续跑」由实现定义，但须在给人看的说明里写清。
- **超时**：单 skill / 单子命令 / `autorun.cjs` 总超时触发后，**统一映射为退出码 3**（"AI 或外部工具调用失败，往往可重试"），并在 `stages.<stage>.outputs.timed_out=true` 与 `stages.<stage>.outputs.duration_ms` 中写入证据。详细规则见 §6.1。

**与「测试失败回退」的配合（承接上一版）**：上一版测试阶段会在失败耗尽修复次数后，在状态上给出**回到 codegen 或回到 contract**等建议；编排层（本版的 **ai-auto3**）负责**读该建议并路由**；**ai-dash3** 可**只读展示**该建议供人决策，**不得**代替编排层自动路由。测试 skill **不得**越权改写无关阶段的状态。本版仍维持这一职责划分。

**退出码与 `stages.json` 的桥接**：

- 原始**进程退出码**由编排器在**会话日志**（`.agent-sessions/logs/sessions/<session_id>.log`）中持久化，**不**直接落在 `stages.json` 字段里。
- `stages.<stage>.status` 与 `stages.<stage>.validation.passed` 是退出码的**语义投影**：例如「退出码 4 → status=`failed` 且 validation.passed=false」、「退出码 5 → status=`failed` 且写入 `stages.codegen.validation.contract_diff_guard_passed=false`」、「退出码 6 → `stages.merge_push.outputs.merge_status="conflict"`」。
- 编排器在生成 report 时，必须把「退出码 ↔ status ↔ 失败摘要 ↔ 日志路径」**一一关联**，避免读者只看到状态字段却找不到原始失败现场。

---

## 六、日志与可观测性

理念沿用上一版 **autorun / 并行编排** 的实践：**日志默认落在业务项目内、可追溯、可续跑**；但本版的目录、文件名、锁路径全部以本节为准，不再读旧版默认位置。

**落盘位置（业务项目根下，相对路径约定）**：

- **单次 Agent 会话日志**：`.agent-sessions/logs/sessions/<session_id>.log`
- **按 feature 归集**（某 feature 在各 stage 处理时的全部行）：`.agent-sessions/logs/features/<feature_id>.log`
- **按 stage 归集**（某 stage 跨 feature 的全部行）：`.agent-sessions/logs/stages/<stage>.log`（键名与 `stages.json` 一致，下划线形式，如 `prd_review`、`merge_push`）
- **长时间编排、tee、后台 shell 追加**：可写入上述 `logs/sessions/` 或 `logs/stages/`；目录随运行创建
- **兼容**：旧路径 `.agent-sessions/<session_id>.log` 仅作只读回退；新写入统一走 `logs/` 子目录

**Agent 调用 I/O（脚本直连 `cursor-agent` 等）**：

- 各 stage 脚本在调用外部 Agent 时，除关键步骤行外，须经 **`scripts/lib/agent-io-log.cjs`** 写入 **`agent_io.begin` / `agent_io.end`**（及 **`agent_io.skip`**）。
- **提示词**：日志中写 **`prompt_ref=@skill/<skill>/<相对路径>#<符号>`**（指向 skill 内 prompt 构建函数或 **`prompts/*.md`**），并附 **`prompt_sha=<12位>`**；仅将 feature_id、scenario_id 等**动态片段**写入 **`prompt_dynamic`**，避免重复贴全文。
- **输出**：记录 **`stdout` / `stderr`**（超长截断，默认 6000 字符）及 Agent 落盘 JSON 的 **`output_summary`**（键摘要，非全文）。

**写作与沟通上的约束**：

- **默认不应**把「唯一可依赖的编排日志」写成只有 **`/tmp/*.log`**（机器重启易丢、路径不随仓库走），除非用户显式要求或传入绝对路径。
- 业务仓内的编排脚本，**宜**通过统一的「会话路径解析」模块决定日志文件路径，避免各处手写 `/tmp`。
- 编排进程若写 **PID 锁**防并发（上一版实践）：锁文件放在项目内约定目录；若发现**同范围已有实例在跑**，应**直接失败退出**并提示锁路径与 PID，**禁止**在未协调的情况下并行抢写同一套流水线状态，以免状态错乱。
- **时间戳展示**：`logs/**/*.log` 行首时间戳为**系统本地时间**（`YYYY-MM-DD HH:mm:ss.SSS`）；**`.pipeline/stages.json`**、**`runtime.json`**、registry 等机器字段仍用 **ISO 8601 UTC**。Markdown 报告「生成时间」与 **ai-dash3** 展示须用本地时间（实现：`scripts/lib/local-time.cjs`）。

**给人看的总结**：排查时优先 **`.agent-sessions/logs/features/<feature_id>.log`**（单特性全链路）或 **`logs/stages/<stage>.log`**（单阶段）；编排主会话在 **`logs/sessions/<session_id>.log`**。自动编排（**ai-auto3**）摘要须带可点击相对路径。

**日志保留与清理（默认值）**：

- `.agent-sessions/` **默认入 `.gitignore`**；ai-prd3 在初始化时若发现该目录未被忽略，应提示用户补上。
- **单文件轮转**：单文件超过 **50 MB** 时由编排器自动切片为 `<basename>.log.1`、`<basename>.log.2` ……，最多保留 5 个旧切片。
- **过期建议**：超过 **30 天**的旧会话日志，由 ai-auto3 在 report 阶段**列入"建议清理"清单**，**不自动删除**；用户可显式触发清理。
- **失败保留**：标记为失败（status=`failed` / `blocked`）的会话日志在 90 天内**不进入"建议清理"**，便于事后排查。

**PID 锁路径与命名约定**：

- 锁文件统一放在 **`.agent-sessions/locks/<scope>.pid`**；`<scope>` 取值固定为 `pipeline / deploy-dev / deploy-release / merge-push / build / smoke / ui-e2e`。
- 锁文件内容为单行 JSON：`{"pid": <pid>, "session_id": "<session_id>", "started_at": "<iso8601>", "skill": "<skill_name>"}`，便于人为排查与机器清理。
- 启动时若发现同 scope 锁存在但 PID 已不在运行，编排器应**自动清理过期锁**并继续；若 PID 仍在运行，**直接以退出码 1 失败**，提示锁路径与持有者信息。

### 6.1 运行时长监控与超时

理念沿用上一版"长时调用必须可超时"的实践，本版定稿如下：

**三层超时（嵌套）**：

| 层级 | 作用范围 | 配置位置 | 默认值 |
| --- | --- | --- | --- |
| **总超时** | `autorun.cjs` 一次完整自动序列（design → … → report） | `docs/config.dev.json.timeouts.autorun_total_s` | **7200 s（2 小时）** |
| **阶段超时** | 单个 ai-*3 子流程（含其内部所有步骤） | `docs/config.dev.json.timeouts.stages.<stage>_s` | 见下表 |
| **子命令超时** | skill 内调用的单条外部命令（npm/pytest/git/cli 等） | 通常由 skill 内部决定，可被同名上层超时收紧 | 由 skill 默认实现给出，但**不得**超过所属阶段超时 |

**阶段超时默认值（v0）**：

| 阶段 | 默认 (s) | 说明 |
| --- | --- | --- |
| `prd` / `prd-review` / `design` / `contract` / `design-review` / `code-review` / `report` | **600** | LLM 主导的阶段，10 分钟通常足够 |
| `codegen` | **1800** | 含 worktree 创建与多次 LLM 调用 |
| `typecheck` | **600** | 静态检查 |
| `test` | **1800** | 含修复循环（`max_fix_attempts` 默认 3） |
| `merge-push` | **300** | 本地合并 + 可选推送 |
| `build` | **1800** | 多端构建 |
| `deploy` | **1800** | 云 API 调度 |
| `smoke` | **300** | 轻量探测 |

**总超时与阶段超时的关系**：总超时是**封顶**，并非各阶段累加。各阶段超时之和**可以**超过 `autorun_total_s`，此时哪个先到先触发——目的是给"快阶段被异常拖慢"和"整体跑过头"两种风险都设兜底。默认值为参考值，需在实际项目跑过若干轮后，基于历史 `duration_ms` 调优。

**触发优先级与默认行为**：

1. 触发**软中断**（向子进程发送 SIGTERM），保留 5 秒清理窗口；窗口超过仍未退出则发 SIGKILL。
2. 在 `stages.<stage>.outputs.timed_out=true`、`stages.<stage>.outputs.duration_ms=<ms>`、`stages.<stage>.status="failed"` 中写入证据；`validation.passed=false`，并附 `timeout_reason`（取值如 `stage_timeout` / `subcommand_timeout` / `autorun_total_timeout`）。
3. 进程退出码统一为 **3**（见 §5）；`autorun.cjs` 收到 3 后**停止自动向后推进**。
4. `autorun.cjs` 在调用 `gen-report.cjs` 后**仅追加一段会话日志**（指向 report 路径与失败阶段），**不**写入 report 正文；report 正文由 `gen-report.cjs` 唯一写入，并明确标出"超时阶段、实际耗时、配置上限、可考虑的下一步（提高超时、人工介入、续跑）"。

**实现要求（与 §3.3 呼应）**：

- 超时控制**必须在 cjs 脚本层实现**（如 `child_process.spawn` + `setTimeout` + `kill` 组合，或封装为公共 `run-with-timeout.cjs`），**不**依赖 LLM 自觉控制时长。
- 单 skill 内部的子命令调用应**统一走同一个超时封装**，避免每个脚本重新发明轮子。
- **配置已在模板 v0 显式收纳**：`docs/config.dev.json` / `docs/config.release.json` 的顶层 `timeouts` 字段（含 `autorun_total_s`、`stages.<stage>_s`、`subcommand.{default_s, graceful_shutdown_s, heartbeat_interval_s}`）即为本节默认值的来源；`stages.<stage>.outputs.duration_ms` / `timed_out` / `timeout_reason` 也已加入 `stages.json.template`。后续若要调整字段位置或新增层级，按 §9.1 演进规则处理。
- **可观测性最低要求**：每个阶段无论成败都应写入 `duration_ms`，便于历次对比与定位"哪个阶段越来越慢"。
- **进度心跳**：长时阶段（`codegen` / `test` / `build` / `deploy` / `smoke` 等）应**每 30 秒**向 **`logs/sessions/<session_id>.log`** 与对应 **`logs/stages/<stage>.log`**（及本波 **`feature_ids`** 的 **`logs/features/`**）追加 `alive: stage=<x> ...`，避免人误以为卡死。
- **重试与超时**：单 skill 内部对 LLM 或外部命令的**重试/重入必须在阶段超时内累计完成**，超时即终止重试，**不**允许"重试自身另起一份超时计算"。

**适用范围（不区分触发方式）**：

- 三层超时机制对 **ai-auto3 自动跑**与**各 ai-*3 手工跑**同等适用：手工触发某 skill 时仍走该 skill 的"阶段超时"与内部"子命令超时"，只是不受 `autorun_total_s` 总超时约束（因为没有 autorun 在外层）。
- 各 ai-*3 在 SKILL.md 中应明确说明：超时退出统一返回 3，不允许自定义新码绕过。

---

## 七、各阶段输入输出明细

下表用**业务语言**概括「谁依赖谁、产出交给谁」。**端（client_target）** 取值见 §3 与名词表（§十）：`website / admin / backend / mobile / desktop / miniapp / agent`；需求类文档多放在 `docs/<端>/` 下。阶段门闸与机器可读状态以 **`<project_root>/.pipeline/stages.json`** 为准（见 §3.1）；本机 skill 目录内 DB 仅作索引与缓存，须能与 `stages.json` 对齐恢复（见 §3.2）。

| 阶段 | 主要输入（上游交给本阶段） | 主要输出（本阶段交给下游） |
| --- | --- | --- |
| **prd** | 业务目标、范围、非功能约束；**`docs/prd-spec.md`** 作为总源头；可选模板与组织规范；**ai-prd3** 提供的 **config.*.json** 模板（若尚未生成则初始化） | 各端 **`docs/<端>/prd.md`** 与 **`feature_list.md`**（由总规派生）；**`docs/config.dev.json`** / **`docs/config.release.json`** 中非敏感环境与部署资源级字段的初稿或补全建议（**替代**各端 `deployment_plan.json`）；写入 **`.pipeline/stages.json`** 的 prd 状态，并可同步到 skill 目录 DB 缓存 |
| **prd-review** | 总规与各端需求、特性列表；**`stages.json`** 中 prd 完成态；**不**把评审意见写回 **`prd-spec.md` 正文**（总源头正文仅由 prd 流程或用户显式授权修改） | **评审结论**（分期、优先级、阻塞项、是否进入 design）；对 **`config.dev.json` / `config.release.json`** 的修订建议或已确认值（仍不得写入密钥）；跨期依赖显式列出；写入 **`.pipeline/stages.json`** 的 prd-review 状态，并可同步到 skill 目录 DB 缓存 |
| **design** | **`.pipeline/stages.json`** 中 **prd-review** 已满足「可进入 design」条件（见 §8 阶段 2）；已通过评审的特性及其约束 | **设计规格**（草稿与定稿）：新建/修改文件清单、接口与数据变更思路、约束与依赖；写入 **`.pipeline/stages.json`** 的 design 状态，并可同步到 skill 目录 DB 缓存；**不**在本阶段直接生成五种契约终稿 |
| **contract** | 已定稿或已批准的设计规格 | **五种契约产物**（类型、API 描述、数据 schema、测试规格、与设计一致的规格快照）、契约审批与机器校验结果；写入 **`.pipeline/stages.json`** 的 contract 状态，并可同步到 skill 目录 DB 缓存 |
| **design-review**（本版新增） | 契约草案与设计规格 | **对齐结论**：设计 ↔ 契约 是否一致、缺口清单、是否放行进入实现阶段；写入 **`.pipeline/stages.json`** 的 design-review 状态，并可同步到 skill 目录 DB 缓存 |
| **codegen** | 契约已通过机器校验；**`design_snapshot`/`file_plan`**（硬边界）；可选 **Cursor Agent CLI / `@cursor/sdk`** | **实现与测试代码**（默认在 **`.pipeline/worktrees/v3-fc-<feature_id>/`** 等隔离 worktree 中）、**`stages.codegen.outputs.worktrees[]`**、**`outputs.agent`**；**严禁**回头改契约（主仓 + worktree **diff-guard**）；写入 **`.pipeline/stages.json`**，并可同步到 skill 目录 DB 缓存（详见 **`docs/spec/code3.md` §7**） |
| **typecheck** | 代码生成成功且工作区有效 | **类型检查状态**；在仓库配置支持时跑 TS / ESLint / Python 类型等；未探测到工具时可为「跳过并说明原因」；写入 **`.pipeline/stages.json`** 的 typecheck 状态，并可同步到 skill 目录 DB 缓存 |
| **test** | 类型检查通过；代码生成侧实现与测试骨架均就绪 | **测试运行状态**；失败时在状态中标明建议回退点（回实现或回契约，语义承接上一版）；写入 **`.pipeline/stages.json`** 的 test 状态，并可同步到 skill 目录 DB 缓存 |
| **code-review** | 测试通过；契约与实现均在 | **代码审查状态**（例如关键问题数是否为 0）；对照契约做完整性检查；写入 **`.pipeline/stages.json`** 的 code-review 状态，并可同步到 skill 目录 DB 缓存 |
| **merge-push** | 测试与代码审查均通过 | **合并与推送相关状态**（合并提交、冲突、跳过、失败原因等）；**不**篡改测试本身的通过/失败字段；写入 **`.pipeline/stages.json`** 的 merge-push 状态，并可同步到 skill 目录 DB 缓存 |
| **build** | 已合并；且该「端」需要编译产物 | **构建产物路径与构建状态**；纯后端等无需前端构建的端可整段跳过并标明 N/A；写入 **`.pipeline/stages.json`** 的 build 状态，并可同步到 skill 目录 DB 缓存 |
| **deploy** | 已合并且门闸通过；**`docs/config.dev.json`** 或 **`docs/config.release.json`**（视目标环境）中部署所需非敏感信息齐备，**`config.env`** 中凭证可用；前端类还需构建成功 | **部署状态**、可访问 URL；不写回需求文档真源；写入 **`.pipeline/stages.json`** 的 deploy 状态，并可同步到 skill 目录 DB 缓存 |
| **smoke** | 部署成功；可读契约中的冒烟约定 | **冒烟状态**；对标记为可安全探测的接口做轻量验证；默认不做破坏性写入；写入 **`.pipeline/stages.json`** 的 smoke 状态，并可同步到 skill 目录 DB 缓存 |
| **ui_e2e** | smoke（或配置允许跳过）通过；`test_spec.ui_scenarios`；web base_url 或 mobile 产物+设备 | **UI 端到端状态**、场景结果、报告路径；由 **ai-e2e3** 写入 **`stages.ui_e2e`** |
| **report**（本版新增） | 各阶段状态与关键日志索引；**`stages.json`** 全量或摘要 | **给人看的汇总**：本次范围、每特性/每端进展、失败点与下一步建议；写入 **`.pipeline/stages.json`** 的 report 状态和摘要指针，并可同步到 skill 目录 DB 缓存 |

**说明**：

- **`.pipeline/stages.json`**：除上表已点名的阶段外，**design** 至 **smoke** 等各阶段也应把**本阶段门闸所需的输入摘要、输出摘要、完成标记**写入该文件。**字段结构以 `docs/templates/stages.json.template` 中的 `_schema.version=1` 为 v0 契约**；后续若需变更，必须提升 schema 版本并保持迁移说明。该文件应与各阶段 Markdown/契约文件相互印证，避免「状态只在一处口头存在」。
- 上一版 **deploy skill** 内常含 **init**（生成 inventory、部署脚本模板等），本版仍可能在 **ai-publish-dev3 / ai-publish-release3** 前以独立子流程或子命令出现；上表为阶段语义总览，**不**强制把 init 拆成独立「阶段名」，以免表格过长。
- **release 不是独立 stage**（见 §4.1）：release 的版本号、变更日志、打标、托管发布资产上传等子步骤由 **ai-publish-release3** 内部承担，结果以 `stages.deploy.outputs.release_meta` 等子字段回写，不在上表单列。

### 7.1 `.pipeline/stages.json` 状态枚举约定

**阶段主状态**只约束 **`stages.<stage>.status`**，表达阶段生命周期；阶段内部更细的业务结果使用子字段表达，避免把所有结果都塞进主状态。

| 字段 | 允许值 |
| --- | --- |
| `stages.<stage>.status` | `not_started` / `running` / `completed` / `failed` / `skipped` / `blocked` |
| `stages.prd_review.outputs.decision` | `pending` / `passed` / `failed` / `conditional_passed`（`conditional_passed` 必须在 `stages.prd_review.conditions` 全部解除后改写为 `passed`，否则不放行 design） |
| `stages.contract.outputs.human_approval.status` | `pending` / `approved` / `rejected` / `not_required` |
| `validation.checks[].status` | `pending` / `passed` / `failed` / `skipped` |
| `stages.design_review.outputs.decision` | `pending` / `passed` / `failed` / `needs_design_fix` / `needs_contract_fix` |
| `stages.codegen.outputs.impl_codegen_status` | `pending` / `running` / `success` / `failed` / `skipped` |
| `stages.codegen.outputs.test_codegen_status` | `pending` / `running` / `success` / `failed` / `skipped_no_spec` |
| `stages.typecheck.outputs.tools[].status` | `pending` / `passed` / `failed` / `skipped` / `tool_missing` |
| `stages.test.outputs.result` | `pending` / `passed` / `failed` / `skipped_no_test_cmd` / `failed_max_attempts` / `failed_repeated_same_error` / `failed_contract_issue` / `failed_unrelated` |
| `stages.test.rollback_to` | `null` / `codegen` / `contract` |
| `stages.code_review.outputs.decision` | `pending` / `passed` / `failed` / `passed_with_warnings` |
| `stages.merge_push.outputs.merge_status` | `pending` / `merged` / `conflict` / `failed` / `skipped` / `blocked` |
| `stages.merge_push.outputs.push_status` | `not_requested` / `pending` / `pushed` / `failed` |
| `stages.build.outputs.artifacts[].status` | `pending` / `success` / `failed` / `skipped` / `not_applicable` |
| `stages.deploy.outputs.services[].status` | `pending` / `deploying` / `success` / `failed` / `skipped` / `manual_required` |
| `stages.smoke.outputs.checks[].passed` | `true` / `false` |
| `stages.report.outputs.overall_result` | `pending` / `success` / `partial` / `failed` / `blocked` |

### 7.1.1 Feature 级状态（`feature.status`）

**位置**：**`stages.<stage>.features[]`**（与 **`stages.<stage>.status`** 同级，**不在** `outputs` 下）。**`prd`** 阶段无 feature 行（feature 在 prd 派生 `feature_list.md` 后才进入编排全集）；**`report`** 可保留空数组或只读投影，**不**要求各 skill 写入。

**行结构（v0）**：见 **`docs/templates/schemas/stages-feature-row.v1.schema.json`**。必填 **`feature_id`**、**`status`**；**建议** **`started_at`** / **`completed_at`**（ISO 8601 或 `null`）、可选 **`message`**。阶段特有字段（如 **`test`** 的 **`test_result`** / **`attempts`** / **`last_exit`**）写在**同一行**，不得另建 `outputs.per_feature[]`（已废弃）。

| 字段 | 允许值 | 说明 |
| --- | --- | --- |
| **`stages.<stage>.features[].status`**（**`feature.status`**） | `not_started` / `running` / `completed` / `failed` / `skipped` | 与 **`stages.<stage>.status`** 分离；表达**该 feature 在本阶段**的生命周期 |
| （读路径兼容） | `complete` → `completed`；`pending` → `not_started`；`deferred` → `skipped` | 迁移/旧数据归一化；**新写入禁止**使用兼容别名 |

**`feature.status` 语义**：

| 值 | 含义 |
| --- | --- |
| `not_started` | 已列入本期全集（`prd_review.review.phase_plan` 并集）但本阶段**尚未**处理该 feature |
| `running` | 本阶段脚本**正在**处理该 feature |
| `completed` | 本阶段对该 feature 的处理**已成功结束** |
| `failed` | 本阶段对该 feature 的处理**失败**（门闸不通过、命令失败等） |
| `skipped` | 本期**明确不处理**（如 `deferred_features`、或本阶段对该 feature 不适用且脚本已判定跳过） |

**写回规则（定稿）**：

1. **禁止**在阶段开跑时批量把全集 feature 标为 `running`；**仅**在脚本**实际开始处理**某 `feature_id` 时将其标为 `running`。
2. 处理结束须写 **`completed`** 或 **`failed`**（或 **`skipped`**），并填写 **`completed_at`**（终态）。
3. **`prd_review` 终检通过**时：对 `phase_plan` 并集内 feature 写 **`completed`**；对 **`deferred_features`** 写 **`skipped`**。
4. 批次阶段（**`merge_push`** / **`deploy`** / **`smoke`** / **`ui_e2e`** 等）：在**开始作用于该 feature 所属批次**时标 `running`，批次结果落盘后标 `completed` / `failed`。
5. 实现上统一经 **`ai-auto3/scripts/lib/feature-stages.cjs`**（`markFeatureStage` / `markFeaturesCompleted` 等）写入 **`stages.<stage>.features[]`**；读路径可回退 **`outputs.per_feature[]`**（废弃）及 **`design_specs[]` / `artifacts[]` / `worktrees[]`** 等旧结构，**写路径只写 `features[]`**。

**与 `feature_list.md` 分工**：`feature_list.md` 的 Status Values 仍为 **`draft` / `reviewed` / `approved` / `blocked` / `deferred`**（产品生命周期）；**流水线进度**以 **`stages.<stage>.features[].status`** 为准。

### 7.2 各阶段重跑语义矩阵

下表给出每个阶段「重跑会发生什么」的默认语义；**手工单跑**与 **ai-auto3 自动连跑**在判定上一致（见 §8.1 总体约定与 §4.4「已完成」精确判定），但**是否需要二次确认**取决于触发方式：

| 阶段 | 重跑语义 | 默认是否需要用户二次确认（手工触发） |
| --- | --- | --- |
| **prd** | overwrite（覆盖派生稿与 config 草稿） | 是 |
| **prd-review** | overwrite（覆盖评审结论） | 是 |
| **design** | per-feature overwrite（按 feature_id 覆盖设计） | 是 |
| **contract** | per-feature overwrite + human_approval 重置为 pending | 是 |
| **design-review** | overwrite（覆盖结论与缺口列表） | 是 |
| **codegen** | overwrite（worktree 内文件） | 是 |
| **typecheck** | idempotent | 否 |
| **test** | idempotent；修复循环计数清零 | 否 |
| **code-review** | idempotent | 否 |
| **merge-push** | **destructive**（已 push 重跑可能产生新合并提交、覆盖远端） | 是（强制） |
| **build** | overwrite（产物覆盖） | 否 |
| **deploy** | **destructive**（覆盖远端服务版本，可能影响真实流量） | 是（强制；release 环境必须 + 二次审批） |
| **smoke** | idempotent | 否 |
| **ui_e2e** | idempotent | 否 |
| **report** | overwrite | 否 |

- 标记 **destructive** 的阶段，无论手工还是 ai-auto3 自动，都**必须**有 explicit confirm（手工 = 用户确认；**ai-auto3** 对 **dev deploy** 的显式 opt-in 固定为 **`docs/config.dev.json` → `pipeline.autorun.allow_destructive_deploy === true`**，详见 **`docs/spec/publish3.md` §5.1.1**）；缺失或不为 **true** 即按退出码 1 阻断（老项目缺该键时按 **`input-spec.md` §9.1** additive 视为 **`false`**）。
- 标记 **idempotent** 的阶段在 ai-auto3 中可以静默重跑而不提示。

---

## 八、各阶段说明（本版阶段约束草案）

### 8.1 执行方式上的总体约定（先对齐预期）

- **手工跑某一阶段，和自动一路跑下去，结果要一致**  
  每个阶段对应的 skill，可以单独由人触发、一步一步做；也可以交给 **ai-auto3** 按顺序自动调用。两种用法只是**谁按按钮、谁排队**不同，在「输入相同、规则相同」的前提下，**各阶段该产出什么、最终效果应对齐**，不能因为换了一种跑法就变一套结果。

- **同一阶段重复跑：要稳，但要改已有结果时，手工跑要先问人**  
  在输入不变的前提下，同一阶段多跑几次，**输出应当一致、可预期**（不搞「同题不同卷」）。  
  若本阶段**已经有产出**，再跑会**覆盖**掉这些产出，则属于「可能动到已有成果」的情况：在**只跑单个阶段、由人手工触发**时，必须先**提示清楚会覆盖什么**，并得到**用户明确同意**后再继续。  
  **说明**：这一条只约束「单阶段、手工执行」的体验；**ai-auto3** 如何避免误覆盖，由编排侧自己的规则单独写清（本条不直接套用在自动编排上）。

- **ai-auto3：开跑前先验输入；途中遇到「这阶段已经做完」就跳过去**  
  编排从**第一个自动阶段（design）**动身之前，先把后续各阶段要用到的**输入条件**都过一遍：哪一项不满足事先写好的要求，就**立刻停**，并给出**人看得懂的说明**（缺什么、哪里不对），不要糊里糊涂往下跑。  
  执行到某一阶段时，若发现**该阶段的输出已经存在**，且状态表明**这一阶段已经算完成**，则**不要重复干一遍**，而是明确提示「这一阶段已完成」，然后**直接进入下一阶段**。

---

阶段名与顺序见第四节；下面共 **14** 个小节，与阶段链从左到右一一对应。每一节只写「这一阶段打算管什么事」和「约束打算往哪方面写」，侧重业务语言；脚本名、表名、具体 CLI 参数等实现细节可在后续 skill 规格中继续细化。

### 阶段 1：prd

**打算管的事**：把用户的原始想法收敛为**唯一总源头** **`docs/prd-spec.md`**；在校验通过后，按 **prd-spec** 中划定的「端」派生各端的 **`prd.md`** 与 **`feature_list.md`**；同时初始化或补全 **`docs/config.dev.json`** / **`docs/config.release.json`**（非敏感、无密钥），并生成 **`docs/config.env`** 占位文件（只含密钥名与说明，不含真实密钥），再把本阶段门闸状态写入 **`.pipeline/stages.json`**。**不再**为各端维护 **`deployment_plan.json`**——部署资源级草案由两份 **config.*.json** 承载（与上一版各端 deployment 草案**语义替代**）。

**约束打算写清楚的方向**：

- **总源头**：**`docs/prd-spec.md`** 为需求总源头；其正文仅通过 **prd** 流程（或用户显式手工编辑）更新；**prd-review** 不得把评审批注偷偷写回该文件正文（见阶段 2）。
- **内置模板与落盘位置**：**ai-prd3** skill 内置多语言 **prd-spec** 模板，默认选择**中文模板**（**`prd-spec/prd-spec.cn.md.template`**）；首次启动时复制到 **`docs/prd-spec.md`**；已存在则**跳过复制**、不覆盖。
- **配置模板**：**ai-prd3** 内置 **`config.dev.json.template`**、**`config.release.json.template`**、**`config.env.template`**，分别对应 **`docs/config.dev.json`**、**`docs/config.release.json`**、**`docs/config.env`**。其中 JSON 配置的字段结构以 **`docs/templates/config.dev.json.template`** 与 **`docs/templates/config.release.json.template`** 中的 **`_schema.version=1`** 为 v0 契约；若目标文件不存在则复制模板生成，已存在则默认**不覆盖**。**`docs/config.env`** 是 PRD 阶段必须生成的占位文件，但只允许写密钥名、空值与说明，禁止写真实密钥。若已存在文件缺少模板中的必填键，应提示用户确认后做安全补齐，不能静默删除用户已有键。
- **用户输入的处理方式**：对话或参数中的原始需求，应先经提炼、补全、归纳，再写入 **prd-spec** 对应章节，避免原文堆砌。
- **完整性检查**：对 **prd-spec** 做**结构化完整性**检查（目标、范围、角色、核心功能、非功能、端划分、交付边界等）；不通过则**不派生**各端文件、**不**将 **prd** 标为完成。
- **分端派生**：总规完整且校验通过后，按 **`docs/prd-spec.md`** 中显式声明的 **`client_targets`** 在 **`docs/<端>/`** 下生成或更新 **`prd.md`**、**`feature_list.md`**。其中 **`feature_list.md` 的结构以 `docs/templates/feature_list.md.template` 为 v0 契约**，必须保留 Metadata、Status Values、Features、Feature Details 等可解析章节；所有条目须能追溯到 **prd-spec** 中的功能或端需求。
- **`client_targets` 在 prd-spec 中的固定形式**：prd-spec 模板必须包含一节标题为 **`## 端 (Client Targets)`**（生成的 Markdown 锚点为 `#client-targets`，与 `stages.json.template.client_targets.derivation_source` 对齐）。该节内容为**单层无序列表**，每行一个端，取值仅限 `website / admin / backend / mobile / desktop / miniapp / agent`；ai-prd3 解析该节后写入 `stages.client_targets.declared` 与 `stages.prd.outputs.client_targets`。若解析为空或包含未识别值，prd 阶段以退出码 1 失败。
- **`project_id` 生成规则**：ai-prd3 在首次运行时生成 `project_id`，写入 `stages.json.project.project_id` 与 `docs/config.dev.json.project.project_id` / `docs/config.release.json.project.project_id`，三处必须一致。生成规则：
  1. 若项目存在 git remote，则 `project_id = "p-" + sha1("<git_remote_url>|<root_realpath>")[:12]`；
  2. 否则 `project_id = "p-" + uuid_v4()[:12]`。
  生成后**不应自动改写**；如需重置，由用户显式删除三处后重新初始化，否则视为同一项目。
- **prd 阶段完成的判定（本版定稿）**：**「文件齐 + 校验通过」**。具体包括：**`docs/prd-spec.md`** 存在且通过完整性校验；**已派生**的每一相关端目录下 **`prd.md`** 与 **`feature_list.md`** 均存在且通过约定校验；**`docs/config.dev.json`** 与 **`docs/config.release.json`** 存在且通过 schema/必填键校验（无密钥）；**`docs/config.env`** 存在且仅包含占位密钥名/空值/说明，不含真实密钥；**`.pipeline/stages.json`** 中 **`stages.prd.status="completed"`**，且 **`stages.prd.validation.passed=true`**。阶段状态枚举固定为：**`not_started` / `running` / `completed` / `failed` / `skipped` / `blocked`**。**不**要求用户口头「点确认」作为必要条件。
- **与 skill 目录 DB**：更新 **`.pipeline/stages.json`** 后，应**同步或幂等对齐** skill 目录内该项目的编排索引（见 §3.2），避免本机 DB 与仓库内状态长期偏离。
- **Git（§3.5）**：**`bootstrap` 最先** **`git init`** 并合并 **`.gitignore`**，**bootstrap 收尾**对**项目下全部文件**（`git add -A`）**commit+push**；**`write-prd` 完成**后再 **commit+push `docs/` + `.pipeline/`** 等增量。**`git.allow_push=false`** 时仅本地 commit，须在 report 中提示未推送。

  ```text
  <project_root>/
  |-- inputs/                       # 原始需求（随全仓首 commit 一并入库）
  |-- .pipeline/
  |   |-- stages.json
  docs/
  |-- prd-spec.md
  |-- config.dev.json
  |-- config.release.json
  |-- config.env                    # 敏感；固定路径：docs/config.env
  |-- website/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- admin/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- backend/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- miniapp/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- mobile/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- desktop/
  |   |-- prd.md
  |   |-- feature_list.md
  |-- agent/
  |   |-- prd.md
  |   |-- feature_list.md
  ```

---

### 阶段 2：prd-review

**打算管的事**：在**不污染总源头正文**的前提下，对 **prd** 产出做评审与分期：澄清缺口、调整优先级、标识跨期依赖与阻塞项；必要时给出 **`config.dev.json` / `config.release.json`** 的修订建议（仍不得含密钥）；将结论固化到 **`.pipeline/stages.json`**，使 **ai-design3** 与 **ai-auto3** 能可靠判定「可否进入 **design**」。

**约束打算写清楚的方向**：

- **真源与禁止项**：**`docs/prd-spec.md`** 总源头——**评审意见、讨论纪要、批注**不得默认写回该文件正文。若确需改总规，须先在 **prd-review** 结论中记录 **`suggested_prd_spec_changes`**，并在**对话中显式确认**后回到 **prd** 流程更新 **`docs/prd-spec.md`**，再重新派生各端文件（**不设**单独人工签审表单）。允许在 **prd-review** 产出中引用「建议修改 prd-spec §…」的**指针式说明**。各端 **`prd.md`** 在评审阶段默认**不当作批注白板**；对端的调整应通过 **「评审结论 → 回到 prd 流程修订 → 再派生」** 对齐，避免评审与派生稿双源漂移。
- **读取输入**：**`docs/prd-spec.md`**、各端 **`prd.md`** / **`feature_list.md`**、**`docs/config.dev.json`** / **`docs/config.release.json`**（若已生成）、以及 **`.pipeline/stages.json`** 中 **prd** 的完成记录与校验摘要。
- **写入输出**：在 **`.pipeline/stages.json`** 的 **`stages.prd_review`** 块写入：**评审结论**（`outputs.decision`，取值见 §7.1）、**分期方案**（`review.phase_plan[*]`，含本期 `feature_ids`）、**优先级变更**（`review.priority_changes[]`）、**阻塞项列表**（`blocking_issues[]`，须含责任方 / 解除条件或指向 issue）、**跨期依赖**（`review.cross_phase_dependencies[]`，显式列出依赖方与被依赖方）；**配置变更建议**写入 `review.config_change_suggestions.dev[]` / `review.config_change_suggestions.release[]` 或 `review.suggested_prd_spec_changes[]`，**不**将密钥写入仓库。
- **给人读的摘要（归档）**：**ai-prd3** 在 **`validate-prd-review` 终检通过**（或等价地 **`finalize-prd-review`** 成功）后会**尝试**写入 **`.pipeline/reports/prd-implementation-summary.md`**：文件**开头**为 **「AI 评审门闸结果」**（`decision`、`can_enter_design`、阻塞项计数、`validation.summary` 等），随后用自然语言汇总 **`phase_plan`** 分期数、第一期目标与功能名，与各端 **`feature_list.md`** 对齐；写入失败仅 **stderr 警告**、**不**改变终检成功）；**不**作为门闸真源，细节以 **`prd3.md` §8.8** 为准。亦可随时用 **`run.cjs report`** 按当前磁盘 **`stages.json`** 重生成（须 **`prd_review` 已完成且 `outputs.decision=passed`**）。
- **与部署配置的关系**：上一版「部署计划建议」职能由对 **`config.dev.json` / `config.release.json`** 的**建议补丁**或**已达成共识的键值更新**承担；**不**再生成各端 **`deployment_plan.json`**。
- **prd-review 完成且可进入 design 的判定（本版定稿）**：须**同时**满足：
  1. **`.pipeline/stages.json`** 中 **`stages.prd_review.status="completed"`**，且 **`stages.prd_review.outputs.decision="passed"`**；
  2. **阻塞项计数为 0**（**blocking_issues.length === 0** 或等价）；若采用「带条件通过」，则条件须已全部在 **stages.json**（或链接的跟踪处）标记为 **已落实**；
  3. **本期范围内**各特性在评审输出中已具备明确 **design** 输入所需信息（验收边界、约束、端责任）——缺一则视为未通过评审或仍阻塞；
  4. **密钥仍只存在于 `config.env`**；**config.*.json** 通过静态规则扫描无敏感字段。
- **prd-review decision 枚举**：**`stages.prd_review.outputs.decision`** 固定为 **`pending` / `passed` / `failed` / `conditional_passed`**。只有 **`passed`** 可直接进入 design；**`conditional_passed`** 必须在所有条件落实后改为 **`passed`**。
- **覆盖重跑**：若将覆盖已有评审结论或 **stages.json** 中 `stages.prd_review` 块，须按 §8.1「执行方式上的总体约定」在对话中获**显式同意**或传 **`--force`** 后再执行（**不设**单独人工签审表单）。
- **完成后对用户提示**：须显式告知下一步：**进入设计**请使用 **`ai-design3`**；若希望从设计起自动跑通至 dev 发布，请使用 **`ai-auto3`**（起点为 **design**，见 §4.3）。
- **Git（§3.5）**：**每个 `feature_id` 在 `stages.prd_review.features[].status=completed` 后**调用 **`git-pipeline-sync`**（路径：`inputs/`、`docs/`、`.pipeline/`），**commit + push**。

---

### 阶段 3：design

**打算管的事**：把已经通过 **prd-review** 的本期功能，转成后续契约阶段可消费的**设计规格**。设计规格应说明每个功能计划新增/修改哪些文件、复用哪些已有能力、需要哪些 API / 数据 / 权限 / 第三方依赖、有什么约束和风险；本阶段只产出设计，不直接写实现代码，也不直接生成最终契约。

**约束打算写清楚的方向**：

- **前置门闸**：只有 **`.pipeline/stages.json`** 中 **`stages.prd_review.status="completed"`** 且 **`stages.prd_review.outputs.decision="passed"`** 时，整体方可进入 design 阶段；本期具体涵盖哪些 feature，按 **`stages.prd_review.review.phase_plan[*].feature_ids`** 取，未列入本期的 feature 不应在本轮 design 中处理。
- **输出内容**：设计规格至少应包含：功能 ID、端、目标文件清单（新增 / 修改 / 复用）、API 路由思路、数据变更思路、验收边界、约束、依赖、风险与需要人工确认的问题。
- **不越权生成契约**：本阶段**不**直接生成 `types`、`api.yaml`、数据库 schema、测试契约等终稿；这些属于 **contract** 阶段。
- **可选确定性子命令（ai-design3）**：在 **`validate-design`** 之前，编排可调用 **`scan-design-style`**（按 `client_target` 扫描源码树片段并写 `docs/designs/<feature_id>.style-scan.json`）与 **`lib-research`**（函数域库选型研究，写 `docs/designs/<feature_id>.lib-research.json` 并回写 `design.json` 的 `library_decisions` / `constraints`）；子命令名与行为以 **`docs/spec/design3.md`** §6.1 与 **`ai-design3/SKILL.md`** 为真源。
- **减少合并冲突**：设计时应避免多个功能同时修改同一个汇总文件；需要汇总入口时，应优先设计为插件式、注册式或单点由主线维护。
- **横切约束显式化**：如 CORS、鉴权、日志、审计、限流、跨端 API base URL、云平台绑定等，不应留在口头说明里，应进入设计规格的约束或依赖清单。
- **共享代码层（monorepo 等）**：若项目存在 `packages/common/`、`packages/sdk/` 等不属于任何单一 client_target 的共享层，其变更必须在每个**引用它的端**的 design 中显式列出影响（"本 feature 修改了 `packages/common/foo.ts`"），并在 codegen 阶段**统一在共享层完成修改**，避免跨 worktree 重复修改同一文件。共享层变更的归属端记录在 `stages.design.outputs.design_specs[].shared_changes[]`。
- **状态写入**：设计完成后应在 **`.pipeline/stages.json`** 写入 **design** 状态、设计产物路径/摘要、校验结论；只有 `status="completed"` 且 `validation.passed=true` 才能进入 contract。
- **Git（§3.5）**：**每个 feature 在 design 阶段 `completed` 后** **commit + push**（`inputs/`、`docs/`、`.pipeline/`）。

---

### 阶段 4：contract

**打算管的事**：把已完成并通过校验的设计规格，转成后续实现阶段可严格遵守的**契约产物**。契约应覆盖类型、API、数据、测试、以及与设计一致的规格快照，让实现阶段有明确边界，避免「边写代码边改需求 / 改接口」。

**约束打算写清楚的方向**：

- **前置门闸**：只读取 **design** 已完成且校验通过的功能；设计中存在阻塞问题时不得生成契约。
- **契约产物（5 类，固定映射）**：本阶段必须产出且仅产出下列 5 类契约，写入 `stages.contract.outputs.artifacts[*]` 对应字段：

  | 中文显示名 | JSON key | 推荐文件命名 | 主要承载内容 |
  | --- | --- | --- | --- |
  | 类型 / 接口定义 | `types` | `<feature>.types.ts` / `.py` | 共享的类型、DTO、枚举 |
  | API 描述 | `api` | `<feature>.api.yaml` | OpenAPI 3.x，**必须支持 `x-smoke` 扩展**（见 §8.13） |
  | 数据 schema | `schema` | `<feature>.schema.sql` / `.prisma` / `.json` | 数据库结构或数据模型 |
  | 测试规格 | `test_spec` | `<feature>.test-spec.md` / `.yaml` | 用例与验收边界，供 codegen 生成测试代码；可选 `required_test_levels: [unit, integration, ui_e2e]`；**`ui_scenarios[]`** 供 **ai-e2e3** 执行（见 **`docs/spec/e2e3.md` §3**） |
  | 设计快照 | `design_snapshot` | `<feature>.design.snapshot.json` | 与本 contract 同步的设计结构化快照（供 design-review 比对） |

  契约必须能从 `stages.json` 追溯到 `feature_id` 与端；任何一类缺失都不得标 contract 完成。
- **设计一致性**：契约不得凭空扩展设计范围；若发现设计缺字段、缺接口、验收不清，应把 contract 标为 blocked/failed，并回到 design 补齐。
- **机器校验**：契约生成后必须做机器校验，例如类型检查、OpenAPI 校验、SQL/schema 校验、测试规格结构校验、设计快照 schema 校验；任一关键校验失败，不得进入 codegen。
- **人工批准与机器通过分离**：人工认为契约方向正确，与机器校验通过是两个动作；只有两者都满足时，contract 才算可进入实现。
- **ai-auto3 在 contract 阶段的行为**：当自动序列跑到 contract 且 `stages.contract.outputs.human_approval.status="pending"` 时，**ai-auto3 必须停在 contract**，把 `stages.contract.status` 写为 `blocked`，并在 report 中明确写出「下一步：用 **ai-design3** 的契约审批子命令完成 approve / reject」；**ai-auto3 不得替用户默认 approve**。机器校验失败则按退出码 1/4/5 处理，同样阻断后续阶段。
- **状态写入**：在 **`.pipeline/stages.json`** 中记录契约产物路径、人工审批状态、各类机器校验结果、失败摘要；完成条件为 **`stages.contract.status="completed"`** 且 **`validation.passed=true`** 且 **`outputs.human_approval.status="approved"`**。
- **Git（§3.5）**：**每个 feature 在 contract 阶段 `completed` 后** **commit + push**（同上路径）。

---

### 阶段 5：design-review

**打算管的事**：对照 **design** 与 **contract** 做一次设计侧复核，确认契约没有遗漏、误解或越权扩展设计，消除「设计说一套、契约写另一套」的缺口。这个阶段是本版新增的设计/契约一致性门闸，目的是在进入实现前尽早发现偏差。

**约束打算写清楚的方向**：

- **输入范围**：读取设计规格、五类契约产物、contract 阶段校验结果，以及 prd-review 中本期范围和约束。
- **复核重点**：检查文件清单是否覆盖、API 与设计是否一致、数据变更是否可追溯、测试规格是否覆盖验收标准、横切约束是否进入契约。
- **不得直接修契约**：若发现缺口，本阶段只记录对齐结论和缺口清单；是否回到 design 或 contract 由编排/人工决定，不在 review 中静默改契约。
- **放行条件**：无阻塞缺口、无设计/契约冲突、无未处理的高风险项，才允许进入 codegen。
- **状态写入**：在 **`.pipeline/stages.json`** 写入 design-review 结论、缺口列表、放行判断；完成条件为 **`stages.design_review.status="completed"`**、**`validation.passed=true`**，且阻塞缺口数为 0。
- **Git（§3.5）**：**每个 feature 在 design-review 阶段 `completed` 后** **commit + push**（同上路径）。

---

### 阶段 6：codegen

**打算管的事**：在隔离工作区或等价机制中，根据已通过设计复核的契约生成实现代码与必要测试代码。实现阶段只按契约落地，不回头修改需求、设计或契约；若契约不够，应通过状态建议回退，而不是在代码生成阶段私自补契约。

**约束打算写清楚的方向**：

- **前置门闸**：必须满足 contract 机器校验通过、design-review 放行；契约产物齐全且可读。
- **隔离实现**：为每个 **`feature_id`** 使用独立 **git worktree**（或等价隔离）；默认路径与分支命名、复用/续跑、**diff-guard** 双检、**Agent** 分相（实现 → 测试）、环境变量与 **`stages.codegen.outputs.agent`** 字段语义以 **`docs/spec/code3.md` §7.4–§7.12** 为唯一实现真源（对齐上一代 **ai-codegen2** 的 **worktree + Agent** 心智模型，状态从 SQLite 行迁移为 **`stages.json`** 的 **`worktrees[]`**）。
- **只改允许范围**：实现应限制在 **`design_snapshot`**（及 **`design_specs`/`file_plan`**）与契约声明的新建和修改文件范围内；需要新增未声明公共 API 或关键文件时，应回到 design/contract。
- **契约保护**：严禁修改五类契约产物；主仓与 worktree 内均须执行契约路径 **diff-guard**；若实现或 Agent 改动契约，应视为契约破坏，**退出码 5** 或等价状态（见 **`docs/spec/code3.md` §7.3 / §7.12**）。
- **测试代码同步**：契约中要求的测试文件或测试骨架，应在本阶段生成或补齐；无测试规格时 **`test_codegen_status=skipped_no_spec`** 并须可解释。
- **真实填码与 CI**：**`AI_CODE3_SKIP_AGENT=1`**（及兼容 **`AI_CODEGEN_SKIP_AGENT=1`**）用于 CI/冒烟时跳过外部 Agent，但**不得**在状态中伪造成功；编排上 **真实填码** 通常在开发者本机或有 **Cursor Agent CLI / `@cursor/sdk`** 凭证的环境执行（详见 **`docs/spec/code3.md` §7.10–§7.11**）。
- **状态写入**：在 **`.pipeline/stages.json`** 中记录 **`worktrees[]`**（**`branch` / `worktree_path` / `commit` / `files_*`**）、**`impl_codegen_status` / `test_codegen_status`**、**`outputs.agent`**、耗时与超时字段；完成条件为 codegen 状态完成且实现与测试生成均成功或有明确可接受的跳过原因。
- **Git（§3.5）**：**不再**在本阶段 `git init`（须 prd **bootstrap** 已初始化）。**每个 feature 在 codegen `completed` 后**将 **`src/`** 与 **`inputs/`、`docs/`、`.pipeline/`** 一并 **commit + push**（worktree 内实现合并回主线路径后由脚本落盘到 `src/`）。

---

### 阶段 7：typecheck

**打算管的事**：对 codegen 产出的工作区执行类型检查、静态检查和语言级门闸，尽早发现语法、类型、lint、Python 类型等问题。这个阶段不负责跑业务测试，也不负责改契约。

**约束打算写清楚的方向**：

- **前置门闸**：codegen 已成功，且工作区路径可访问。
- **工具探测**：按项目语言和配置自动探测工具，例如 TypeScript 的 `tsc` / ESLint，Python 的 mypy / pyright；其它语言可按后续实现扩展。
- **跳过要可解释**：未探测到任何可执行检查工具时，可以标记 skipped，但必须记录原因；探测到并执行的工具必须通过。
- **不跑测试**：单元测试、集成测试、功能测试归 **test** 阶段；typecheck 只做静态/类型/格式类门闸。
- **失败处理**：检查失败应记录工具名、命令、摘要、日志路径，并阻断 test；可由编排回到 codegen 修复。
- **状态写入**：在 **`.pipeline/stages.json`** 写入每个工具的执行结果、错误摘要和状态；通过条件为所有已执行工具 exit=0，或全部 skipped 且 skip_reason 明确并被规则允许。
- **Git（§3.5）**：**每个 feature 在 typecheck `completed` 后** **commit + push**（含 **`src/`**）。

---

### 阶段 8：test

**打算管的事**：在 typecheck 通过后运行项目测试，验证实现是否满足契约和验收要求；失败时可进入有限次数的修复循环，并在耗尽后给出建议回退点（回 codegen 或回 contract），但不直接越权调用上游阶段。

**约束打算写清楚的方向**：

- **前置门闸**：typecheck 已通过；codegen 的实现代码与测试代码已生成成功，或测试生成有明确允许的跳过理由。
- **测试命令探测**：优先使用用户/配置指定的测试命令；否则按项目类型探测 npm/pnpm/yarn、pytest、cargo test 等。
- **测试范围收敛**：能定位到 feature 专属测试时，应优先运行该 feature 相关测试；回退全量测试时必须记录可能包含无关失败。
- **修复循环有限**：测试失败可由 AI 或脚本尝试修复实现代码，但次数必须有上限；不得在修复中修改契约。**默认上限 `max_fix_attempts=3`**，由模板 v0 显式收纳为 `docs/config.dev.json.build.commands.test_max_fix_attempts`（与 release 对档），可按需调整。
- **测试层级门禁（建议）**：若 contract 的 `test_spec` 声明 `required_test_levels`（如 `["unit","integration","ui_e2e"]`），test 阶段应校验对应层级测试是否存在（**`ui_e2e`** 指场景清单与 `src/<端>/tests/e2e/` 或 `integration_test/` 占位，**不**在 merge 前跑 Browser/Dart MCP）；建议先 `warn`，稳定后升级为 `enforce`。
- **失败归因**：若失败明显来自契约缺陷，状态建议 `rollback_to=contract`；若是实现缺陷或重复同错，建议 `rollback_to=codegen`；无关失败需标注为可能的既有问题。
- **状态写入**：在 **`.pipeline/stages.json`** 写入测试命令、尝试次数、结果、失败摘要、日志路径、rollback_to；只有测试通过或按规则允许跳过时才可进入 code-review。
- **Git（§3.5）**：**每个 feature 在 test `completed` 后** **commit + push**（含 **`src/`**）。

---

### 阶段 9：code-review

**打算管的事**：在测试通过后，对照契约和设计做代码完整性审查，确认实现没有缺文件、缺接口、残留骨架、偏离复用约定、破坏 API base URL / CORS 等关键约束。这个阶段关注行为风险和契约完整性，不替代测试。

**约束打算写清楚的方向**：

- **前置门闸**：test 已通过；contract、codegen、typecheck 状态均可追溯。
- **审查清单**：至少覆盖新文件是否存在、是否残留占位/TODO 骨架、接口/handler 是否实现、API 路由是否匹配、复用约定是否使用、设计约束是否遵守、前端 API base URL 是否正确、后端 CORS 是否配置。
- **问题分级**：critical 问题阻断合并；warning 可记录但不阻断，除非用户或配置要求 strict。
- **失败路由**：代码审查失败默认建议回到 codegen 修复后重跑，不应直接回到 test 或 contract，除非审查结论明确指出契约本身错误。
- **字段隔离**：本阶段只写 code-review 相关状态，不篡改 test/typecheck/codegen 的通过失败字段。
- **状态写入**：在 **`.pipeline/stages.json`** 写入 checklist、critical 数、warning 数、审查结论与建议修复方向；critical 为 0 且前置状态一致时才可进入 merge-push。
- **Git（§3.5）**：**每个 feature 在 test / code-review `completed` 后**分别 **commit + push**（含 **`src/`**）。

---

### 阶段 10：merge-push（职责与上一版 merge / ai-git2 相当）

**打算管的事**：把已经通过测试和代码审查的隔离工作区合并回目标分支，并按配置决定是否推送远端。它只处理 Git 合并与推送状态，不重新判断测试是否通过，也不修改测试结果本身。

**约束打算写清楚的方向**：

- **前置门闸**：test 通过、code-review 通过、codegen 产出的分支/worktree 可访问，目标分支存在且仓库状态可合并。
- **合并后代码落位**：合并回主线后，各端实现代码应位于 `src/<client_target>/`（或其子目录）；若发现端代码落在约定目录之外，需在 merge-push 结果中标注并阻断进入 build（除非该路径属于已声明共享层，如 `src/shared/`）。
- **合并策略**：默认本地合并；是否 rebase、是否 push、目标分支名，均应来自配置或用户明确参数。
- **冲突处理**：发生冲突时应停止自动推进，记录冲突文件、当前分支、处理建议；可支持人工模式或后续策略，但不得静默丢弃改动。
- **push 失败区分**：已合并但推送失败时，应明确记录「本地已合并、远端未推送」，避免编排误判为完全失败。
- **字段隔离**：只写 merge/push 相关状态，不改 test、code-review、codegen 的通过失败字段。
- **状态写入**：在 **`.pipeline/stages.json`** 写入目标分支、merge commit、push 结果、冲突/失败摘要；合并冲突映射为退出码 6，推送失败映射为退出码 7。
- **Git（§3.5）**：每个 **feature 分支**合入主线后，对 **`inputs/`、`docs/`、`.pipeline/`、`src/`** 做 **commit + push**（与 **`git.allow_push`** 及 **§11.4** 干净树门闸一致）；feature 级推送与「合并后一次 push」可合并为单次 push，但须在日志中标明。

---

### 阶段 11：build

**打算管的事**：在代码已合并后，为需要编译产物的端执行构建，产出后续 deploy 可直接使用的 artifact。纯后端或无需构建的端应显式标记为 N/A，而不是假装成功构建。

**约束打算写清楚的方向**：

- **适用范围**：默认适用于 `website`、`admin`、`miniapp`、`mobile`、`desktop`、`agent` 等需要产物的端；`backend` 若按服务端源码直接部署，可跳过并写明原因。
- **前置门闸**：merge-push 已完成本地合并；源码目录和构建配置可读。
- **构建探测**：按端和工程类型探测构建方式，例如 Vite/Next/CRA/generic npm、Taro/Uniapp/原生小程序、React Native/Flutter、Electron/Tauri、Python/Node/Go/Rust agent 等。
- **子平台声明**：mobile / miniapp / desktop 等可能存在多子平台（如 `mobile.sub_platforms=["ios","android"]`、`miniapp.sub_platforms=["weixin","alipay"]`），必须在 **`docs/config.dev.json` / `docs/config.release.json`** 的 **`build.client_targets.<target>.sub_platforms[]`** 中显式声明；**`stages.build.outputs.artifacts[]`** 按 `(client_target, sub_platform)` 拆行写入。未声明子平台的端按单平台处理。
- **产物校验**：构建成功不能只看命令 exit=0，还要检查约定产物目录/关键文件是否存在。
- **不重新部署**：build 只生成产物，不上传云平台；deploy 只读取 build 产物，不应在 deploy 内隐式重新构建。
- **状态写入**：在 **`.pipeline/stages.json`** 写入构建命令、子平台、产物路径、产物校验结果、日志路径；失败时阻断 deploy。

---

### 阶段 12：deploy

**打算管的事**：在合并和必要构建完成后，把本期功能部署到目标环境。dev 部署由 **ai-publish-dev3** 承担，release 部署由 **ai-publish-release3** 承担；两者共享配置结构，但默认自动编排只到 dev deploy + smoke。

**约束打算写清楚的方向**：

- **配置来源**：部署读取 **`docs/config.dev.json`** 或 **`docs/config.release.json`**，凭证只从 **`docs/config.env`** 或批准的密钥管理方案读取；不得把密钥写回 JSON。
- **服务选择**：云平台和服务候选来自 **`docs/templates/deploy-services.catalog.json`**；生成项目配置时只保留用户选择且项目实际需要的 provider/services，不把整份 catalog 写进配置。
- **build 产物 → deploy 服务的映射规则**：deploy 按 `(client_target, sub_platform)` 元组在 `stages.build.outputs.artifacts[]` 中查找对应 `artifact_path`；**`deploy.services[].sub_platform` 未声明或空串时视为 `default`**（与 **ai-code3** 单平台 `artifacts[].sub_platform` 一致）；产物 **`status` 须为 `success` 或 `completed`**。若 `docs/config.dev.json.deploy.services[].artifact_ref` 显式指向某 artifact（如 `"<client_target>:<sub_platform>"`），以此为准。一个 service 必须能且只能匹配到一个 artifact，否则以退出码 1 失败（**ai-publish-dev3** `lib/artifacts.cjs` 输出可读原因）。
- **前置门闸**：merge-push 完成；需要构建产物的端必须 build 成功；部署配置必填项齐全；凭证可用。
- **环境差异**：dev 可允许自动创建/更新资源；release 默认需要显式确认或审批，避免误发线上。
- **结果记录**：部署后必须记录可访问 URL、环境、provider、service、版本/commit、部署日志；失败时区分前置失败、云 API 失败、凭证失败、产物缺失。
- **状态写入**：在 **`.pipeline/stages.json`** 写入 deploy 状态；云平台/API 失败映射为退出码 8；部署成功后解锁 smoke。

---

### 阶段 13：smoke

**打算管的事**：对已部署环境做轻量冒烟验证，确认服务可访问、核心接口或页面返回符合契约或配置预期。冒烟只做低风险检查，默认不执行破坏性写入。

**约束打算写清楚的方向**：

- **前置门闸**：deploy 成功，且可读部署 URL / base URL；若契约中有冒烟标记，则按契约生成检查项。
- **检查来源**：优先读取 `api.yaml` 中的 **`x-smoke`** 扩展属性（contract 阶段已固化），其次合并 `docs/config.dev.json` / `docs/config.release.json` 的 `smoke.checks[]`；两处都为空时可标记 skipped 并说明原因。`x-smoke` 字段建议结构（在 contract 阶段已写入 OpenAPI 路径项内）：

  ```yaml
  paths:
    /healthz:
      get:
        x-smoke:
          enabled: true
          expected_status: 200
          safe: true   # 仅显式 safe=true 的非 GET/HEAD 才允许冒烟调用
  ```
- **安全边界**：默认只做 GET/HEAD 或明确标记安全的请求；需要 body 的写操作必须使用测试账号、mock 或明确的安全模板。
- **敏感信息保护**：记录检查结果时不得保存鉴权头、密钥、完整响应体等敏感数据。
- **失败处理**：任一必要冒烟失败则阻断 release/report 的成功结论；失败摘要应包含路径、期望状态、实际状态、错误摘要和日志路径。
- **状态写入**：在 **`.pipeline/stages.json`** 写入 smoke 结果、检查项、失败列表、耗时和跳过原因；通过后可进入 **ui_e2e**（若启用）或 **report**；release 流程也可将 smoke 作为正式发布前置。

---

### 阶段 13.1：ui_e2e（本版新增）

**打算管的事**：在 **deploy/build** 与 **HTTP smoke** 满足前置后，按契约 **`test_spec.ui_scenarios[]`** 对 **website/admin**（Browser MCP）与 **mobile android/ios**（Dart MCP / `integration_test`）做 UI 端到端验收；失败时进入有限次 **`ui_test_fix`** 修复环；结果写入 **`stages.ui_e2e`** 与 **`.pipeline/reports/ui-e2e-*.md`**。

**约束打算写清楚的方向**：

- **skill**：**ai-e2e3**（**不**并入 ai-publish-dev3 smoke）；规格见 **`docs/spec/e2e3.md`**。
- **前置门闸**：`stages.smoke` 完成且 `validation.passed=true`（或 `require_smoke_passed=false` 且 base_url 可解析）；mobile 另需对应 **`stages.build.outputs.artifacts[]`** 与设备门闸。
- **配置**：`docs/config.dev.json` → **`ui_e2e`**（`enabled`、`web.*.base_url_from`、`mobile.sub_platforms` 等）；**默认 `enabled=false`**，避免无 MCP/无设备环境误失败。
- **与 test 阶段分工**：**ai-code3 test** 在 worktree 跑单元/集成；**ui_e2e** 在部署/安装后跑真实 UI，**不得**篡改 **`stages.test`** 通过字段。
- **状态写入**：`stages.ui_e2e.outputs.scenarios_*`、`results[]`、`report_path`、`fix_attempts`；`validation.passed` 为真方可进入 **report**（启用时）。

---

### 阶段 14：report

**打算管的事**：用非技术读者也能看懂的方式汇总本轮流水线结果，说明本次做了什么、哪些端/功能已推进到哪里、是否部署成功、哪里失败、下一步建议是什么。它是给人看的收口报告，同时也应保留机器可追溯的状态摘要。

**约束打算写清楚的方向**：

- **输入来源**：以 **`.pipeline/stages.json`** 为主，结合关键日志路径、产物路径、部署 URL、冒烟结果、失败摘要生成报告。
- **报告内容**：至少包含本次范围、涉及端、功能列表、各阶段状态、关键产物/URL、失败点、阻塞项、建议下一步。
- **读者分层**：先给业务/产品可读摘要，再给工程排查所需的日志、commit、artifact、stage JSON 指针。
- **不改历史状态**：report 不应篡改各阶段事实状态；只能写入 report 自己的摘要、生成时间、报告路径或链接。
- **失败也要报告**：即使流水线中途失败，也应生成失败报告，指出停在哪一阶段、缺什么、建议人工补什么或从哪一阶段续跑。
- **跨项目数据边界**：本版 report 仅基于**本项目**的 `.pipeline/stages.json` 与本项目日志生成；**不**读取 skill 目录 DB 中其它项目的运行历史，不输出跨项目 KPI。跨项目汇总能力留待后续版本（需提升相关模板的 `_schema.version`）。
- **状态写入**：在 **`.pipeline/stages.json`** 写入 report 状态和报告索引；若整条链未完全成功，report 可以完成，但总结果应如实标为 partial/failed，而不是覆盖成 success。

---

## 九、文档怎么用

- 第八部分已经按本版阶段链补齐 **14** 个阶段的「打算管的事」和「约束方向」；后续若调整某阶段，应同步检查第七节输入输出表、§3.1 **`.pipeline/stages.json`** 约定与相关模板。
- 字段级 v0 契约以 **`docs/templates/stages.json.template`**、**`docs/templates/feature_list.md.template`**、**`docs/templates/config.dev.json.template`**、**`docs/templates/config.release.json.template`**、**`docs/templates/config.env.template`**、**`docs/templates/deploy-services.catalog.json`** 为准；实现侧若需要调整字段，必须同步更新模板与本文引用，并提升对应 **`_schema.version`**。
- 若某一阶段和上一版差异很大，在对应小节里用一句话标出来即可，不必在本文写实现方案。

### 9.1 模板 schema 演进规则

本版**不承诺**与上一版的字段、文件名、目录结构兼容；同样地，本版自身的 v0 契约（`_schema.version=1`）在演进时也必须遵守如下规则，避免「老项目跑新 skill 时静默失败」：

- **additive（向后兼容的新增）**：
  - 在 `stages.json.template` / `config.*.json.template` 中**新增字段**且具备明确默认值时，可以**不提升 `_schema.version`**，但模板必须同步更新。
  - ai-*3 加载老版本 `stages.json` / `config.*.json` 时，**必须自动以默认值补齐缺失字段**，并写回文件，不得退出失败。
- **breaking（破坏性变更）**：
  - 任何**字段删除、重命名、类型变更、枚举收紧**，必须将对应模板的 `_schema.version` 升 1，并在 `docs/templates/migrations/` 下新增 `vN_to_vN+1.md`（含字段映射表与示例）。
  - ai-*3 在加载时若发现文件 `_schema.version` **高于**自身支持版本，应直接以退出码 1 失败，并提示用户升级 skill；若**低于**支持版本但存在迁移脚本，则在用户确认后执行迁移并写回。
- **不允许的演进方式**：
  - **原地改语义**（如把 `passed` 改成 `success`）必须算 breaking。
  - **静默丢弃**用户在老版本中写入的字段（即使未在新模板中出现）。
  - 在同一 `_schema.version` 内对默认值做不可逆变更。
- **跨模板联动**：当 `stages.json.template` 与 `config.*.json.template` 中互相引用的字段需要同步演进时（如新增一个 `client_target` 候选），两份模板**必须同次提交**，并在本文相应章节同步更新。

#### 9.1.1 additive vs breaking 实例（来自本版自身演进）

下表给出本文档实际定稿过程中出现过的几种字段调整，按 §9.1 规则归类，方便后续读者一眼判断"该不该升 `_schema.version`"：

| 改动 | 类型 | 原因 | `_schema.version` 变化 |
| --- | --- | --- | --- |
| 在 `config.dev.json` / `config.release.json` 顶层新增 `timeouts.{ autorun_total_s, stages.<x>_s, subcommand.* }` | **additive** | 全部新字段，且默认值（`7200`、阶段超时表、`30`、`5` 等）已在模板中给出；老 `config.*.json` 缺这一段时 ai-*3 用默认值补齐即可继续跑 | 不变（仍为 v1） |
| 在 `config.dev.json.build.commands` 下新增 `test_max_fix_attempts: 3` | **additive** | 新字段、有默认值；老配置缺此键时按 3 兜底 | 不变 |
| 在 `stages.json.template` 每个 stage 的 `outputs` 下新增 `duration_ms` / `timed_out` / `timeout_reason` | **additive** | 新字段、默认 `null` / `false` / `null`；老 `stages.json` 缺这些字段不会让任何 ai-*3 失败 | 不变 |
| 把 `stages.contract.outputs.human_approval.status` 的取值从 `pending / approved / rejected / not_required` **改成** `pending / accepted / rejected`（删 `approved` 与 `not_required`） | **breaking**（假设性反例） | 删值 + 改名 = 枚举收紧；老数据中的 `approved` / `not_required` 会被新校验拒绝 | 必升至 v2，并写 `migrations/v1_to_v2.md` |
| 把 `stages.<stage>.status` 中的 `completed` **原地改写**为 `success` | **breaking**（假设性反例） | 原地改语义即使值一一对应也算 breaking，会让老 `stages.json` 全部失效 | 必升至 v2 |
| 新增一个 `client_target` 候选值（如 `tv`） | **additive** | 在 `stages.json.template.client_targets.allowed_values[]` 末尾追加；老配置不引用即不受影响 | 不变；但需**同步**更新 `feature_list.md.template`、`config.*.json` 引用与本文 §3 端列表（跨模板联动） |
| 把 `docs/config.env` 路径改为 `docs/.env` | **breaking**（假设性反例） | 文件路径变更；ai-*3 需要回退查找逻辑或迁移工具 | 必升 + 迁移说明 |

**判断口诀**：

> 「**老文件不动，新 skill 跑得起来**」→ additive；  
> 「**老文件不改，新 skill 跑不起来 / 跑出错结果**」→ breaking。

`tip`：拿不准时，先在本机用一份**未升级**的老 `stages.json` / `config.*.json` 跑一遍新 skill；如果默认值能补齐、行为正确，就是 additive；如果立刻报 schema 错或行为错，就是 breaking。

### 9.2 与上一版的边界声明

本版以「**完整重写、不向后兼容**」为基调：

- **不**保证可以读取上一版（`~/.cursor/skills/`）写出的 `stages.json` / 各端 `deployment_plan.json` / `scripts/config.env` 等历史文件；如需迁移老项目，由人工或一次性迁移脚本完成，**ai-*3 自身不内置兼容回退**。
- 上一版仓库（https://github.com/rudyzhuang/skills.git）仅作为**字段级与流程级的参考来源**，本版的真源以本文与 `docs/templates/` 为准。

### 9.3 字段级迁移清单（v2 → v3，参考性、非自动）

下列对照表覆盖上一版（v2）已知的项目侧产物文件与本机数据库表，**仅供一次性脚本化迁移参考**；本版 ai-*3 **不**做自动迁移，老项目需要人工或 **skill-v3 仓库内 `migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs`**（亦可复制到业务仓自建脚本）执行后**删除**旧文件。列名 / 路径以 v2 实际安装目录 `~/.cursor/skills/<skill>/templates/` 内的模板与 SQL 迁移文件为准。

#### 9.3.1 文件级迁移

| v2 来源（路径 / 文件） | v2 关键字段 | v3 目标 | v3 字段路径 | 迁移建议 |
| --- | --- | --- | --- | --- |
| `src/<client_target>/deployment_plan.json` | `client_target` | `docs/config.dev.json` / `config.release.json` | `deploy.services[].client_target` | 每个 v2 端的 plan 拍平为 `deploy.services[]` 的一行 |
| 同上 | `recommended_platform` | 同上 | `deploy.provider` | v2 候选值映射到 v3 catalog id：`cloudflare→cloudflare`、`aws→aws`、`tencent→tencent_cloud`；**`oracle` 在 v3 `deploy-services.catalog.json` 中暂未收录**，迁移脚本应在此处停下并要求用户：(a) 改用 catalog 已有 provider，或 (b) 按 §9.1 additive 规则在 catalog 中追加 `oracle_cloud` 后再继续 |
| 同上 | `platform_candidates[]` | **丢弃** | — | v3 候选改由 `docs/templates/deploy-services.catalog.json` 统一提供，项目侧不再保留候选列表 |
| 同上 | `service_mapping.<role>.platform_product` | `docs/config.dev.json` | `deploy.services[].service_name` 与 `resource_type` | `<role>` 对应到 v3 service id（如 Pages→`pages`、Workers→`workers`、D1→`d1`、KV→无对档需自行评估、R2→`r2`、Queues→无对档、Durable Objects→无对档） |
| 同上 | `service_mapping.<role>.service_name` | 同上 | `deploy.services[].service_name` | 直接复制 |
| 同上 | `service_mapping.<role>.public_url` | `.pipeline/stages.json` | `stages.deploy.outputs.services[].url` | 仅在已部署且仍可用时迁移；否则置空待 deploy 重写 |
| 同上 | `service_mapping.<role>.create_params.*` | `docs/config.dev.json` | `deploy.services[].resource_config.*` | v2 各 `create_params` 字段（如 `pages_project_name`、`worker_name`、`account_id`、`routes[]`、`bucket_name`、`compatibility_date` 等）整体迁入 `resource_config`，键名不必改 |
| 同上 | `rationale[]` / `assumptions[]` / `risks[]` | **丢弃** | — | v3 的设计/风险描述归 design 阶段产物，不在 config 中保留 |
| 同上 | `review_notes` / `confirmed_by` / `confirmed_at` | **丢弃** | — | v3 把 deploy 审批语义合并到 `stages.deploy.validation` 与 `stages.contract.outputs.human_approval`；无需再迁 |
| 同上 | `_schema.version=2` | `_schema.version=1` | `docs/config.dev.json._schema.version` | v3 schema 是新起点；不要把 v2 版本号带进来 |
| `src/<client_target>/feature_list.json` | `project_name` / `client_target` / `id_prefix` | `docs/<端>/feature_list.md` | Metadata 表（`client_target` / `generated_by`） | 转为 Markdown，结构按 `docs/templates/feature_list.md.template` 重写 |
| 同上 | `pipeline_stages[]`（v2 取值如 `draft/approved/in_design/...deployed`） | `docs/<端>/feature_list.md` | Status Values 节 | 取值需**重新映射**：v3 取值固定为 `draft / reviewed / approved / blocked / deferred`；v2 中 `in_design/in_codegen/in_test/merged/deployed` 等"进度型"取值在 v3 由 `stages.<stage>.status` 表达，**不**再写入 feature 状态 |
| 同上 | `items[]`（feature 列表） | 同上 | Features 表 + Feature Details 节 | 字段按 v3 模板重写：v2 的自由 JSON → v3 的固定 Markdown 节（Acceptance Criteria / Design Input Notes / Review Notes 等） |
| 同上 | `area_dictionary` | `docs/<端>/feature_list.md` | Features 表的 `Area` 列 | 平铺到每行 |
| 同上 | `_schema.version=2` | `feature_list.md` schema_version=1 | Metadata.schema_version | 新起点 |
| `inventory.json`（ai-deploy2 init 产出，仓内位置不一） | `platform` | `docs/config.dev.json` | `deploy.provider` | v2 候选 `cloudflare/aws/oracle/tencent` → v3 catalog id（同上行；`oracle` 在 v3 catalog 中暂未收录，处理方式同上） |
| 同上 | `primary_domain` | 同上 | `deploy.services[].domain` | 各 service 共用时复制到对应行 |
| 同上 | `resources.app_name` / `resources.region` | 同上 | `deploy.project_or_account` / `deploy.region` | 名字不同需手工对齐 |
| 同上 | `targets[].name` / `kind` / `platform_product` / `service_name` / `src_dir` / `build_cmd` / `deploy_cmd` / `public_url` | `docs/config.dev.json` + `stages.json` | `deploy.services[]` 与 `build.client_targets.<target>.commands` | `build_cmd` 拆到 `build.commands.build`；`deploy_cmd` 拆到 `deploy.services[].resource_config.deploy_command`；`public_url` 见上一行 |
| `scripts/config.env`（v2 路径） | 各云凭证 + `HTTP_PROXY` 等 | **`docs/config.env`**（v3 唯一路径） | 同名变量直接迁移 | v3 不再读 `scripts/config.env`（见 `docs/templates/config.env.template`）；迁移后**删除旧文件**。代理变量 v3 同样收纳在 `docs/config.env` |

#### 9.3.2 SQLite 状态表 → `stages.json` 字段映射

v2 各 `*_state` SQLite 表本质是「按 feature_id 一行一阶段状态」；v3 的 `.pipeline/stages.json` 改为「按阶段一段、内部含 feature 维度子结构」。下表给出列级映射，便于迁移脚本一次性提取：

| v2 表 / 列 | v3 字段路径（`.pipeline/stages.json`） | 备注 |
| --- | --- | --- |
| `review_state.review_status` (`pending/approved/modified/deferred`) | `stages.prd_review.outputs.decision` | 取值映射：`approved→passed` / `modified→conditional_passed` / `deferred→failed`（按业务实际） |
| `review_state.suggested_changes` (JSON 文本) | `stages.prd_review.review.suggested_prd_spec_changes[]` | 拆 v2 JSON 的 `scope_change/api_adjustments[]/data_model_adjustments[]/acceptance_criteria_additions[]/constraints[]/dependency_notes` → 对应 v3 数组项 |
| `review_state.phase` (1/2/3) | `stages.prd_review.review.phase_plan[*].phase` | v2 的整数转 v3 的 `mvp/standard/complete` 字符串 |
| `design_state.status` (`pending/running/draft/approved/rejected/skipped`) | `stages.design.status` + `stages.design.outputs.design_specs[].status` | `approved→completed`，其它对应主状态枚举 |
| `design_state.artifact` (JSON 文本) | `stages.design.outputs.design_specs[]` | v2 自由 JSON → v3 数组项；缺字段按 v3 schema 补默认 |
| `contract_state.status` | `stages.contract.status` + 子字段 | `approved→completed` 且需置 `outputs.human_approval.status="approved"`；`check_passed→validation.passed=true`；`check_failed→validation.passed=false` |
| `contract_state.has_types_ts` / `has_api_yaml` / `has_schema_sql` / `has_test_spec` | `stages.contract.outputs.artifacts[].{types/api/schema/test_spec}` | v2 是布尔，v3 改写为产物路径字符串；迁移时若仅有布尔，写入预期路径占位即可 |
| `contract_state.tsc_status` / `swagger_status` / `sql_lint_status` / `design_spec_status` | `stages.contract.validation.checks[].status`（按 `name` 取） | `pass→passed` / `fail→failed` / null→`pending` |
| `contract_state.tsc_errors` / `swagger_errors` / `sql_errors` / `design_spec_errors` | `stages.contract.validation.checks[].errors[]` | 直接迁数组 |
| `codegen_state.status` (`success/failed/skipped_existing/cancelled`) | `stages.codegen.outputs.impl_codegen_status` | `success→success` / `skipped_existing→skipped` / `cancelled→failed` |
| `codegen_state.test_codegen_status` | `stages.codegen.outputs.test_codegen_status` | 同名直接迁；`skipped_no_spec` 保留 |
| `codegen_state.branch` / `worktree_path` / `commit` / `files_expected` / `files_changed` / `test_files_expected` / `test_files_changed` | `stages.codegen.outputs.worktrees[].{branch/worktree_path/commit/files_expected/files_changed/test_files_expected/test_files_changed}` | 一行表对应 worktrees[] 中一个元素，索引按 feature_id |
| `codegen_state.model` | `stages.codegen.outputs.agent.model` | v2 单行模型名；v3 写入 **agent** 块；跳过 Agent 或无记录时 **`mode=none`** / **`model` 空** |
| `typecheck_state.status` | `stages.typecheck.status` + `outputs.tools[].status` | `passed→passed` 等 |
| `typecheck_state.tsc_exit_code` / `tsc_errors` | `stages.typecheck.outputs.tools[name=tsc].{exit_code, errors[]}` | — |
| `typecheck_state.lint_exit_code` / `lint_errors` / `lint_warnings` | `stages.typecheck.outputs.tools[name=eslint].{exit_code, errors[]}` | `lint_warnings` 计数可丢，或写入 v3 的 `summary` |
| `test_state.test_status` | `stages.test.outputs.result` | 取值在 v2 与 v3 大多同名（`passed/failed_max_attempts/failed_repeated_same_error/failed_contract_issue/skipped_no_test_cmd`），`cancelled→failed` |
| `test_state.rollback_to` | `stages.test.rollback_to` | 取值同 |
| `test_state.attempts` / `last_error` / `bug_signature` | `stages.test.outputs.{attempts/failure_summary/bug_signature}` | `last_error→failure_summary` |
| `test_state.merge_*`（v2 由 ai-git2 写入 test_state） | `stages.merge_push.outputs.{merge_status/target_branch/merge_commit/error}` | v3 把 merge/push 拆出 test_state 独立成 stage |
| `review_code_state.status` | `stages.code_review.outputs.decision` | `passed→passed` / `failed→failed` / `skipped→` 主状态 `skipped` |
| `review_code_state.critical_issues` / `warnings` | `stages.code_review.outputs.{critical_issues, warnings}` | 直接迁 |
| `review_code_state.checklist`（JSON） | `stages.code_review.outputs.checklist[]` | v2 自由 KV 改为 v3 数组项（`{key, passed, violations[]}`） |
| `deploy_state.status` / `platform` / `url` / `error` / `skip_reason` | `stages.deploy.outputs.services[].{status, ...}` + `stages.deploy.outputs.{provider, deploy_url, error}` | v2 单端单行 → v3 多端多 service；`platform` 同样按 v2→v3 catalog id 映射 |
| `release_state.*` | `stages.deploy.outputs.release_meta.{version, tag_name, gh_release_url, notes, released_at, error}` | v3 不为 release 单立 stage（见 §4.1）；release 元数据合入 deploy 子字段 |
| `smoke_state.status` / `total_checks` / `passed_checks` | `stages.smoke.status` + `outputs.checks[]`（按 `passed` 重新计数） | v3 不存预聚合计数，由 `outputs.checks[].passed` 统计 |
| `smoke_state.check_results` (JSON) | `stages.smoke.outputs.checks[]` | 字段按 `{name, method, path, expected_status, actual_status, passed, latency_ms, error}` 重组 |
| `smoke_state.failed_paths` / `skip_reason` | `stages.smoke.outputs.{failed_paths, skip_reason}` | 直接迁 |
| 所有 `*_state.created_at` / `updated_at` / `*_at` 时间戳 | `stages.<stage>.{started_at, completed_at}` | v2 的 `created_at` 接近 `started_at`，`updated_at` 视情况映射；`<verb>_at` 字段（如 `approved_at`、`reviewed_at`）合并入 `completed_at` 或写入对应子字段 |
| 所有 `*_state.id` (TEXT PK) | **丢弃** | v3 不再用「state 行 id」；feature_id 已能唯一定位 |
| 所有 `*_state.feature_id` | **`stages.<stage>.features[].feature_id`**（首选）或 `stages.<stage>.review.phase_plan[*].feature_ids[]` / 产物数组（`design_specs` / `artifacts` / `worktrees`） | v3 以 **`features[]`** 为 feature×stage 可查询真源；旧 `outputs.per_feature[]` 读路径兼容、写路径废弃 |

#### 9.3.3 凭证与代理迁移（密钥红线）

| v2 路径 | v3 路径 | 必须执行 |
| --- | --- | --- |
| `scripts/config.env`（v2 同时承担凭证 + 代理） | `docs/config.env` | 整体复制；变量名保持不变；新版同样支持 `HTTP_PROXY` / `HTTPS_PROXY` / `CLOUDFLARE_API_TOKEN` 等 |
| 任意 v2 JSON 文件中误存的密钥 | **不**迁入 v3 JSON | 迁移脚本必须先按 `docs/templates/config.dev.json.template.security.forbidden_json_key_patterns` 扫描，命中即写入 `docs/config.env` 并从 JSON 中删除 |

#### 9.3.4 迁移操作建议（脚本骨架式说明）

**`migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs`**（skill-v3 仓内 **Cursor skill** 参考实现）建议按下列顺序执行：

1. **盘点**：扫描业务仓内所有 v2 产物路径（`src/*/deployment_plan.json`、`src/*/feature_list.json`、`inventory.json`、`scripts/config.env`、SQLite 路径）。
2. **生成 v3 骨架**：从 `docs/templates/` 拷贝 4 份模板到 `docs/`、`.pipeline/`，已存在则跳过。
3. **逐文件迁移**：按 §9.3.1 表执行字段映射，写入 v3 文件；写入前先做 §9.3.3 的密钥扫描。
4. **逐表迁移**：按 §9.3.2 表把 SQLite 各 `*_state` 行读出 → 写入 `.pipeline/stages.json` 对应位置；保留时间戳就近映射。
5. **校验**：对生成的 `.pipeline/stages.json` / `docs/config.dev.json` / `docs/config.release.json` 跑 v3 的 schema 校验（v0 契约）；不通过则**回滚整次迁移**，给出失败原因。
6. **删除旧文件**：校验通过后，**显式提示**用户后再删除 `src/*/deployment_plan.json`、`src/*/feature_list.json`、`inventory.json`、`scripts/config.env`、v2 SQLite 表；脚本不擅自删除。
7. **登记**：调用 ai-auto3 的"DB 自动对齐"流程（见 §4.3.1#6），把新 `stages.json` 导入 skill 目录 DB。

> **强烈建议**：迁移脚本必须支持 `--dry-run`，列出"会写哪些文件、改哪些字段、删哪些文件"后再要求用户确认；**默认 dry-run**，需要 `--commit` 才真正落盘。

---

## 十、名词表

下列名词在本文中频繁出现，统一定义如下，避免歧义：

| 名词 | 含义 |
| --- | --- |
| **client_target** | 项目中的"端"，取值固定在 `website / admin / backend / mobile / desktop / miniapp / agent`，与 `stages.json.template.client_targets.allowed_values` 对齐。 |
| **sub_platform** | 端内部的子平台，例如 `mobile = ios / android`、`miniapp = weixin / alipay / douyin`、`desktop = electron / tauri`。在 `docs/config.dev.json` / `config.release.json` 的 `build.client_targets.<target>.sub_platforms[]` 中显式声明，并在 `stages.build.outputs.artifacts[].sub_platform` 中体现。 |
| **worktree** | 由 codegen 阶段为每个 feature 创建的隔离工作区（默认 **`<project_root>/.pipeline/worktrees/`** 下的 **git worktree**，见 **`docs/spec/code3.md` §7.7**；可被等价机制替代），路径写入 `stages.codegen.outputs.worktrees[].worktree_path`（**绝对路径**）。 |
| **diff-guard** | 在 codegen 与修复循环中阻止改动契约文件的机制；触发后以退出码 5 阻断。 |
| **x-smoke** | OpenAPI/`api.yaml` 中的扩展属性，标记某端点可在 smoke 阶段安全调用（默认 GET/HEAD，或显式声明 `safe_post: true`）。 |
| **session_id** | 单次 Agent / 编排会话的唯一 ID；日志路径 `.agent-sessions/logs/sessions/<session_id>.log`；锁内容仍写在 `.agent-sessions/locks/`。 |
| **PID 锁** | 同 scope 下防并发的轻量锁，路径与命名见 §6。 |
| **conditional_passed** | prd-review 决议的"带条件通过"，必须在所有 `stages.prd_review.conditions` 解除后改写为 `passed`，方可放行 design。 |
| **blocking_issues** | 任一阶段中阻断后续推进的关键缺陷列表；`length === 0` 是大多数阶段完成的必要条件。 |
| **artifact_path** | 由 build 阶段产出、可供 deploy 直接消费的产物路径（目录或文件），由 `stages.build.outputs.artifacts[].artifact_path` 给出。 |
| **provider / service** | 部署时的云厂商（`provider`，如 `aws / cloudflare / vercel / alibaba_cloud` 等）与具体云服务（`service`，如 `lambda / pages / scf / fc` 等），候选目录在 `docs/templates/deploy-services.catalog.json`。 |
| **dev / release** | 部署环境的两个固定取值；本版不再使用 `prod`、`production`、`staging` 等替换词。 |
| **cjs 脚本** | 本版统一使用的 CommonJS 实现脚本（文件名以 `.cjs` 结尾），承担确定性流程；归属规则见 §3.3。 |
| **`autorun.cjs`** | ai-auto3 的物理实现，位于该 skill 目录下的 `scripts/autorun.cjs`，仅串联各阶段 ai-*3 子流程并管理 PID 锁、退出码、超时；不写各阶段业务字段，不替子 skill 写日志。 |
| **`gen-report.cjs`** | 单一职责的 report 生成器，由 `autorun.cjs` 在序列末尾调用，读取 `.pipeline/stages.json` 与日志索引输出汇总报告。 |
| **三层超时** | 总超时（`autorun.cjs`）⊃ 阶段超时（单 skill）⊃ 子命令超时；触发后统一映射为退出码 3，并写回 `stages.<stage>.outputs.timed_out` / `duration_ms`，详见 §6.1。 |
| **`duration_ms` / `timed_out`** | 每个阶段无论成败都应写入的可观测性字段；由各 ai-*3 自行写入，autorun.cjs 不代写。 |

（角色分工、和外部系统的边界等可在后续讨论中追加。）
