# ai-prd3 实现规格（Skill V3）

## 0. 文档角色与维护约定（**SSOT**）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 编写 **`ai-prd3/SKILL.md`** 与 **`ai-prd3/scripts/**/*.cjs`** 时，**以本文为唯一规范来源**。不依赖口头约定或散落 PR 描述。 |
| **与仓库其它文档的关系** | **`docs/input-spec.md`** 描述全流水线跨界语义（退出码分类、日志目录、ai-auto3 门闸等）。本文**已把与 prd / prd-review 直接相关的硬约束摘录进附录 A**；若未来 `input-spec` 与本文冲突，**以同一 PR 内同步修改为收束方式**：先改业务需求文字，再改本文，再改模板/实现。 |
| **与 `docs/templates/` 的关系** | **JSON / Markdown 字段形状**以对应 **`docs/templates/*.template`** 及 **`docs/templates/schemas/*.json`** 为准。本文 **§15** 列出 **`stages.json`** 中 ai-prd3 须读写的子集；**附录 A** 为 **`input-spec.md`** 摘录，**附录 B** 为 **`config.*.json`** 密钥/键名扫描规则，**附录 C** 为 **`SKILL.md`** 验收勾选项。模板增删字段时，**同一维护周期**内更新本文 §15、相关附录与脚本契约。 |
| **`inputs.summary_hash`（全局门闸）** | `input-spec.md` §4.4 要求各阶段维护 `stages.<stage>.inputs.summary_hash`。**`docs/templates/stages.json.template` v1 已在每个 `stages.*.inputs` 下提供 `summary_hash` 空字符串占位**；ai-prd3 在完成 **prd** / **prd-review** 时须按本文 **§9** 写入非空哈希。其它阶段由各 ai-*3 写入。 |

**维护流程（需求变更时）**：

1. 在本文修改行为/校验/门闸描述。  
2. 若涉及文件形状，同步 **`docs/templates/`** 与（必要时）**`docs/input-spec.md`**。  
3. 再改 **ai-prd3** 实现与测试用例（§12）。

---

## 1. 定位与读者

| 项目 | 说明 |
| --- | --- |
| **Skill 名称** | `ai-prd3` |
| **覆盖阶段** | `prd`、`prd-review`（对话与文档中用连字符 **`prd-review`**；写入 **`.pipeline/stages.json`** 时键名为 **`prd_review`**） |
| **不在本 skill 内** | `design` 及以后全部阶段（由 **ai-design3**、**ai-code3**、**ai-publish-***、**ai-auto3** 等承担） |
| **读者** | 实现 ai-prd3 的工程师、维护 `SKILL.md` 与脚本的成员、编排侧需核对门闸字段的开发者 |

---

## 2. 与上一版（v2）的关系（仅作心智模型，无兼容承诺）

| v3 | v2 对应 | 关键差异（实现时必须遵守） |
| --- | --- | --- |
| **ai-prd3** | `ai-prd2` + `ai-prd-review2` | 单 skill 内顺序完成 prd → prd-review；**不**读取 v2 的 `docs/<端>/feature_list.json`、**不**写各端 `deployment_plan.json`、**不**依赖 `.ai-pipeline/contracts.json` / SQLite `features` 作为门闸真源 |
| **总源头** | 各端 `prd.md` 为主 + 分散约定 | **唯一**总源头为 **`docs/inputs/prd-spec.md`** |
| **特性列表** | JSON + DB 双写 | **Markdown** **`docs/<端>/feature_list.md`**，结构以 **`docs/templates/feature_list.md.template`** 为 v0 契约；feature 行内状态枚举为 **`draft` / `reviewed` / `approved` / `blocked` / `deferred`**；**进度型 pipeline 状态**由 **`stages.json`** 表达，**不**写入 feature 行作为「在第几阶段」的替代 |
| **部署草案** | `deployment_plan.json` | 收敛到 **`docs/config.dev.json`** / **`docs/config.release.json`** + **`docs/config.env`**（占位） |

v2 的交互细节（如 `implementation_language`、`agent` 端运行时）可作为 **UX 参考**，映射进 **prd-spec 模板「## 7. 各端专属需求」下 `### agent` 小节**；**不得**把 v2 仓库路径或 v2 字段契约写进 v3 默认脚本路径。

---

## 3. 设计原则（对齐 `input-spec.md` §3.3）

1. **确定性进脚本**：schema 校验、文件读写、`stages.json` 合并写入、**`inputs.summary_hash`（§9）**、退出码、超时、子进程边界，一律在 **`*.cjs`** 中实现。  
2. **创造性进 LLM**：prd-spec 正文归纳、各端 `prd.md` 叙述、评审结论的自然语言摘要、缺口澄清，由 **`SKILL.md` 引用的 `prompts/*.md`** 驱动；**禁止**让 LLM「假装执行」脚本已承担的校验。  
3. **脚本不复制进业务仓**：所有 `*.cjs` 仅存在于 **`<cursor_skills_root>/ai-prd3/scripts/`**；调用时必须传入 **`--project=<业务项目根绝对路径>`**；脚本**不得**依赖 `process.cwd()` 推断项目根（除非仅用于日志相对路径解析且已用 `--project` 锚定根）。  
4. **`SKILL.md` 保持轻薄**：触发词、I/O 路径表、调用图、退出码、与 **ai-design3** / **ai-auto3** 的衔接话术；算法与 checklist 放在脚本或本文。  
5. **Skill 根路径**：文中 `<skill_dir>` 与 **`input-spec.md` §3** 的 skill 安装目录一致时，通常等价于 **`~/.cursor/skills/ai-prd3/`**（与 `<cursor_skills_root>/ai-prd3/` 同义）。  
6. **模块格式**：Node **CommonJS**（`.cjs`），建议统一入口：  
   `node <skill_dir>/scripts/run.cjs <子命令> --project=<root> [选项]`  
   子命令表见 **§4.2**。

---

## 4. Skill 目录与入口命令

### 4.1 目录结构

```text
ai-prd3/
├── SKILL.md
├── prompts/
│   ├── prd-spec-author.md
│   ├── derive-per-target.md
│   └── prd-review.md
├── templates/                    # 发布时与 skill-v3 仓 docs/templates 对齐版本
│   ├── schemas/
│   │   └── prd-review-output.v1.schema.json   # 与本仓 docs/templates/schemas/ 同步
│   ├── prd-spec/
│   │   ├── prd-spec.cn.md.template
│   │   └── prd-spec.en.md.template
│   ├── feature_list.md.template
│   ├── config.dev.json.template
│   ├── config.release.json.template
│   ├── config.env.template
│   ├── stages.json.template
│   └── deploy-services.catalog.json
└── scripts/
    ├── lib/
    │   ├── paths.cjs
    │   ├── merge-stages.cjs
    │   ├── run-with-timeout.cjs
    │   └── secret-scan.cjs        # 含 config.security.forbidden_json_key_patterns
    ├── run.cjs                     # 建议：唯一 CLI 入口，分发子命令
    ├── prd-bootstrap.cjs
    ├── prd-parse-client-targets.cjs
    ├── prd-validate-spec.cjs
    ├── prd-validate-derived.cjs
    ├── prd-validate-config.cjs
    ├── prd-write-stage.cjs
    ├── prd-review-validate.cjs
    └── prd-review-write-stage.cjs
```

脚本文件名允许微调，但 **解析 / 校验 / 写状态** 三类职责不得合并成「单文件黑盒」，以便测试与 Agent 分步调用。

### 4.2 `run.cjs` 建议子命令

| 子命令 | 职责 |
| --- | --- |
| `bootstrap` | 调用 `prd-bootstrap.cjs`：目录、模板拷贝、`.gitignore` 提示、`stages` 骨架 |
| `parse-targets` | 仅解析并 stdout JSON：`declared[]`（供调试） |
| `validate-prd` | 串联 spec / derived / config 校验，**不写** completed |
| `write-prd` | 在校验已通过的前提下写 `stages.prd` 完成态 + §9 hash |
| `validate-prd-review` | 前置门闸 + 门闸终检（可读模式） |
| `write-prd-review` | 合并 LLM 产出的结构化 JSON 到 `stages.prd_review`（**不写** `completed` 与 **§9.2** 哈希；终检见 **§8.3**） |

**约定**：`validate-*` 失败时退出码 **1**，且须更新**当前阶段**在 `stages.json` 中的块：例如 `validate-prd` 失败须写 **`stages.prd`**；`validate-prd-review` 失败须写 **`stages.prd_review`**——`status=failed`，`validation.passed=false`，不得保持 `running`（详见 §7.4 / §8.4 语义）。

---

## 5. 业务项目侧路径契约

路径均相对于 **`<project_root>/`**。

| 路径 | 职责 |
| --- | --- |
| `docs/inputs/prd-spec.md` | **PRD 总源头**；仅由 **prd** 流程或用户显式编辑更新 |
| `docs/<client_target>/prd.md` | 从 prd-spec **派生** |
| `docs/<client_target>/feature_list.md` | 从 prd-spec **派生**（`feature_list.md.template` v0） |
| `docs/config.dev.json` | 开发环境非敏感配置 |
| `docs/config.release.json` | 发布环境非敏感配置（结构与 dev 对齐） |
| `docs/config.env` | **仅占位**；禁止真实密钥入库 |
| `.pipeline/stages.json` | 编排门闸真源 |
| `.agent-sessions/` | 会话日志（**应**被 `.gitignore`） |

**`client_target` 允许值**（与 `stages.json.template` → `client_targets.allowed_values` 一致）：  
`website` / `admin` / `backend` / `miniapp` / `mobile` / `desktop` / `agent`。

### 5.1 `project_id` 生成（首次 prd 成功路径）

以下三处必须一致：

- `stages.json` → `project.project_id`  
- `docs/config.dev.json` → `project.project_id`  
- `docs/config.release.json` → `project.project_id`  

**算法**（与 `input-spec.md` §8 阶段 1 一致）：

1. 若仓库存在 **git remote**（建议用 `origin` 的 URL，若无则任选一 remote）：  
   `project_id = "p-" + sha1("<remote_url>|<root_realpath>")[:12]`  
   其中 `sha1` 为十六进制小写，`[:12]` 为前 12 个十六进制字符（即 6 字节）。  
2. 否则：  
   `project_id = "p-" + <12 位小写十六进制字符>`。  
   **与 `input-spec.md` §8 阶段 1 对齐**：`input-spec` 写作 `uuid_v4()[:12]` 易产生「是否含连字符」歧义；**本 skill 实现约定**为：取标准 **UUID v4** 字符串、**去掉 `-` 后取前 12 个十六进制字符**（小写），使无 git 分支与 **sha1 分支的 `[:12]`（12 个 hex）**在形态上一致。

生成后**不自动改写**；重置须用户显式清空三处后重新跑 prd 初始化路径。

---

## 6. `client_targets` 机器解析（**定稿**，实现以此为准）

与 **docs/input-spec.md** §8 阶段 1、**docs/templates/stages.json.template** 中 `client_targets._doc` / `derivation_source` 一致：**声明列表**位于 **`docs/inputs/prd-spec.md`** 的固定二级标题下，为**单层无序列表**（非 YAML 围栏）。

### 6.1 标题与锚点

| 语言 | 二级标题（**全文精确匹配行首**） | 典型 Markdown 锚点 |
| --- | --- | --- |
| 中文（默认） | `## 端 (Client Targets)` | `#client-targets` |
| 英文 | `## Client Targets` | `#client-targets` |

`stages.json.template` 中 **`client_targets.derivation_source`** 固定为：  
**`docs/inputs/prd-spec.md#client-targets`**（与 CN 标题锚点一致；英文模板亦采用可解析为 `#client-targets` 的 GitHub 风格 slug）。

### 6.2 解析算法（`prd-parse-client-targets.cjs`）

1. 读取 **`docs/inputs/prd-spec.md`**（UTF-8）。  
2. 自文件顶向下查找 **第一个**匹配 **§6.1** 的二级标题行。  
3. 从该标题**下一行**起扫描，**跳过**空行与纯说明段落，直到遇到 **Markdown 无序列表**：行匹配正则 **`^\s*-\s+(.+)$`**。  
4. **声明列表**采集规则：从**第一个**匹配 `^\s*-\s+` 的列表项开始，**连续**纳入后续行：  
   - **空行**不结束列表；  
   - 遇**非空**且**不匹配** `^\s*-\s+` 的行（新段落、说明文字等）→ **结束**；  
   - 遇 **`## `** 开头的标题行 → **结束**。
5. 对每一列表项：取第一个 **行内代码块** `` `...` `` 内的文本作为 slug；若无反引号，则取去掉 `-` 与首尾空白后的整段可见文本为 slug。slug 必须在 **`stages.client_targets.allowed_values`**（或与模板一致的固定枚举）内。  
6. 将得到的 slug 数组（顺序稳定、去重）写入 **`stages.client_targets.declared`** 与 **`stages.prd.outputs.client_targets`**。

**失败条件**（均 **退出码 1**，不派生各端文件，不写 `prd` 完成态）：

- 找不到 **§6.1** 规定的标题；  
- 标题下不存在合法无序列表，或列表**解析后为空**；  
- 任一 slug 不在允许值集合内。

### 6.3 与「各端专属需求」一致性（prd 语义）

已声明的端必须在 prd-spec 中 **「各端专属需求」** 章节下存在对应 **`### <slug>`** 小节且内容已补齐：

| 模板 | 二级标题（精确匹配行首 `## `） |
| --- | --- |
| **`prd-spec.cn.md.template`** | `## 7. 各端专属需求` |
| **`prd-spec.en.md.template`** | `## 7. Target-Specific Requirements` |

**`prd-validate-spec.cjs`** 须按当前 prd-spec 语言对每个 `declared` 端验证：存在 **`### <slug>`**（slug 与 `client_targets` 列表项一致）；启发式「已补齐」阈值写在脚本常量，并由 **§12** 用例覆盖。

### 6.4 与 YAML 围栏旧稿的兼容（可选）

若存量项目仍保留历史 **YAML 围栏代码块**（语言 `yaml` / `yml`）且根键为 `client_targets:` 的旧格式，实现可选择 **在找不到 §6.1 标题时**回退解析该 YAML（**须**在 `validation.summary` 注明 `legacy_yaml_client_targets`）；**新初始化项目一律使用 §6.1 列表格式**。

---

## 7. 阶段一：`prd`

### 7.1 意图

将用户输入收敛为 **`docs/inputs/prd-spec.md`**；校验通过后按 `client_targets` 派生各端 **`prd.md`** 与 **`feature_list.md`**；初始化 **`config.*.json`** 与 **`config.env` 占位**；更新 **`stages.prd`** 与 **§9** 哈希。

### 7.2 建议执行顺序

1. **`prd-bootstrap.cjs`**  
   - 创建 `.pipeline/`、`docs/inputs/`、各 `docs/<端>/`（**仅** `declared` 中端，须在 parse 之后调用或 bootstrap 内调 parse）。  
   - `docs/inputs/prd-spec.md` 不存在：从 **`templates/prd-spec/prd-spec.cn.md.template`**（或 `--lang=en`）复制；**已存在则不覆盖**。  
   - `config.*.json` / `config.env` 不存在：从模板复制；**已存在默认不覆盖**。缺模板必填键时：**stderr 说明 + 退出 1**，或经 **`--allow-fill-missing-keys`** 且在交互/显式确认后做 **additive 补齐**（与 `input-spec.md` §3 一致，具体 flag 名可在实现中定稿但须写入 `SKILL.md`）。  
   - `.pipeline/stages.json` 不存在：自 **`stages.json.template`** 拷贝初始化；已存在则 **`merge-stages.cjs` 合并**，禁止整文件覆盖。  
   - `.gitignore` 未忽略 `.agent-sessions/`：**stderr 警告**，不阻断。  
   - 将 `stages.prd.status` 置 **`running`**，`pipeline.updated_by` = `ai-prd3`，`pipeline.updated_at` = ISO8601。

2. **LLM**（`prompts/prd-spec-author.md`）：补全 prd-spec，**不**在此步修改各端派生文件。

3. **`prd-validate-spec.cjs`**：结构化完整性 + **§6** 解析 + **§6.3** 端小节检查。失败 → **§7.4**。

4. **LLM**（`prompts/derive-per-target.md`）：按端写 `prd.md` 与 `feature_list.md`。

5. **`prd-validate-derived.cjs`**：存在性、`feature_list.md` 章节骨架、Feature 表非空、ID 可解析。

6. **`prd-validate-config.cjs`**：JSON 必填键、`_schema`、**附录 B** 密钥扫描（`config.security.forbidden_json_key_patterns` + 值形态启发式）。

7. **`prd-write-stage.cjs`**：`status=completed`，`validation.passed=true`，填写 `outputs`、`generated_files`、`validation.required_files[]` 位、**§9** `prd` 哈希、`completed_at`；将 **`client_targets.generated`** 置为与本期已成功派生的端集合一致（通常与 `declared` 相同；若某端目录未生成则不得标 `completed`）。

### 7.3 `prd` 完成判定

当且仅当：

- `docs/inputs/prd-spec.md` 存在且通过 `prd-validate-spec.cjs`；  
- 每个 `declared` 端下 `prd.md` 与 `feature_list.md` 存在且通过 `prd-validate-derived.cjs`；  
- `docs/config.dev.json`、`docs/config.release.json`、`docs/config.env` 存在且通过 `prd-validate-config.cjs`；  
- `.pipeline/stages.json` 中 **`stages.prd.status=completed`** 且 **`stages.prd.validation.passed=true`**；  
- **`stages.client_targets.generated`** 与本期已生成目录的端集合一致；  
- **`stages.prd.inputs.summary_hash`** 已按 **§9.1** 写入。

**不要求**用户口头点击确认作为必要条件。

### 7.4 失败与状态字段

| 情况 | `stages.prd.status` | `validation.passed` | 退出码 |
| --- | --- | --- | --- |
| 任一校验失败 | `failed` | `false` | 1 |
| 用户取消 | `failed` 或 `blocked`（实现二选一并写入 `SKILL.md`） | `false` | 2 |
| 超时（§11） | `failed` | `false` | 3 |

`validation.summary` 须含简短机器可读原因；`checked_at` 填 ISO8601。

### 7.5 手工重跑（覆盖派生稿与 config 草稿）

与 `input-spec.md` §7.2：**prd** 重跑语义为 **overwrite**，手工触发时须 **显式确认** 或 **`--force`**（由 `SKILL.md` 声明）；缺失确认则 **退出 1**。

### 7.6 各端 `feature_list.md` 的 Review Notes

**默认**：ai-prd3 **不**自动把 `prd-review` 结论批量写回各端 `feature_list.md`（避免与人工编辑冲突、避免双真源）。若将来需要「同步到派生稿」，须新增独立子命令并在本文增订。

---

## 8. 阶段二：`prd-review`

### 8.1 意图

在**不污染 `prd-spec.md` 正文**的前提下完成评审；将结论写入 **`stages.prd_review`**，使 **ai-design3** / **ai-auto3** 能判定可否进入 **design**。

### 8.2 禁止项（须出现在 `SKILL.md`）

- **不得**把评审意见、讨论纪要默认追加进 **`docs/inputs/prd-spec.md`**。  
- **不得**把各端 **`prd.md`** 当批注白板。对端调整须：**评审记录 `suggested_prd_spec_changes` → 用户同意 → 回到 prd 流程改 prd-spec → 再派生**。  
- **不得**把密钥写入 `config.dev.json` / `config.release.json`。

### 8.3 建议执行顺序

1. **前置门闸**：`stages.prd.status=completed` 且 `stages.prd.validation.passed=true`；否则 **1**。  
2. **LLM**（`prompts/prd-review.md`）：产出 **结构化 JSON**（由 **§4.1** 所列 `templates/schemas/prd-review-output.v1.schema.json` 校验），**禁止** LLM 直接整文件改写 `stages.json`。  
3. **`prd-review-write-stage.cjs`**：合并 JSON 到 `stages.prd_review`；维护 `review.*`、`outputs.decision`、`conditions`、`blocking_issues`、`validation.*`。**此步不得**将 `status` 置为 **`completed`**，**不得**将 `validation.passed` 置为 **`true`**（避免未终检即「假完成」）。  
4. **`prd-review-validate.cjs`（终检）**：满足 **§8.4** 全部条件后：将 **`stages.prd_review.status`** 置为 **`completed`**、**`validation.passed=true`**，并写入 **§9.2** `inputs.summary_hash` 及 **`outputs.can_enter_design`** 等终态字段。若本步失败，**必须**保持或回写 **`failed`**、`validation.passed=false`，且 **§9.2** 哈希须为**空或表示无效**（与未完成语义一致，由实现二选一并写入 `SKILL.md`）。

### 8.4 可进入 **design** 的判定（与 `input-spec.md` §8 阶段 2 对齐）

须**同时**满足：

1. `stages.prd_review.status=completed` 且 `outputs.decision=passed`（**`conditional_passed` 不算通过**）；  
2. **`blocking_issues.length === 0`**（若同时维护 **`validation.blocking_issues_count`**，须为 **0** 且与数组一致）；若曾出现 **`conditional_passed`**，则须 **`validation.conditions_resolved=true`**，且所有 **`conditions`** 已在 `stages.json`（或链接跟踪处）标记为已落实，且 **`outputs.decision` 已改写为 `passed`**（与 **`input-spec.md` §8 阶段 2** 一致）；  
3. **本期** `review.phase_plan[*].feature_ids` 合并去重后非空，且每个 `feature_id` 至少在**某一个**已声明端（`declared`）的 **`feature_list.md`** → Features 表中存在（与 **`input-spec.md` §8 阶段 2**「本期各特性具备明确 design 输入」一致；**`validation.design_inputs_ready`** 由脚本根据规则置位，终检见本条第 6 点）；  
4. **`validation.config_secret_scan_passed=true`**（对当前 `config.*.json` 重跑附录 B 规则；对应 **`input-spec.md` §8 阶段 2**「密钥仅在 `config.env`、JSON 无敏感键名命中」）；  
5. **`stages.prd_review.inputs.summary_hash`** 已按 **§9.2** 写入；  
6. **`outputs.can_enter_design=true`**，且 **`validation.design_inputs_ready=true`**、**`validation.passed=true`**（与 `stages.json.template` 中 `prd_review` 块字段一致；终检通过时由脚本写入）。

### 8.5 与 **ai-auto3** 启动 checklist 的对齐（摘录）

`input-spec.md` §4.3.1 要求自动序列启动前：**`prd` 与 `prd-review` 已完成**，且 **`phase_plan[*].feature_ids` 非空**。ai-prd3 在 **`outputs.decision=passed`** 时必须保证 **§8.4.3**，否则即使用户误标 `passed`，终检脚本也应 **失败退出 1**。

### 8.6 手工重跑

覆盖 `stages.prd_review` 时：须 **显式用户同意** 或 **`--force`**（`input-spec.md` §7.2 / §8.1）。

### 8.7 完成后的用户提示（大意，须写入 `SKILL.md`）

- 下一步进入设计：使用 **`ai-design3`**。  
- 若从 **design** 起自动跑至 dev deploy + smoke + report：使用 **`ai-auto3`**（**不**从 prd 起步）。

---

## 9. `inputs.summary_hash`（跨阶段漂移门闸）

**算法固定为 SHA-256**，输出 **64 位小写十六进制字符串**。输入字节序列构造规则如下。

### 9.1 `stages.prd.inputs.summary_hash`

在 **`prd-write-stage.cjs`** 将 prd 标为完成前计算：

```
canonical_prd_spec = UTF-8( docs/inputs/prd-spec.md 全文，换行规范化：仅 \n )
summary_hash = SHA256( canonical_prd_spec )
```

写入 **`stages.prd.inputs.summary_hash`**（`stages.json.template` v1 已含空字符串占位；成功完成时须替换为 **64 位小写十六进制** 非空值）。

### 9.2 `stages.prd_review.inputs.summary_hash`

在 **`prd-review-validate.cjs` 终检通过**、即将把 `prd_review` 标为 **`completed`** 之前计算并写入（与 **`prd-review-write-stage.cjs`** 已合并后的 `stages.json` 磁盘态一致）。若实现选择在 **`write-stage`** 中预写哈希，则**必须**在终检失败时清除或重算，避免「未通过却带有效哈希」。  
**`docs/<端>/`** 指 **`stages.prd.outputs.client_targets`**（或 **`stages.client_targets.declared`**，二者在完成 prd 时应一致）中每个 slug；文件路径按 slug **字典序**排列。

```
parts = [
  stages.prd.inputs.summary_hash + "\n",
  对每个 slug（字典序）拼接 docs/<slug>/feature_list.md 的 canonical 全文,
  对每个 slug（字典序）拼接 docs/<slug>/prd.md 的 canonical 全文,
  canonical UTF-8 JSON minify 后的 docs/config.dev.json,
  canonical UTF-8 JSON minify 后的 docs/config.release.json
]
summary_hash = SHA256( concat(parts) )
```

写入 **`stages.prd_review.inputs.summary_hash`**（占位键同 **§9.1**；**仅终检通过**时须为 **64 位小写十六进制** 非空值；终检失败时**须**保持空串或清除，与 **`validation.passed=false`** 一致）。

**说明**：「上游变更检测」全局策略（谁在何时把 `validation.passed` 打回 false）可由 **ai-auto3** 或独立 `drift-check` 实现；ai-prd3 **负责在成功完成时写入正确哈希**，以便下游消费。

---

## 10. 退出码

与 **`input-spec.md` §5** 一致：

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 前置失败、schema/门闸不满足、解析失败、敏感扫描失败、**凭证/密钥误写入 JSON** 等 |
| 2 | 用户取消 |
| 3 | 可重试失败；**阶段/子命令超时**一律映射为 **3**，并写 `outputs.timed_out=true`、`timeout_reason` |

本 skill **不使用** 4–8，除非将来扩展且已更新本文与 `SKILL.md`。

---

## 11. 超时与观测

- **配置键**：`docs/config.dev.json` → `timeouts.stages.prd_s` 与 **`timeouts.stages.prd_review_s`**（注意 **`prd_review`** 带下划线 + `_s` 后缀，与 `config.dev.json.template` 一致）。默认均为 **600**（秒）。  
- **实现**：超时须在 **cjs** 内实现（`run-with-timeout.cjs`）；触发后退出码 **3**，并写当前阶段的 `outputs.timed_out`、`outputs.duration_ms`、`outputs.timeout_reason`（如 `stage_timeout`）。  
- **日志**（`input-spec.md` §6）：**`run.cjs`** 向 **`.agent-sessions/ai-prd3.ndjson`** 追加 NDJSON（`invoke` / `exit` / 子步骤失败等）；若 CLI 传入 **`--session-id=<id>`**（或环境变量 **`AI_SESSION_ID`**），同时向 **`.agent-sessions/<id>.log`** 追加人类可读行（含子命令、退出码、`argv` 摘要）。  
- **用户中断**：**`run.cjs`** 收到 **SIGINT** → **退出码 2**（与 **§7.4**「用户取消」对齐；亦见 **`SKILL.md`**）。

---

## 12. 测试与验收（实现者自检）

| 用例 | 期望 |
| --- | --- |
| 首次 bootstrap | 创建目录与占位文件，**不覆盖**已有 prd-spec |
| prd-spec 缺少「## 端 (Client Targets)」或等价英文标题 | 退出 1 |
| 端标题下无合法无序列表或列表为空 | 退出 1 |
| `client_targets` 列表项含非法端名 | 退出 1 |
| 声明端但「各端专属需求」缺对应 `### <slug>` 小节（中/英模板见 **§6.3**） | `validate-prd` 退出 1 |
| `config.dev.json` 顶层出现 `api_key` 键 | 附录 B 扫描失败，退出 1 |
| prd 全流程成功 | `stages.prd` completed + **§9.1** hash 非空 |
| prd-review `decision=passed` 但 `feature_ids` 全空 | 终检退出 1 |
| `conditional_passed` 且 `conditions` 非空且未置 `passed` | 不满足 §8.4 之 **passed** 语义，终检退出 1 |
| 手工重跑 prd / prd-review 无确认 | 退出 1 |
| 英文 prd-spec 声明端但缺 **`## 7. Target-Specific Requirements`** 下 **`### <slug>`** | `validate-prd` 退出 1 |
| 改 prd-spec 一字后未重跑 prd | **`validate-prd`** 首步 **`prd-validate-spec`**：若 **`stages.prd` 已完成**且 **`prd-spec.md`** 的 SHA-256 ≠ **`inputs.summary_hash`** → **退出 1**（`prd_spec_drift`）；须 **`validate-prd` + `write-prd`** 或 **`bootstrap --force`** 后重做 prd |

---

## 13. 模板与 skill 发布同步

1. **`docs/templates/`**（本仓）为模板 **authoring 真源**（含 **`docs/templates/schemas/prd-review-output.v1.schema.json`**）。  
2. 发布 **ai-prd3** 时将 **`templates/`** 目录（含 **`templates/schemas/`**）与之一致版本打包（拷贝或构建脚本）。  
3. **additive** 变更：旧项目缺键时脚本 **默认补齐**（`input-spec.md` §9.1）。  
4. **breaking** 变更：升 `_schema.version` + `docs/templates/migrations/` 文档；skill 遇高于支持版本的 schema **退出 1**。

---

## 14. 已决项归档（原 T1/T2）

| ID | 内容 | 状态 |
| --- | --- | --- |
| T1 | LLM 产出 JSON 的 **JSON Schema** 随 skill 分发路径 | **已关闭**：**`templates/schemas/prd-review-output.v1.schema.json`**（见 **§4.1** 目录树；版本后缀 `v1` 与 breaking 时升版规则见 `input-spec.md` §9.1）。 |
| T2 | **registry.sqlite** 是否在 prd 完成时写入 | **已关闭**：**不**作为 prd 完成必要条件；项目索引以 **`.pipeline/stages.json`** 为准，**`~/.cursor/skills/_registry/registry.sqlite`** 由 **ai-auto3** 按需导入（`input-spec.md` §3.2 / §4.3.1#6）。**ai-prd3** 若将来写入该缓存，须 **warn 不阻断**，并在同一 PR 同步修订本文 **§14** 与 **`SKILL.md`**（或删除本表行）。 |

---

## 15. `stages.json` 读写子集检查表

读写 **`merge-stages.cjs`** 时须保留其它阶段键。ai-prd3 关心的键：

**顶层**：`project`（含 `project_id`）、`pipeline`、`client_targets`（含 **`declared`**、**`generated`**、**`allowed_values`**、**`derivation_source`**）、`stages.prd`、`stages.prd_review`。

**`stages.prd`**：`status`、`started_at`、`completed_at`、`inputs`（`source_prd_spec`、`raw_input_refs`、`summary_hash`）、`outputs`（含路径与 **`client_targets`** 数组）、`validation`（含 `required_files[]`、`passed`、`summary`）、`generated_files`、**顶层 `blocking_issues`**。

**`stages.prd_review`**：`status`、`started_at`、`completed_at`、`inputs`（`requires_stage`、`source_prd_spec`、`feature_lists`、`summary_hash`）、`outputs`（`decision`、`can_enter_design`、`current_phase`、`next_skill_*`、`duration_ms`、`timed_out`、`timeout_reason`）、`review` 全文、`conditions`、**顶层 `blocking_issues`**（与 **`input-spec.md` §8 阶段 2**「阻塞项列表」对应）、`validation`（含 `passed`、`checked_at`、`summary`、`blocking_issues_count`、`conditions_resolved`、`design_inputs_ready`、`config_secret_scan_passed`、`warnings`）全文。

**`prd_review.inputs.feature_lists`**：脚本应根据 `stages.client_targets.declared` 或 prd 输出，填入形如 `docs/<端>/feature_list.md` 的路径数组。

---

## 16. 附录 A：从 `input-spec.md` 摘录的硬约束（prd 相关）

- §3：密钥只在 `config.env`；JSON 禁止塞密钥；模板首次拷贝不覆盖已有文件；缺键须可探测并失败或可确认补齐。  
- §3.1：`stages.json` 为项目侧门闸真源；键名 **`prd_review`** 下划线。  
- §5：退出码语义表；超时 → **3**。  
- §6：日志在 `.agent-sessions/`；PID 锁路径（本 skill 若不自管 pipeline 锁，须在 `SKILL.md` 说明由 ai-auto3 管理）。  
- §7.2：prd / prd-review 重跑须用户确认。  
- §8 阶段 1–2：prd / prd-review 业务语义与完成判定（本文 §7–§8 已细化）。  
- §4.3.1：**`prd` / `prd-review` 已完成**（含 **`stages.prd.status`**、**`stages.prd_review.status`** 与 **`phase_plan[*].feature_ids` 非空**）为 **ai-auto3** 启动前置条件之一。  
- §4.4：各阶段 `inputs.summary_hash` 用于「已完成」与上游漂移判定；prd / prd-review 的构造规则见本文 **§9**。

---

## 17. 附录 B：`config.*.json` 密钥与键名扫描

实现 **`secret-scan.cjs`** 时须：

1. 读取 **`docs/config.dev.json`**（及 release）中的 **`security.forbidden_json_key_patterns`** 数组，对 **所有嵌套对象的键名** 做**子串匹配**（大小写策略须固定，建议 **小写化后匹配**）；命中任一模式 → **失败**。  
2. 对 string 值做常见密钥形态启发式（如 `BEGIN PRIVATE KEY`、`sk_live_` 等）——具体模式列表维护在脚本常量，**须写入单测**。  
3. **`docs/config.env`**：允许值为空或占位符；若值非空，**不得**在日志中打印完整值。

---

## 18. 附录 C：实现后 `SKILL.md` 必备目录（验收勾选项）

- [ ] Frontmatter：`name`、`version`、`description`（含触发词 **ai-prd3**、第三代 PRD、需求评审）。  
- [ ] §0 指向本文路径（仓库内相对路径 **`docs/spec/prd3.md`**）。  
- [ ] 覆盖阶段 / 非覆盖阶段。  
- [ ] I/O 路径表（等同本文 §5）。  
- [ ] `run.cjs` 子命令表（等同本文 §4.2）。  
- [ ] 退出码表（等同本文 §10）与**超时**约定（等同本文 **§11**）。  
- [ ] **`config.*.json` 密钥扫描**（**附录 B**）在 `preflight` / `validate-config` 中的调用方式写入 `SKILL.md`。  
- [ ] 与 **ai-design3**、**ai-auto3** 的下一步话术（等同本文 **§8.7**；prd 完成后的门闸见 **§7.3**）。  
- [ ] 禁止项（等同本文 §8.2）。  
- [ ] **`--allow-fill-missing-keys`**（**§7.2**）、**`--session-id` / `AI_SESSION_ID`**、**§11** 日志路径（**`ai-prd3.ndjson`**、**`<session_id>.log`**）。  
- [ ] **SIGINT → 退出 2**（**§7.4**）；**prd-spec 漂移**与 **`validate-prd`** 行为（见 **§12** 末行）。  
- [ ] 重跑与 `--force` 约定（等同本文 §7.5、§8.6）。

---

## 19. 修订记录

| 版本 | 日期 | 说明 |
| --- | --- | --- |
| 0.2 | 2026-05-15 | **§4.2** 澄清 `write-prd-review` 与 **§8.3** 哈希语义；**§11** 增补 **`ai-prd3.ndjson`**、**`--session-id`**.log、**SIGINT→2**；**§12** 漂移用例定稿；**附录 C** 增补 **§7.2** / 日志 / 漂移 / **§7.4** 勾选项。 |
| 0.1 | 2026-05-15 | 文档评审修订：§0 与 **附录 A/B/C** 分工写清；**§7.4** 超时引用修正为 **§11**；**§15** 补全 **`client_targets` / `prd_review`** 字段边界；**附录 A** 补 **§4.3.1** `prd` 完成态；**附录 C** 补超时与 **附录 B** 扫描勾选项；**§14 T2** 与 **`input-spec.md` §3.2** 语义对齐；页脚增 **`config.env.template`**、**`prd-review-output` schema** |

---

*文档版本：与 **docs/input-spec.md**、**docs/templates/stages.json.template** `_schema.version=1`、**docs/templates/feature_list.md.template**、**docs/templates/prd-spec/prd-spec.cn.md.template**、**docs/templates/prd-spec/prd-spec.en.md.template**、**docs/templates/config.dev.json.template**（含 `timeouts.stages.prd_review_s`）、**docs/templates/config.env.template**、**docs/templates/schemas/prd-review-output.v1.schema.json** 当前检入对齐；变更时请走 §0 维护流程。*
