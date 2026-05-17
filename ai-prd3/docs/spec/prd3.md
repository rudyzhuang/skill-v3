# ai-prd3 规范（SSOT）

版本：0.2.6（与 `SKILL.md` frontmatter 对齐）

## 1. 原始需求输入（raw input）

原始需求可以是 **Markdown 文件** 或 **用户/Agent 提供的一段内联文字**，二者统一解析，不写死 `inputs/req.md`。

### 1.1 来源优先级（高 → 低）

| 优先级 | 来源 | 说明 |
| --- | --- | --- |
| 1 | CLI `--raw-input-text=` / `--raw-input-text` | 对话粘贴的 Markdown；`@/path` 表示读取该文件**内容**作内联 |
| 2 | 环境变量 `AI_PRD3_RAW_INPUT_TEXT` | 内联 Markdown |
| 3 | CLI `--stdin` | 从标准输入读入内联 Markdown |
| 4 | 缓存快照 | `stages.pipeline.raw_input.source=inline` 且存在 `.pipeline/cache/raw-input.snapshot.md` |
| 5 | 需求文件 | `--raw-input=` / `AI_PRD3_RAW_INPUT` / `pipeline.raw_input.path` / 默认 `inputs/req.md` |

内联输入会**持久化**到 `.pipeline/cache/raw-input.snapshot.md`，并在 `stages` 中记录 `raw_input_source: inline|file` 与 `content_hash`。

### 1.2 缓存字段

- `stages.prd.inputs.raw_input_hash`：全文 SHA-256
- `stages.prd.inputs.raw_input_functional_hash`：「功能需求」节哈希
- `stages.prd.inputs.raw_input_source`：`inline` | `file`
- `stages.pipeline.raw_input`：`source`、`path`、`content_hash`、`snapshot_path`（inline 时）

### 1.3 子命令行为

- **`detect-raw-input`**：比对哈希 → `.pipeline/reports/raw-input-drift.json`（`impact_hints` 供 Agent 改 prd-spec）
- **`apply-raw-input-config`**：同步 `config.*.json` 的 `deploy.services`（website/admin/backend）与 `smoke`
- **`validate-prd`**：首步 `detect-raw-input`，再 spec / derived / config

功能变更须 Agent 更新 `prd-spec.md` 后 `validate-prd` / `write-prd`；域名/URL 可由 `apply-raw-input-config` 自动同步 config。

### 1.4 req 功能条目的 feature 抽取（**ai-soak3 强制**）

当 **`inputs/req.md`「功能需求」** 出现下列语义时，**必须**在 `docs/prd-spec.md` §6 增加独立 `feature_id`（编号由项目递增，语义优先）：

| req 语义（示例） | 建议 feature_id 模式 | 涉及端 | 验收摘要 |
| --- | --- | --- | --- |
| 应用中文名 / 英文名 | `MOB-BRAND-*` 或 `APP-BRAND-*` | mobile（可含 website title） | 显示名与 req 一致 |
| 图标与启动图 | `APP-ICON-*` / `MOB-SPLASH-*` | mobile | 非默认 Flutter 占位图标 |
| 笔记 CRUD / 各端页面 | 现有 `NOTE-*` / `WEB-*` / `ADMIN-*` | 按端 | 与 req 端描述一致 |

**门闸**（`validate-prd` 实现 backlog；文档阶段由 Agent 自检）：

- `detect-raw-input` 输出 **`functional_requirements_changed: true`** → **`write-prd` 前** prd-spec §6 须已更新且 `phase_plan` 覆盖新 ID。
- **`requires_agent: true`** 时 **禁止** `finalize-prd-review` 直至 Agent 确认已改 prd-spec（**ai-soak3** 见 `soak3.md` §11）。

**禁止**：仅 `apply-raw-input-config` 改 URL 而不增 feature 即视为 PRD 完成。

### 1.5 新增需求四类分流（与 RFC §2.5 一致）

`detect-raw-input` 后，Agent **必须**在改稿前列出分类（实现后写入 **`raw-input-drift.json`** → **`feature_impacts[]`**）：

| 类型 | 代号 | prd / config 动作 | 是否重跑他 feature 的 pipeline |
| --- | --- | --- | --- |
| 仅配置 | **C** | `apply-raw-input-config`；prd-spec 部署节同步 | **否**（仅 deploy/smoke 按需） |
| 正交新 feature | **O** | prd-spec §6 **新增行** + 派生稿；**不修改**无关既有 feature 行 | **否** |
| 受影响既有 feature | **I** | prd-spec **改**既有行 + 更新该 id 的 design/contract | **仅 I 的 id**（见 ai-auto3 §6.5） |
| 全新 feature（完整链） | **N** | 同 **O**，且须完整 design→contract→… | **仅 N 的 id** 全流程 |

**配置类需求**（域名、URL、smoke 路径、云平台名）：**不得**只写进 prd 散文；须映射到 **`config.*.json`** 具体键，并在 prd-spec **业务约束/部署** 节保留人类可读说明。

**正交性判定（Agent 自检）**：若新增「应用图标」只新增 `APP-ICON-*`，而 `NOTE-LIST-001` 的文件计划无交叉 → **O/N**，**不得** `bootstrap --force` 重写全部 `feature_list.md` 导致无关 id 漂移。

## 2. 子命令（节选）

| 子命令 | 说明 |
| --- | --- |
| `detect-raw-input` | 比对哈希；`--fail-on-change` → 退出码 2 |
| `apply-raw-input-config` | 同步 config；更新 raw_input 缓存 |
| `validate-prd` | detect → spec → derived → config |

## 3. Agent 提示词

| 文件 | 用途 |
| --- | --- |
| `prompts/raw-input-impact.md` | 原始需求变更后的 prd-spec / 派生稿 |
| `prompts/prd-spec-author.md` | 补全 prd-spec |

## 4. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 校验/前置失败 |
| 2 | `detect-raw-input --fail-on-change` 且内容已变更 |
| 3 | 超时 |
