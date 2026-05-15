# 第三代发布与冒烟规格（Publish3）

## 0. 文档角色与维护约定（**SSOT**）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 实现 **`ai-publish-dev3`** 与 **`ai-publish-release3`** 的 **`SKILL.md`**、**`scripts/**/*.cjs`** 及随 skill 分发的 provider 适配逻辑时，**以本文为规范来源**（门闸、脚本拆分、退出码、`stages.json` 写回边界、release 子步骤）。不依赖口头约定。 |
| **双 skill 定稿** | 第三代发布能力**固定**为两个独立 Cursor skill 目录：**`ai-publish-dev3`**（dev 环境 deploy + smoke）与 **`ai-publish-release3`**（release 环境 deploy + smoke + **release** 类内部子步骤）。**不**采用「单一 `ai-publish3` + `--env`」合并方案，以免默认参数与触发语义模糊带来的误发风险。本文档 **`publish3.md`** 仅为本族规格的**总文件名**，**不**对应第三个 skill 安装名。 |
| **与 `docs/templates/` 的关系** | **`stages.json`** 中 **`deploy` / `smoke`** 字段形状、**`config.dev.json` / `config.release.json`** 中 **`deploy` / `smoke` / `release`**（仅 release 配置）、**`config.dev.json.pipeline.autorun.allow_destructive_deploy`**（**ai-auto3** 调 dev deploy 专用）等，以对应 **`*.template`** 为真源。本文 **§6**（`stages.json` 写回）、**§7**（门闸）、**§5.1.1**（autorun deploy 键）列出须落实的子集；模板增删字段时，**同一维护周期**内同步更新本文与实现。 |
| **与 `docs/input-spec.md` 的关系** | 全流水线语义（退出码表、日志目录、PID 锁 scope、超时三层模型、`x-smoke` 形状、**destructive** 阶段二次确认、`ai-auto3` 默认终点等）以 **`input-spec.md`** 为准；本文**摘录 publish 族直接依赖的硬约束**并落到可执行规划。若冲突，收束顺序：**先改 `input-spec` + 模板 → 再改本文 → 再改 skill**。 |
| **`inputs.summary_hash`** | 与 `input-spec.md` §4.4 一致：deploy / smoke 在写回 `stages.json` 时应 **additive** 维护 `stages.deploy.inputs.summary_hash`、`stages.smoke.inputs.summary_hash`（若模板尚未展示该键，不因此单独升 `_schema.version`，见 `input-spec.md` §9.1）。哈希输入边界见 **§6.3**。 |
| **与上一版（v2）的关系** | **不得**读取 `src/<client_target>/deployment_plan.json`、`inventory.json`、业务仓 `scripts/config.env`、v2 SQLite `deploy_state` / `smoke_state` / `release_state` 作为默认门闸；迁移见 `input-spec.md` §9.3。v2 的 **init / inventory** 交互可作为 **UX 参考**，由本族 skill 的 **可选子命令** 实现。 |

**维护流程（需求变更时）**：

1. 在本文修改门闸、脚本职责、退出码或验收清单。  
2. 若涉及 `stages.json` / `config.*.json` 形状，同步 **`docs/templates/`** 与（必要时）**`docs/input-spec.md`**。  
3. 再改 **`ai-publish-dev3` / `ai-publish-release3`** 实现与自测（**§11**）。

---

## 1. 文档目的、读者与自身完整性

| 项目 | 说明 |
| --- | --- |
| **目的** | 作为创建 **`ai-publish-dev3`** 与 **`ai-publish-release3`** 两个 Cursor Agent Skill 及其 **`scripts/*.cjs`** 的**详细规划与实施指引**：从目录布局、CLI 入口、前置门闸、云 CLI 调度边界，到 **`stages.json` 写回字段**与 **退出码映射**。 |
| **读者** | 实现与 review publish 族 skill 的工程师或 Agent；编排侧（**`ai-auto3` / `autorun.cjs`**）核对「何时调用 dev publish、为何不默认调 release」时的对照文档。 |
| **自身完整性** | 未读 `input-spec.md` 的读者仍可从本文 **§2–§9** 完成 MVP 实现；**§12** 为与全仓其它文档的交叉索引；**§11** 为验收清单；**§10** 为日志、PID 锁与可观测性。全文自成闭环，不依赖外部口头约定。 |
| **非目标** | 不在本文内穷尽所有云厂商 API 细节；provider 适配以 **`docs/templates/deploy-services.catalog.json`** 为候选集，具体 CLI/SDK 版本在实现仓库的 README 或各 `provider/*.cjs` 中维护。 |

---

## 2. 定位与阶段覆盖

### 2.1 与流水线其它 skill 的分工

| Skill | 覆盖阶段（`input-spec.md` §4.2） | 使用的项目配置 |
| --- | --- | --- |
| **ai-publish-dev3** | **`deploy`**（环境 **`dev`**）、**`smoke`** | **`docs/config.dev.json`** + **`docs/config.env`** |
| **ai-publish-release3** | **`deploy`**（环境 **`release`**）、**`smoke`**；以及 **release** 类内部子步骤（版本、变更日志、打标、托管发布资产等，**非**独立 `stages` 键） | **`docs/config.release.json`** + **`docs/config.env`** |

**不包含**：`report`（由 **`ai-auto3`** 末尾调用 **`gen-report.cjs`** 承担）；`build`（由 **`ai-code3`** 承担，但 publish 族**强依赖**其产物）。

### 2.2 上游与下游

| 方向 | 关系 |
| --- | --- |
| **上游** | **`ai-code3`** 须已完成 **`merge-push`** 与（按端需要的）**`build`**：`stages.build.outputs.artifacts[]` 与 `docs/config.*.json` 中 deploy 映射一致。冒烟检查来自契约 **`x-smoke`** 与/或 **`config.*.json.smoke.checks[]`**；二者皆无时 **smoke** 按 **§7.2** 记 **skipped**（除非调用方带 **`--require-smoke`**，见 §7.2）。 |
| **下游** | **dev**：完成后进入 **`ai-auto3`** 默认序列的收尾（若由 autorun 调用）或人工验收；**release**：完成后由人工或发布编排消费 **`stages.deploy.outputs.release_meta`**（字段名以模板演进为准，见 §5.3）。 |

### 2.3 与 `ai-auto3` 的衔接

- **`input-spec.md` §4.3**：默认自动序列在 **dev** 路径上包含 **`ai-publish-dev3`**（deploy + smoke），**不包含** **`ai-publish-release3`**。  
- **`ai-auto3` / `autorun.cjs`** **不得**代写 `stages.deploy` / `stages.smoke` 的业务字段；仅负责子进程退出码、超时与停跑策略。

### 2.4 与上一版（v2）的对应（经验参考，无兼容承诺）

| 本版 | 上一版（`~/.cursor/skills/`） |
| --- | --- |
| **ai-publish-dev3** | **ai-deploy2**（dev）+ **ai-smoke2**（dev） |
| **ai-publish-release3** | **ai-deploy2**（release）+ **ai-smoke2**（release）+ 常见 **release** 子流程 |

v3 **不再**生成或读取各端 **`deployment_plan.json`**；资源级约定在 **`docs/config.dev.json` / `config.release.json`**。

---

## 3. 架构原则（对齐 `input-spec.md` §3.3）

1. **脚本只驻留在 skill 目录**：`<cursor_skills_root>/ai-publish-dev3/scripts/*.cjs` 与 `<cursor_skills_root>/ai-publish-release3/scripts/*.cjs` 两套各自维护，**不**复制到业务项目。两棵树允许共用同名 **`lib/*.cjs`** 逻辑，**以复制或内部子模块同步为准**（不在业务仓维护第三份）。  
2. **调用方式**：`node <skill_dir>/scripts/<name>.cjs --project=<业务项目根绝对路径> [子命令|选项]`；**禁止**以 `process.cwd()` 作为项目根的唯一真源。  
3. **确定性进脚本**：schema 校验、读写 **`.pipeline/stages.json`**、加载 **`docs/config.env`**（仅通过环境变量注入子进程，**禁止**把密钥值写回 JSON 或日志正文）、子进程/超时、云 CLI 组合、HTTP 冒烟请求、PID 锁、退出码映射。  
4. **创造性进 LLM（按需）**：解释云厂商报错、归纳失败摘要、生成给人看的「下一步建议」**可**由 LLM 辅助；**禁止**让 LLM 假装已完成部署或冒烟。  
5. **CommonJS**：统一 **`.cjs`**，与其它 **ai-*3** 一致。  
6. **build 与 deploy 分离**：**不在 deploy 脚本内隐式全量重跑 build**（与 `input-spec.md` §8 阶段 11/12 一致）；若缺产物，退出码 **1** 并指明缺哪一项 `artifact_path`。

---

## 4. Skill 目录与入口规划

### 4.1 目录结构（两个 skill 各一份，定稿）

```text
ai-publish-dev3/
├── SKILL.md
├── prompts/                        # 可选：失败说明、release notes 草稿
│   └── ...
├── templates/                      # 可选：与 skill-v3 仓 docs/templates 对齐的拷贝，便于离线分发
└── scripts/
    ├── run.cjs                     # 聚合入口：preflight → deploy → smoke
    ├── preflight.cjs
    ├── deploy.cjs
    ├── smoke.cjs
    ├── init.cjs                    # 可选：对齐 v2 inventory/init 体验
    └── lib/
        ├── paths.cjs
        ├── stages-io.cjs
        ├── config-load.cjs         # 读 dev/release JSON + 校验 _schema + forbidden 键扫描
        ├── secret-env.cjs          # 读 docs/config.env，仅导出到子进程 env
        ├── run-with-timeout.cjs
        ├── http-smoke.cjs          # GET/HEAD + 安全 POST 边界
        └── providers/              # 按 deploy.provider 分派
            ├── manual.cjs
            ├── cloudflare.cjs
            └── ...
```

**`ai-publish-release3/`** 与上表为**并列**的另一目录；相对 dev 的增量见 **§4.4**。

### 4.2 `SKILL.md` 应写清的内容（轻薄但可执行）

- 触发词（示例）：「ai-publish-dev3」「dev 部署」「冒烟」「正式发布」「ai-publish-release3」。  
- **必读/必写文件路径表**（`docs/config.*.json`、`docs/config.env`、`.pipeline/stages.json`、契约 `api.yaml`）。  
- **CLI 一览**（与 §4.3 一致）及**退出码表**（§9）。  
- **destructive**：**`deploy` 在 dev / release 下均为 destructive**（`input-spec.md` §7.2 重跑矩阵）；**手工**触发 deploy 须有 **explicit confirm**；**`ai-auto3`** 调用 dev deploy 时，除 **`deploy.enabled`** 等业务开关外，还须 **`docs/config.dev.json.pipeline.autorun.allow_destructive_deploy === true`**（**§5.1.1**），否则 **autorun** 不得 spawn deploy、**退出码 1**。**release** 另须遵守 **§5.2**（`approval_required`、`--confirm-deploy` / explicit confirm 的组合门闸，含 `approval_required===false` 时仍不得零确认部署）。  
- **与 `ai-auto3` 的关系**：dev skill 可被 autorun 调用；release skill **默认不**被 autorun 调用。

### 4.3 建议 CLI 形态

| 脚本 | 职责 |
| --- | --- |
| **`run.cjs`** | 解析 `--project`、`--from-stage=deploy|smoke`、`--force-rerun`、`--dry-run`、`--session-id` 等；串联子步骤；统一退出码；写会话日志指针。**`--confirm-deploy`** 仅由 **`ai-publish-release3`** 的 `run.cjs` 解析（见 §5.2），**dev skill 不得接受该开关作为「默认可上生产」的旁路**。 |
| **`preflight.cjs`** | 校验项目根、**对应环境**的 `config.*.json`、**`config.env` 变量名/值**（规则见 §5）、**`stages.json`** 中上游 **build / merge_push** 门闸；校验 **security.forbidden_json_key_patterns**；失败 **1**。 |
| **`deploy.cjs`** | **dev skill** 仅申请 **`deploy-dev`** PID 锁；**release skill** 仅申请 **`deploy-release`**（§10.2）。按 provider 调度；回写 **`stages.deploy`**；云 API 失败 **8**；凭证缺失 **1**、凭证被拒 **8**（`input-spec.md` §5）。 |
| **`smoke.cjs`** | 申请 **`smoke`** 锁（可与 deploy 同会话串行持有，释放 deploy 后再 smoke，避免双写；或单锁策略在实现中二选一并文档化）；回写 **`stages.smoke`**；检查失败 **4**。 |
| **`init.cjs`**（可选） | 辅助生成/校验 **`config.*.json`** 的 `deploy.services[]` 骨架；**不**写密钥；**不**替代 **ai-prd3** 的配置初始化职责。 |
| **`release.cjs`**（仅 release skill） | 读取 **`config.release.json.release`**；打标、上传资产；回写 **`stages.deploy.outputs.release_meta`**（及关联校验字段）；失败语义见 §5.3。 |
| **`lib/stages-io.cjs`** | 原子写回、`_schema.version`、缺失字段 **additive** 默认补齐。 |
| **`lib/run-with-timeout.cjs`** | 默认超时：`timeouts.stages.deploy_s` / **`smoke_s`**（`input-spec.md` §6.1）；超时映射退出码 **3**，并写 **`timed_out` / `timeout_reason` / `duration_ms`**。 |

**MVP**：每个 skill 内可先 **`run.cjs` 内联** deploy+smoke，稳定后再拆文件；但 **`SKILL.md`** 应承诺目标拆分，避免长期单文件不可维护。

### 4.4 `ai-publish-release3` 相对 dev 的增量（定稿）

**`ai-publish-release3/`** 在 **§4.1** 相同骨架上**必须**额外具备：

- **`release.cjs`**（或 `run.cjs` 内与之等价的固定子序列）：版本解析、changelog、git tag、`gh release`、资产上传等，由 **`config.release.json.release`*** 驱动；步骤顺序见 **§5.3.1**。  
- **`run.cjs` / `preflight.cjs`**：校验 **`config.release.json.deploy.approval_required`**、**`release.enabled`**，且未带 **`--confirm-deploy`**（或等价显式确认）时**不得**改线上资源（§5.2）。  
- **`SKILL.md`**：单独的 **确认/审批** 与 **误发风险提示**；**不得**复用 dev skill 文案暗示「同一入口可上 release」。

---

## 5. 配置、密钥与 release 子步骤

### 5.1 配置文件分工

| 文件 | dev skill | release skill |
| --- | --- | --- |
| **`docs/config.dev.json`** | **读取** | 不用于部署决策 |
| **`docs/config.release.json`** | 不用于部署决策 | **读取** |
| **`docs/config.env`** | **读取**（密钥） | **读取**（密钥） |

- **`deploy.enabled`**：若为 `false`，deploy 子步骤应 **skipped** 或 **blocked**（二选一做项目内一致约定，推荐：**skipped** 并写 `skip_reason`，且 **不**将整 skill 标为成功若用户显式要求部署——即 **显式 `--require-deploy`** 时 `enabled=false` → 退出 **1**）。  
- **`smoke.enabled`**：若为 `false`，smoke 可跳过并记录原因；**autorun 默认序列**若要求冒烟，以 **`input-spec.md` §4.3** 与项目策略为准（建议在 dev 配置默认 **`smoke.enabled=true`**）。

### 5.1.1 **`pipeline.autorun.allow_destructive_deploy`**（仅 `docs/config.dev.json`）

| 项 | 约定 |
| --- | --- |
| **JSON 路径** | **`pipeline.autorun.allow_destructive_deploy`**（布尔） |
| **模板默认** | **`false`**（见 **`docs/templates/config.dev.json.template`**） |
| **老项目缺键** | 按 **`input-spec.md` §9.1** additive 视为 **`false`**（**ai-auto3** / 校验脚本应写回默认块，**不**静默当成 **true**） |
| **语义** | 仅授权 **`ai-auto3` / `autorun.cjs`** 在自动序列中 **spawn `ai-publish-dev3` 执行 dev `deploy`**（及随后依赖 deploy 成功路径的 **`smoke`**，仍以 **`smoke.enabled`** 等为准）。**不**授权 **release** deploy；**不**替代手工触发的 **explicit confirm**（手工仍须 **SKILL** 所述确认流）。 |
| **与 `deploy.enabled` 的关系** | **`deploy.enabled === true`** 且 **`allow_destructive_deploy !== true`** → **autorun** **不得**执行 dev deploy → **退出码 1**，并在 **report** 说明「缺少 `pipeline.autorun.allow_destructive_deploy`」或等价文案。**`deploy.enabled === false`** 时：不执行 deploy，本键**不**作为失败条件（无 deploy 则无 destructive 自动执行）。**注意**：本门闸在 **autorun 即将 spawn dev deploy 时**判定；**不**要求 **ai-auto3** 在开跑前（如尚处 **design** 段）即因 **`deploy.enabled=true` 且本键为 false** 而失败——允许「配置里打算部署、本轮自动编排只跑到 **build**」等用法。 |
| **禁止** | 不得以 **`deploy.enabled === true`** 单独视为已满足 **autorun** 下的 **destructive** 二次授权（与 **`input-spec.md` §7.2**、**`docs/spec/auto3.md` §6.3** 一致）。 |

### 5.2 release 环境与二次确认

- **`deploy`（dev 与 release）**：均属 **`input-spec.md` §7.2** 所列 **destructive**。**`ai-publish-dev3`** 的 `SKILL.md` 须写明：手工执行 deploy 前须 **explicit confirm**；被 **`ai-auto3`** 调用执行 dev deploy 时，须 **`pipeline.autorun.allow_destructive_deploy === true`**（**§5.1.1**），否则 **autorun** **退出 1**、不得 spawn deploy。  
- **`config.release.json.deploy.approval_required`**（模板字段）：为 `true` 时，**`ai-publish-release3`** 必须在 CLI 或交互中得到 **`--confirm-deploy`**（或等价机制，须在 `SKILL.md` 写明）才允许改 **release** 环境资源；缺失 → 退出 **1**。  
- **`approval_required` 为 `false` 时**：仍**不得**默认无确认地执行 release deploy（**destructive**）；须至少有 **一次 explicit confirm**（可与 **`--confirm-deploy`** 复用为同一门闸，由实现决定，但须在 **`SKILL.md`** 写死行为）。  
- **`ai-auto3` 默认不调用 release skill**（`input-spec.md` §4.3），降低误发风险；release 的 destructive 确认**不得**依赖 autorun 隐式通过。

### 5.3 release 内部子步骤与 `stages.json` 回写

依据 **`input-spec.md` §4.1 / §4.2 / §7`**：

- **release 不是独立 stage**；版本号、变更日志、打标、托管发布资产上传等由 **`ai-publish-release3` 内部**完成。  
- **结果**回写到 **`stages.deploy.outputs.release_meta`**（或等价命名；若当前 **`stages.json.template` 尚未含该对象**，按 **§0 additive** 规则由 release skill **additive** 写入，并在下一模板版本追平）。

建议在实现中 **`release_meta` 至少包含**：`version`、`tag_name`、`changelog_path`、`gh_release_url`（可空）、`notes`、`released_at`、`error`（可空），与 **`input-spec.md` §9.3.2** 迁移表语义对齐，便于后续模板正式化。

### 5.3.1 `release` 子步骤推荐顺序（可配置）

默认推荐顺序（**实现可调整，须在 SKILL 写明**）：

1. **preflight**（含 git 干净度、分支策略、`release.enabled`）。  
2. **version**：`version_source: manual | package_json | git_tag` 等（字段以 `config.release.json.template` 为准）。  
3. **changelog / notes**：从 `changelog_path` 截取或生成草稿。  
4. **build（release 配置）**：若发布需要 release 产物，**复用 `ai-code3` 的 build 语义**但使用 **`config.release.json`** 的 `build.*`；可在 **`run.cjs`** 中可选调用「仅 build」钩子或要求上游已完成（推荐后者以降低 skill 耦合）。  
5. **deploy（release）**。  
6. **smoke（release base_url）**。  
7. **git tag + 远程推送 tag**（若 `create_git_tag`）。  
8. **publish_assets**（若启用，如 `gh release create` 上传 zip）。

---

## 6. `stages.json` 读写契约

### 6.1 键名与阶段状态

- JSON 键：**`deploy`**、**`smoke`**（下划线规则与全局一致）。  
- **`stages.deploy.environment`**：dev skill 写 **`dev`**；release skill 写 **`release`**。  
- **`stages.deploy.inputs.config`**：dev 为 **`docs/config.dev.json`**；release 为 **`docs/config.release.json`**（与 `stages.json.template` 中示例对齐时可调整，但须 **SKILL 内固定**并与模板一致）。  
- **`stages.deploy.inputs.artifacts`**：`stages.json.template` 已含 **`inputs.artifacts`** 数组；运行时应填入本次 deploy 所消费的 **`stages.build.outputs.artifacts[]` 引用**（路径或 `(client_target, sub_platform)` 指针），供审计与 **`inputs.summary_hash`**；若确无产物型服务，保持 **[]** 并在日志 **`skip_reason`** 或校验摘要中说明。  
- **状态枚举**：`status`、`validation.passed`、`outputs.services[].status`、`outputs.checks[].passed` 等以 **`docs/templates/stages.json.template`** 为准。

### 6.2 完成判定与「已完成则跳过」

与 **`input-spec.md` §4.4** 一致，**deploy** 与 **smoke** 各自独立判定：

1. **`status === "completed"`**  
2. **`validation.passed === true`**  
3. **`inputs.summary_hash`** 与上游一致（§6.3）

**跳过**：若已满足且未传 **`--force-rerun`**`，打印「本阶段已完成」并跳过对应子步骤。

### 6.3 `inputs.summary_hash` 建议输入面

| 阶段 | 建议纳入哈希的稳定输入（实现时取实际文件内容或规范化 JSON） |
| --- | --- |
| **deploy** | 对应 **`config.{dev|release}.json`** 中与 deploy 相关的子树；**`stages.build.outputs.artifacts[]`** 中本次涉及行的 `client_target` / `sub_platform` / `artifact_path` / `status`；相关契约 **`api.yaml`** 路径列表（可选，若 deploy 不读契约可省略但须在 SKILL 声明）。 |
| **smoke** | **`smoke.checks[]`** + 解析得到的 **`x-smoke`** 列表的规范化表示；**`stages.deploy.outputs.deploy_url`** 或各 **`services[].url`**；**`smoke.base_url`**。 |

---

## 7. 前置门闸（deploy / smoke）

### 7.1 deploy 前置

1. **`stages.merge_push`**：`status=completed` 且 `validation.passed=true`（或项目约定允许 `skipped` 的极少数场景，须文档化）。  
2. **build**：凡 **`config.*.json.deploy.services[]`** 声明需要产物的 **`client_target`（+ `sub_platform`）**，须在 **`stages.build.outputs.artifacts[]`** 中存在 **`status=success`** 且 **`artifact_path`** 非空。纯后端可 **N/A** 的路径须与 **ai-code3** 约定一致。  
3. **产物映射**（`input-spec.md` §8 阶段 12）：按 **`(client_target, sub_platform)`** 匹配 artifact；若存在 **`deploy.services[].artifact_ref`**（实现与模板 additive 引入时），**以其为优先**。**一对一**：每个 service **必须**唯一匹配到一个 artifact，否则退出 **1**。  
4. **配置**：`deploy.provider`、`deploy.services[]` 必填字段齐全；**`config.env`** 中 provider 所需变量**名**均存在；若 **`deploy.enabled=true`**，则对应密钥**值**非空。  
5. **密钥隔离**：JSON 静态扫描 **`security.forbidden_json_key_patterns`**，命中 → **1**。

### 7.2 smoke 前置

1. **`stages.deploy`**：已完成且 **`validation.passed=true`**；**base URL** 可解析（来自 deploy 输出或 `smoke.base_url`）。  
2. **检查来源**（`input-spec.md` §8 阶段 13）：  
   - 优先从契约 **`api.yaml`** 收集带 **`x-smoke`** 的路径；  
   - 与 **`config.*.json.smoke.checks[]`** 合并；  
   - 两者皆空 → **skipped** 并写 **`skip_reason`**（非失败，但若 **`--require-smoke`** 则 **1**）。

### 7.3 安全边界（冒烟）

- 默认仅 **GET/HEAD**；非 GET/HEAD 须在 OpenAPI 扩展中显式声明可冒烟（**`input-spec.md` §8.13** YAML 示例为 **`safe: true`**；若仓库其它处出现 `safe_post` 等别名，以契约文件与 contract 阶段实际写入的字段为准，**smoke 实现须与契约一致**）。  
- **禁止**在 `stages.json` 或日志中保存完整鉴权头、密钥、完整响应体。

---

## 8. 与契约 `x-smoke` 的衔接

- **契约阶段**须在 OpenAPI 写入 **`x-smoke`**（**`ai-design3`** / contract 流程，见 **`docs/spec/design3.md`** 与 **`input-spec.md` §8.13**）。  
- **`smoke.cjs`** 应能：定位各端/各 service 对应的 **`api.yaml`** 路径（来源：`stages.contract.outputs.artifacts[]` 或约定目录）；解析 **`x-smoke`**；与配置 **`smoke.checks[]`** 合并去重。  
- **失败语义**：任一必需检查未通过 → **`stages.smoke.validation.passed=false`**，进程退出码 **4**（质量门，`input-spec.md` §5）。

---

## 9. 退出码（对外一致）

与 **`input-spec.md` §5** 一致；publish 族常用映射：

| 码 | 场景 |
| --- | --- |
| 0 | 成功（含允许的 **skipped** 且调用方未强制要求 deploy/smoke） |
| 1 | 缺文件/缺配置/schema/门闸/映射失败/未确认 **approval** / 密钥**缺失** |
| 2 | 用户取消 |
| 3 | 超时、子进程异常退出（可重试） |
| 4 | **smoke** 未通过 |
| 5 | 一般不用于 publish 族；若实现 **契约 diff-guard** 类检测可保留语义 |
| 6–7 | **一般不用于**纯 deploy/smoke；若内嵌 git tag 推送失败可用 **7** |
| 8 | **deploy** 阶段：**云 API / 托管 API** 失败；凭证**被拒**（401/403）（与 `input-spec.md` §5 一致：凭证缺失归 **1**，被拒归 **8**） |

**各 skill 内串联**：**`ai-publish-dev3`** 的 `run.cjs` 须在 stderr/日志中输出 **`failed_step=deploy|smoke`**；**`ai-publish-release3`** 还须包含 **`release`**，即 **`failed_step=deploy|smoke|release`**。

---

## 10. 日志、锁与可观测性

### 10.1 日志

- 会话日志：**`.agent-sessions/<session_id>.log`**；长日志：**`.agent-sessions/logs/*.log`**（`input-spec.md` §6）。  
- **心跳**：deploy / smoke 超过阈值时，**每 30s**（或 `timeouts.subcommand.heartbeat_interval_s`）写 **`alive:`** 行。

### 10.2 PID 锁（`input-spec.md` §6）

| Scope | 使用者 |
| --- | --- |
| **`deploy-dev`** | **ai-publish-dev3** |
| **`deploy-release`** | **ai-publish-release3** |
| **`smoke`** | 二者共用逻辑；**同一项目**建议 deploy 结束后再 smoke，避免并行双写 `stages.json` |

锁体 JSON：`{"pid","session_id","started_at","skill"}`。过期锁（PID 不存在）由脚本清理；活跃冲突 → **1**。

---

## 11. 验收清单（实现完成后对照）

- [ ] 仓库（或 skill 安装包）中存在**两个**独立目录 **`ai-publish-dev3`** 与 **`ai-publish-release3`**，**无**「单一 `ai-publish3` 兼管 dev/release」入口。  
- [ ] **`--project`** 缺失或非目录 → **1**。  
- [ ] **dev**：只读 **`config.dev.json`**；**release**：只读 **`config.release.json`**；密钥只来自 **`docs/config.env`**。  
- [ ] **forbidden** 键扫描失败 → **1**；密钥从未写入 **`stages.json`**。  
- [ ] **artifact 一对一映射**失败 → **1**。  
- [ ] **deploy** 成功：`stages.deploy.outputs.services[]` 含 **url**、**status**、**log_path** 等模板字段。  
- [ ] **smoke**：**GET/HEAD** 默认；**unsafe** 方法被默认拒绝。  
- [ ] **超时** 写 **`timed_out`/`timeout_reason`/`duration_ms`**，退出 **3**。  
- [ ] **release skill**：未满足 **§5.2**（含 **`approval_required` + `--confirm-deploy`** 及 **`approval_required===false` 时的 explicit confirm**）即尝试改 release 资源 → **1**；**`release_meta`** 在成功路径写回。  
- [ ] **`SKILL.md`** 与本文 **§4–§10** 一致（含 **dev deploy 的 destructive 确认** 与 **`pipeline.autorun.allow_destructive_deploy`**）；**与 `ai-auto3` 调用契约**（dev 可被调、release 默认不调）已写明。

---

## 12. 附录：与仓库其它文档的交叉索引

| 主题 | 文档与章节 |
| --- | --- |
| 阶段链与 skill 映射 | `docs/input-spec.md` §4.1–§4.2 |
| 统一退出码与超时 | `docs/input-spec.md` §5–§6.1 |
| deploy / smoke 阶段语义 | `docs/input-spec.md` §7 表、§8 阶段 12–13 |
| **destructive** 与重跑矩阵 | `docs/input-spec.md` §7.2 |
| **v2 → v3 迁移** | `docs/input-spec.md` §9.3（`deploy_state` / `smoke_state` / `release_state`） |
| **build 产物形态** | `docs/spec/code3.md` |
| **x-smoke 与契约** | `docs/spec/design3.md` |
| **ai-auto3 与 dev deploy 授权** | `docs/spec/auto3.md`、`docs/spec/publish3.md` §5.1.1、`docs/templates/config.dev.json.template` 中 **`pipeline.autorun.allow_destructive_deploy`** |

---

**文档版本**：与 **`docs/templates/*`** 的 **`_schema.version=1`** 同期；模板 breaking 变更时同步升本文档头版本说明（可在 §0 增加 **Rev** 表）。
