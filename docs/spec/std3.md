# 实现规范 — ai-std3（独立全量流水线 Skill）

| 项 | 值 |
| --- | --- |
| **skill name** | `ai-std3` |
| **定位** | **独立 Skill**：自包含实现，不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 脚本 |
| **实现目录** | `ai-std3/scripts/lib/<stage>.cjs`（每个 stage 一个脚本） |
| **编排入口** | `ai-std3/scripts/run-pipeline.cjs` |
| **规范真源** | [`docs/spec/std3.md`](../spec/std3.md)（即本文件） |

---

## 0. 架构定位

ai-std3 是一个**独立的全量流水线 Skill**，借鉴 V3 各 skill 的思路，但自行实现所有 stage 脚本，不 spawn 其它 skill 的 `run.cjs`。

**设计取舍（与原 V3 pipeline 的主要差异）**：

| 原 V3 有 | ai-std3 选择 | 理由 |
| --- | --- | --- |
| contract 五件套（types/api/schema/test_spec/design_snapshot） | **不要**：跳过 register-contract-artifacts + validate-contract | 契约文件由 AI 自动生成意义有限；改为直接从 design.json 派生 |
| typecheck stage | **不要** | 类型检查合并入 codegen Agent 职责；不做独立门闸 |
| test stage | **不要** | 单元/集成测试合并入 codegen Agent 职责；不做独立门闸 |
| merge_push stage | **要**：独立 stage | 合并到主干是发布的硬前置，需要独立状态与门闸 |
| create-ui-scenarios | **要**：独立 stage，从 design.json 派生 | 设计阶段验收标准是场景的最佳来源，比契约文件更直接 |

**阶段链（固定顺序）**：

```
setup
  → prd
  → prd-review
  → design
  → design-review
  → create-ui-scenarios
  → codegen
  → code-review
  → merge_push
  → build
  → deploy
  → smoke
  → ui_e2e
  → report
```

**通用约定**：

- 状态真源：业务项目 **`<业务项目根绝对路径>/.pipeline/stages.json`**
- 所有脚本调用形态：`node ai-std3/scripts/lib/<stage>.cjs --project=<业务项目根绝对路径> [选项]`
- 脚本不复制进业务仓
- 退出码：`0` 成功；`1` 前置/参数/脚本错误；`2` 用户中断/门闸需人工填写；`3` 超时；`4` 需 Agent 介入

---

## 1. stage 实现规范（人话版）

每节结构：**上游门闸 → 输入 → 处理逻辑（脚本做什么 / Agent 做什么）→ 输出 → 下游解锁条件**。
stages.<stage>.status: started | completed | failed | running, running 表示有 agent 在处理中
---

### setup — 初始化输入

**脚本**：`setup.cjs`、`setup-inputs.cjs`、`verify-inputs.cjs`、`sync-config-env.cjs`（已存在，保持现有实现）

#### 输入

| 来源 | 要求 |
| --- | --- |
| `ai-std3/docs/templates/req-template.md` | 模板；若 `inputs/req.md` 不存在则拷贝 |
| `ai-std3/docs/templates/config.env.template` | 模板；若 `inputs/config.env` 不存在则拷贝 |

#### 处理逻辑

1. `setup-inputs.cjs`：拷贝模板到 `<业务项目根绝对路径>/inputs/`；已存在则跳过。
2. `verify-inputs.cjs`：检查 `<业务项目根绝对路径>/inputs/req.md` 所有带 `*` 的 H2 节是否非空；检查 `<业务项目根绝对路径>/inputs/config.env` 的 `CLOUD_PROVIDER` 与对应密钥变量非空；后续可扩展校验其它 `<业务项目根绝对路径>/inputs/` 下文件。未通过 → 退出码 **2**，列出缺失项等用户补全。
3. `sync-config.cjs`：将 `<业务项目根绝对路径>/inputs/config.env` 内容写入 `<业务项目根绝对路径>/docs/config.env`（覆盖）, 把云平台配置同步到业务项目根目录下`<业务项目根绝对路径>/docs/config.<dev|release>.json`, 若该文件不存在，则从`ai-std3/docs/templates/config.json.template`中拷贝后再填入。
4. setup.cjs: 
    4.1 初始化业务项目根目录下`<业务项目根绝对路径>/.pipeline/stages.json`文件，若该文件不存在，则从`ai-std3/docs/templates/stages.json.template`中拷贝后再填入：
        写入`<业务项目根绝对路径>/.pipeline/stages.json`文件：
    ```json
    {
      "pipeline": {
        "current_stage": "setup",
        "last_completed_stage": null,
        "updated_at": null,
        "updated_by": "ai-std3",
        "project": {
          "project_id": "...",
          "root_path": "...",
          "name": "...",
          "git": {
            "remote": "...",
            "remote_url": "...",
            "default_branch": "...",
            "repo_initialized_at": null,
            "remote_configured_at": null
          }
        }
      }
      "stages": {
        "setup": {
          "status": "started",
          "started_at": <当前时间戳>,
          “can_enter_prd”: false,
          "inputs": {
            "source_prd_spec": "<业务项目根绝对路径>/inputs/req.md",
            "summary_hash": "<业务项目根绝对路径>/inputs/req.md 文件的SHA-256哈希",
            "raw_input_refs": []
          }
    }
    ```     
    4.2 调用脚本：setup-inputs.cjs、verify-inputs.cjs、sync-config.cjs，若全部退出 0，则继续执行下一步，否则退出码 **2**，列出缺失项等用户补全。
    4.3 增量写入`<业务项目根绝对路径>/.pipeline/stages.json`文件:
    ```json
    {
      "stages": {
        "setup": {
          "status": "completed",
          "completed_at": <当前时间戳>,
          “can_enter_prd”: true,
          "inputs": {
            "source_prd_spec": "<业务项目根绝对路径>/inputs/req.md",
            "summary_hash": "<业务项目根绝对路径>/inputs/req.md 文件的SHA-256哈希",
            "raw_input_refs": []
          },
          "outputs": {
            "config_dev": "<业务项目根绝对路径>/docs/config.dev.json",
            "config_release": "<业务项目根绝对路径>/docs/config.release.json",
            "config_env": "<业务项目根绝对路径>/docs/config.env",
            "client_targets": [],
            "duration_ms": null,
            "timed_out": false,
            "timeout_reason": null
          },
          "validation": {
            "passed": true,
            "checked_at": null,
            "summary": null,
            "required_files": [],
            "missing_required_fields": [],
            "warnings": []
          },
          "generated_files": [],
          "blocking_issues": [],
          "git_sync": {
            "initial_pushed_at": null,
            "docs_pipeline_pushed_at": null,
            "last_commit": null,
            "last_push_status": null
          }
        }
      }
    }
    
#### 输出

`setup.cjs`退出 0 即视为 setup 通过，`<业务项目根绝对路径>/.pipeline/stages.json`文件已更新。

#### 解锁

`setup.cjs` 退出 0 → 可运行 `prd`。

---

### prd.cjs — stage: `prd`

#### 上游门闸

setup 通过（`“can_enter_prd”` 为 `true`）。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `<业务项目根绝对路径>inputs/req.md` | 必填项已齐全 |
| `<业务项目根绝对路径>docs/config.env` | 云平台鉴权 |
| `<业务项目根绝对路径>docs/config.<dev|release>.json` | 云平台部署配置 |
| `<业务项目根绝对路径>/.pipeline/stages.json` | setup stage 的输出 |

**增量逻辑**：脚本对 `inputs/req.md` 计算 SHA-256 并与 `stages.prd.inputs.req_hash` 比对。若哈希一致且 `stages.prd.status=completed`，跳过（退出 0）。哈希不一致则标 `status=needs_rerun`，由 Agent 决定是否重跑。

#### 处理逻辑

1. **脚本（bootstrap）**：
   - 写 `stages.prd.status=started`。

2. **Agent（创造性）**：
   - 精读 `inputs/req.md`，产出 **`docs/prd-spec.md`**（中文、含 `## 客户端目标` 列表与 `## 核心功能` 表）。
   - 为每个 `client_target` 产出 **`docs/<client_target>/prd.json`**（结构化，供后续 design / codegen Agent 直接读取），字段：

     ```json
     {
       "client_target": "website",
       "project_name": "...",
       "features": [
         {
           "feature_id": "feat-a",
           "name": "...",
           "priority": "P0",
           "phase": "P1",
           "description": "...",
           "acceptance": ["..."],
           "api_hints": ["GET /api/xxx"]
         }
       ],
       "deploy": { "domain": "...", "service_type": "..." },
       "auth": { "type": "jwt|session|none", "notes": "..." },
       "constraints": ["..."]
     }
     ```
   - 为每个端产出 **`docs/<client_target>/feature_list.md`**（Markdown 表，每行一个 feature_id）。
   - Agent 解析 req 中的域名/部署要求，填写 `docs/config.dev.json` 的 `domain`、`deploy.services[]`、`smoke.checks[]` 初稿。

3. **脚本（validate + write）**：
   - 校验 `docs/prd-spec.md` 存在、含 `## 客户端目标` H2、每个 `client_target` 对应的 `prd.json` 与 `feature_list.md` 存在。
   - 校验 `docs/config.dev.json` 存在且合法 JSON，无明文密钥（forbidden key 扫描）。
   - 通过后写 `stages.prd`：`status=completed`、`validation.passed=true`、`inputs.req_hash`、`inputs.summary_hash`（prd-spec 哈希）、`outputs.client_targets[]`。
   - 可选 git commit+push（若 `config.dev.json.git.auto_commit=true`）。

#### 输出

| 路径 | 说明 |
| --- | --- |
| `docs/prd-spec.md` | PRD 总源头 |
| `docs/<client_target>/prd.json` | 各端结构化 PRD（AI 直接消费） |
| `docs/<client_target>/feature_list.md` | 特性表（feature_id、名称、优先级、阶段、涉及端） |
| `docs/config.dev.json` | 部署/smoke 配置初稿 |
| `.pipeline/stages.json` | `stages.prd` 完成态 |

#### 解锁

`stages.prd.status=completed` → 可运行 `prd-review`。

---

### prd-review.cjs — stage: `prd-review`

#### 上游门闸

`stages.prd.status=completed` 且 `validation.passed=true`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/prd-spec.md` + 各端 `feature_list.md` | 评审对象 |
| **Agent 产出 JSON** | 须符合 schema（见下），路径：项目根 `prd-review-auto.json` 或 `--prd-review-json=<path>` |

JSON 字段（最小集）：

```json
{
  "decision": "passed | failed",
  "phase_plan": [
    { "phase": "P1", "feature_ids": ["feat-a", "feat-b"] }
  ],
  "deferred_features": [],
  "risks": [],
  "summary": ""
}
```

缺少 JSON 文件 → 退出码 **4**，等待 Agent 产出后重跑。

#### 处理逻辑

1. **Agent（创造性）**：通读 PRD 与各端 feature_list，评审功能完整性、端覆盖、优先级合理性，产出 JSON（按 `prompts/prd-review.md`）。
2. **脚本（validate + write）**：
   - 读 JSON，验证字段存在性与类型（Ajv）。
   - 检查 `phase_plan` 中每个 `feature_id` 是否能在某端 `feature_list.md` 中找到。
   - `decision=failed` → 退出码 **4**，列出原因，等 Agent 改 PRD 后重跑 prd。
   - `decision=passed` → 写 `stages.prd_review`：`status=completed`、`review.phase_plan[]`、`inputs.summary_hash`（prd-spec 哈希）。
   - 生成 `.pipeline/reports/prd-implementation-summary.md`（人话摘要）。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | `stages.prd_review`：`decision=passed`、`phase_plan[]` |
| `.pipeline/reports/prd-implementation-summary.md` | 人话版分期摘要 |

#### 解锁

`stages.prd_review.status=completed` 且 `decision=passed` → 可运行 `design`。

---

### design.cjs — stage: `design`

#### 上游门闸

`stages.prd_review.decision=passed`，`review.phase_plan` 非空。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `stages.prd_review.review.phase_plan[]` | 待设计的 `feature_id` 列表 |
| `docs/prd-spec.md` + 各端 `prd.json` | 功能依据 |
| `docs/<client_target>/feature_list.md` | 特性详情 |

#### 处理逻辑

1. **Agent（创造性）**：按 `phase_plan` 中每个 `feature_id` 产出设计规格 **`docs/designs/<feature_id>.design.json`**，字段包含：

   | 字段 | 说明 |
   | --- | --- |
   | `feature_id` | 与 feature_list 对应 |
   | `client_target` | 目标端（website/admin/backend/mobile/…） |
   | `title` | 功能名称 |
   | `file_plan` | `new_files[]`、`modify_files[]`（含路径与说明） |
   | `api_outline` | API 端点简表（method、path、说明） |
   | `data_outline` | 主要数据结构/表字段简表 |
   | `acceptance` | 验收标准条目（字符串数组，至少 3 条） |
   | `constraints` | 技术约束 |
   | `dependencies` | 依赖其它 feature_id（无则 `[]`） |
   | `risks` | 风险条目 |

2. **脚本（validate + write）**：
   - 检查每个 `feature_id` 的 `design.json` 存在且合法 JSON。
   - 验证必填字段非空（feature_id、client_target、file_plan、acceptance 长度 ≥ 3）。
   - `feature_id` 须与文件名一致，须在 feature_list 中声明。
   - 写 `stages.design`：`status=completed`、`outputs.design_specs[]`（feature_id + file_plan 摘要）、`inputs.summary_hash`。

#### 输出

| 路径 | 说明 |
| --- | --- |
| `docs/designs/<feature_id>.design.json` | 每个 feature 的设计规格 |
| `.pipeline/stages.json` | `stages.design` 完成态 |

#### 解锁

`stages.design.status=completed` → 可运行 `design-review`。

---

### design-review.cjs — stage: `design-review`

> **注意**：本 stage 不使用契约五件套（types/api/schema/test_spec/design_snapshot）；直接对 design.json 做 AI 评审。

#### 上游门闸

`stages.design.status=completed` 且 `validation.passed=true`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/designs/<feature_id>.design.json` | 每个 feature 的设计规格 |
| `docs/prd-spec.md` | 需求来源，供对齐校验 |
| 可选 **Agent 产出评审 JSON** | 路径：`design-review-auto.json` 或 `--design-review-json=<path>` |

Agent 产出 JSON 字段（每 feature 一条）：

```json
[
  {
    "feature_id": "feat-a",
    "decision": "passed | needs_fix | failed",
    "gaps": [
      { "field": "file_plan", "severity": "blocking | warning", "note": "..." }
    ],
    "summary": "..."
  }
]
```

缺少 JSON 文件 → 退出码 **4**，等待 Agent 产出后重跑。

#### 处理逻辑

1. **脚本（确定性检查）**：
   - 遍历每个 feature：`acceptance` 数量 ≥ 3；`file_plan.new_files` 与 `modify_files` 无重叠主干文件冲突（多 feature 同时 modify 同一聚合文件需 warning）；`dependencies` 中引用的 feature_id 均在 phase_plan 内。
   - 汇总确定性 gap，严重性为 `blocking` 的项直接标 feature `decision=failed`。

2. **Agent（创造性评审）**：按 `prompts/design-review.md` 评审 design 的完整性、可实现性、端一致性，输出每 feature 的评审 JSON。

3. **脚本（merge + finalize）**：
   - 合并 Agent JSON 到确定性结果；`blocking` gap 数量 > 0 → 整体 `decision=needs_fix`，退出码 **4**。
   - 全部 passed → 写 `stages.design_review`：`status=completed`、`outputs.decision=passed`、`outputs.can_enter_codegen=true`、`inputs.summary_hash`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | `stages.design_review`：`decision=passed`、`can_enter_codegen=true`、`gaps[]` |

#### 解锁

`stages.design_review.can_enter_codegen=true` → 可运行 `create-ui-scenarios`。

---

### create-ui-scenarios.cjs — stage: `create-ui-scenarios`

> 从 design.json 的 **`acceptance[]`** 与 **`api_outline[]`** 派生可执行 UI 场景，供 `ui_e2e` 阶段的 Browser/Dart MCP 使用。

#### 上游门闸

`stages.design_review.can_enter_codegen=true`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/designs/<feature_id>.design.json` | `acceptance[]`、`api_outline[]`、`client_target` |
| `docs/config.dev.json` | `ui_e2e.enabled`、`deploy.services.*.url`（base_url 来源） |

#### 处理逻辑

1. **脚本（枚举 + 跳过检查）**：
   - 遍历 phase_plan 中每个 feature；读 `design.json`。
   - 检查 `docs/ui-scenarios/<feature_id>.scenarios.yaml` 是否已存在且 SHA-256 哈希匹配 `stages.create_ui_scenarios.features[].hash`；一致则跳过该 feature。

2. **Agent（创造性）**：按 `prompts/create-ui-scenarios.md` 为每个 feature 产出场景 YAML：

   ```yaml
   feature_id: feat-a
   client_target: website          # website | admin | mobile
   scenarios:
     - id: feat-a-smoke-001
       platform: web               # web | android | ios
       steps:
         - action: navigate
           url: "{base_url}/"
         - action: snapshot
       expect:
         - type: text_present
           value: "欢迎"           # 从 acceptance[] 提取关键词
     - id: feat-a-form-submit-001
       ...
   ```

   **约束**：
   - `web` 只能搭配 `website` / `admin`；`android` / `ios` 只能搭配 `mobile`。
   - 每个场景 `expect` 至少 1 条；web 场景须含 `text_present` 或 `url_contains`（禁止只检查状态码）。
   - 优先从 `acceptance[]` 提取可观测关键词作为 `expect.value`。
   - URL 用 `{base_url}` 占位，不硬编码。

3. **脚本（校验 + 写回）**：
   - 验证 YAML schema（Ajv 或 yaml.parse + 手工校验）：`id` 唯一、`platform` 合法、`steps/expect` 非空。
   - 写 `docs/ui-scenarios/<feature_id>.scenarios.yaml`。
   - 更新 `stages.create_ui_scenarios`：`status=completed`、每 feature 的 `hash`、`scenarios_count`。

#### 输出

| 路径 | 说明 |
| --- | --- |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | 可执行 UI 场景（每 feature 一文件） |
| `.pipeline/stages.json` | `stages.create_ui_scenarios` 完成态 |

#### 解锁

`stages.create_ui_scenarios.status=completed` → 可运行 `codegen`。

---

### codegen.cjs — stage: `codegen`

#### 上游门闸

`stages.design_review.can_enter_codegen=true` **且** `stages.create_ui_scenarios.status=completed`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/designs/<feature_id>.design.json` | 代码生成依据（file_plan、api_outline、acceptance） |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | 已生成的 UI 场景，供 Agent 理解验收边界 |
| `review.phase_plan` | feature_id 列表；支持 `--feature=<id>` 过滤单个 |
| 环境变量 `AI_STD3_AGENT_BIN` | 外部 Agent 路径（如 `cursor-agent`） |

**增量**：若 `stages.codegen.features[feature_id].status=completed` 且 design.json SHA-256 未变，跳过该 feature。

#### 处理逻辑

1. **脚本（脚手架）**：按 `file_plan.new_files` 建立空文件与目录骨架；初始化 git worktree（`features/v3-<feature_id>`）。
2. **Agent（实现相）**：在 worktree 内按 `prompts/codegen-impl.md` 实现代码：
   - 遵守 `file_plan` 边界，不随意新增文件。
   - API 端点与 `api_outline` 一致。
   - 实现内嵌基础测试（单元 + 集成，**无独立 test stage 门闸**，但 Agent 须自我校验）。
   - 超时由 `docs/config.dev.json.timeouts.stages.codegen_s`（默认 1800 s）控制，带心跳。
3. **脚本（commit + 状态写入）**：
   - `git add -A && git commit`（feature 分支）。
   - 写 `stages.codegen.features[feature_id]`：`status=completed`、`commit`、`files_changed[]`、`design_hash`。
   - 所有 feature 完成后写 `stages.codegen.status=completed`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/worktrees/v3-<feature_id>/` | 每 feature 的 git worktree（代码 + 测试） |
| `.pipeline/stages.json` | `stages.codegen` 完成态，per-feature 状态 |

#### 解锁

`stages.codegen.status=completed` → 可运行 `code-review`。

---

### code-review.cjs — stage: `code-review`

> typecheck 和独立 test 阶段已移除；代码质量门闸由本 stage 承担。

#### 上游门闸

`stages.codegen.status=completed`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| worktree 代码变更集 | `stages.codegen.features[].files_changed[]` |
| `docs/designs/<feature_id>.design.json` | 对照 api_outline、acceptance 做一致性检查 |
| 可选 **Agent 产出评审 JSON** | `AI_STD3_CODE_REVIEW_JSON` 或 `--code-review-json=` |

Agent 产出 JSON 字段：

```json
{
  "decision": "passed | passed_with_warnings | failed",
  "critical_issues": 0,
  "warnings": 0,
  "checklist": [
    { "item": "API 端点与 design.api_outline 一致", "status": "passed" }
  ]
}
```

#### 处理逻辑

1. **Agent（创造性评审）**：按 `prompts/code-review-agent.md` 审阅：
   - 代码与 `file_plan` 一致性（不能有超出 plan 的随意文件）。
   - API 实现与 `api_outline` 一致。
   - 验收条目（`acceptance[]`）是否有对应实现逻辑。
   - 基础安全（硬编码密钥、SQL 注入等）。
2. **脚本（validate + write）**：
   - Ajv 校验 JSON 格式。
   - `critical_issues > 0` 或 `decision=failed` → `stages.code_review.status=failed`，退出码 **4**（需 Agent 修 codegen 后重跑）。
   - 否则写 `stages.code_review`：`status=completed`、`outputs.decision`、`inputs.summary_hash`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | `stages.code_review`：`decision`、`critical_issues`、`checklist[]` |

#### 解锁

`stages.code_review.status=completed` 且 `decision` ≠ `failed` → 可运行 `merge_push`。

---

### merge_push.cjs — stage: `merge_push`

#### 上游门闸

`stages.code_review.status=completed` 且 `outputs.decision ≠ failed`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `stages.codegen.features[]` | 每个 feature 的 worktree 路径与 feature 分支名 |
| `docs/config.dev.json` | `git.default_branch`（默认 `main`）、`git.remote`（默认 `origin`） |

#### 处理逻辑

1. **脚本**：
   - 获取 PID 锁（`merge_push`）防止并发。
   - 对每个 feature 分支（`features/v3-<feature_id>`）：
     - `git fetch origin`。
     - `git checkout <default_branch> && git pull`。
     - `git merge --no-ff features/v3-<feature_id> -m "feat(<feature_id>): merge codegen implementation"`。
     - 若 merge 冲突 → 写 `stages.merge_push.outputs.conflict_features[]`，退出码 **4**（需人工解决后重跑）。
   - 所有 feature 合并完成后 `git push origin <default_branch>`。
   - 若 push 失败（远程有新提交） → `git pull --rebase` 后重试；仍失败 → 退出码 **7**（push failed）。
   - 写 `stages.merge_push`：`status=completed`、`outputs.merged_features[]`、`outputs.target_branch`、`outputs.final_commit`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| git 主干 | 所有 feature 分支已合并并推送 |
| `.pipeline/stages.json` | `stages.merge_push`：`target_branch`、`merged_features[]`、`final_commit` |

#### 解锁

`stages.merge_push.status=completed` → 可运行 `build`。

---

### build.cjs — stage: `build`

#### 上游门闸

`stages.merge_push.status=completed`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| 主干最新代码 | `stages.merge_push.outputs.final_commit` 对应 HEAD |
| `docs/config.dev.json` | `build.commands.build`（可按端分别配置）、`build.client_targets[]`、`timeouts.stages.build_s` |

#### 处理逻辑

1. 获取 PID 锁（`build`）。
2. 读 `config.dev.json.build.client_targets`（若空则取 `stages.prd.outputs.client_targets`）。
3. 对每个端执行对应构建命令（`runWithTimeout`）。
4. 汇总产物路径列表，按端写入 `stages.build.outputs.artifacts[]`（`client_target`、`artifact_path`、`status`）。
5. 任一端构建失败 → `status=failed`，退出码 **1**。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `dist/`（或配置路径） | 各端产物 |
| `.pipeline/stages.json` | `stages.build.outputs.artifacts[]`、`status` |

#### 解锁

`stages.build.status=completed` → 可运行 `deploy`。

---

### deploy.cjs — stage: `deploy`

#### 上游门闸

`stages.build.status=completed`。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `stages.build.outputs.artifacts[]` | 产物路径 |
| `docs/config.dev.json` | `deploy.enabled`、`deploy.provider`、服务映射 |
| `docs/config.env` | 云平台凭证（不进 git） |

**Destructive 保护**：autorun 路径须 `config.dev.json.pipeline.autorun.allow_destructive_deploy=true`；手工路径须 `--explicit-confirm`；两者均缺 → 退出码 **1**。

#### 处理逻辑

1. 若 `deploy.enabled=false` → 写 `stages.deploy.status=skipped`，退出 0（smoke 仍可用配置 URL 运行）。
2. 否则按 provider（cloudflare/manual/…）执行部署（带 PID 锁、超时、心跳）。
3. 部署成功后把各端 URL 写入 `stages.deploy.outputs.services[]`，供 smoke/ui_e2e 解析。

#### 输出

| 位置 | 说明 |
| --- | --- |
| 线上/本地服务 | 依 provider |
| `.pipeline/stages.json` | `stages.deploy`：`environment=dev`、`outputs.services[]`（url、version） |

#### 解锁

`stages.deploy.status=completed` 或 `skipped` → 可运行 `smoke`。

---

### smoke.cjs — stage: `smoke`

#### 上游门闸

`stages.deploy.status=completed` 或 `skipped`（skipped 时 `smoke.checks[]` 须含完整 URL，不能有 `{deploy.*}` 未解析的占位符）。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/config.dev.json` | `smoke.checks[]`（含 url、method、expected_status，可选 body_contains） |
| `stages.deploy.outputs.services[]` | 解析 `{deploy.services.*.url}` 占位符 |

#### 处理逻辑

1. 合并 config smoke checks 列表（没有 OpenAPI `x-smoke` 机制，直接用 config）。
2. 对每条 check 发 HTTP 请求（GET/HEAD 或标注 `safe=true` 的 POST），校验：
   - 状态码 == `expected_status`（默认 200）。
   - 若 check 含 `body_contains`：校验响应体包含该字符串。
3. 写 `stages.smoke.outputs.checks[]`（url、status_code、passed、body_snippet）。
4. 任一 check 失败 → `stages.smoke.status=failed`，退出码 **4**；超时 → 退出码 **3**。
5. 全部通过 → `status=completed`、`validation.passed=true`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/stages.json` | `stages.smoke`：`checks[]` 结果、`validation.passed` |

#### 解锁

`stages.smoke.status=completed` 且 `validation.passed=true` → 可运行 `ui_e2e`（若启用）；否则直接可运行 `report`。

---

### ui_e2e.cjs — stage: `ui_e2e`

#### 上游门闸

`stages.smoke.validation.passed=true`（或 `ui_e2e.require_smoke_passed=false`）**且** `config.dev.json.ui_e2e.enabled=true`。

若 `ui_e2e.enabled=false` → 整段 skip，退出 0。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | `create-ui-scenarios` 阶段产出 |
| `stages.deploy.outputs.services[]` | 解析 `{base_url}` 占位符 |
| `docs/config.dev.json` | `ui_e2e.web.*.base_url_from`、`ui_e2e.mobile.*`（设备/bundle_id） |
| MCP | website/admin → **Browser MCP**；mobile → **Dart MCP** / `integration_test` |

#### 处理逻辑

1. **脚本（preflight）**：解析每个 feature 的 scenarios，替换 `{base_url}` / `{test_user}`；验证 MCP 可用。
2. **Agent + MCP**：按场景执行：
   - web：Browser MCP 执行 `steps[]`，校验 `expect[]`（`text_present`、`url_contains`、`element_present`）。
   - mobile：Dart MCP 启动 app，执行 `steps[]`，校验 `expect[]`。
   - 截图写 `.agent-sessions/ui-test/<feature_id>/<timestamp>.jpg`，操作记录写 `.agent-sessions/ui-test/<feature_id>/<timestamp>.log`（人话格式）。
3. **修复环**：单场景失败后最多重试 `ui_e2e.commands.ui_test_max_fix_attempts`（默认 3）次；超过则标该场景 `failed`。
4. **脚本（write）**：写 `stages.ui_e2e`：`status=completed|failed`、`outputs.scenarios[]`（id、passed、fix_attempts）、`outputs.report_path`。生成 `.pipeline/reports/ui-e2e-<session>.md`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/reports/ui-e2e-<session>.md` | 场景级报告 |
| `.agent-sessions/ui-test/<feature_id>/` | 截图 + 人话操作日志 |
| `.pipeline/stages.json` | `stages.ui_e2e`：每场景结果 |

#### 解锁

`stages.ui_e2e.status=completed` 或 `skipped` → 可运行 `report`。

---

### report.cjs — stage: `report`

#### 上游门闸

pipeline 执行到末尾（无论成功/失败均运行，`--failure-reason=` 传入失败原因）。

#### 输入

| 来源 | 要求 |
| --- | --- |
| `.pipeline/stages.json` | 所有 stage 的 `status` / `validation` / `outputs` |
| `--session-id=`、`--failure-reason=` | 由 `run-pipeline.cjs` 传入 |

#### 处理逻辑

1. **脚本**：推导 `overall`：
   - 任一核心 stage（prd→ui_e2e）`status=failed` → `failed`
   - `merge_push.outputs.conflict_features` 非空 → `blocked`
   - 全部 `completed` 或 `skipped` → `success`
   - 否则 `partial`
2. 生成 `.pipeline/reports/autorun-<session_id>.md`（Markdown）：overall、各 stage 摘要表、feature 覆盖列表、失败原因（若有）。
3. 写 `stages.report`：`status=completed`、`outputs.overall`、`outputs.report_path`。

#### 输出

| 位置 | 说明 |
| --- | --- |
| `.pipeline/reports/autorun-<session_id>.md` | 最终报告 |
| `.pipeline/stages.json` | `stages.report.outputs.overall` |

---

## 2. 门闸链汇总

| stage | 前置条件（缺失则退出码 1 或 4） |
| --- | --- |
| setup | — |
| prd | `verify-req` 退出 0 |
| prd-review | `stages.prd.status=completed` |
| design | `stages.prd_review.decision=passed` |
| design-review | `stages.design.status=completed` |
| create-ui-scenarios | `stages.design_review.can_enter_codegen=true` |
| codegen | `stages.design_review.can_enter_codegen=true` **且** `stages.create_ui_scenarios.status=completed` |
| code-review | `stages.codegen.status=completed` |
| merge_push | `stages.code_review.decision ≠ failed` |
| build | `stages.merge_push.status=completed` |
| deploy | `stages.build.status=completed` |
| smoke | `stages.deploy.status ∈ {completed, skipped}` |
| ui_e2e | `stages.smoke.validation.passed=true`（或配置跳过）且 `ui_e2e.enabled=true` |
| report | 无（总是运行） |

---

## 3. `run-pipeline.cjs` 编排映射

| stage | 脚本 |
| --- | --- |
| setup | `scripts/setup-inputs.cjs` + `scripts/verify-inputs.cjs` + `scripts/sync-config-env.cjs` |
| prd | `scripts/lib/prd.cjs` |
| prd-review | `scripts/lib/prd-review.cjs` |
| design | `scripts/lib/design.cjs` |
| design-review | `scripts/lib/design-review.cjs` |
| create-ui-scenarios | `scripts/lib/create-ui-scenarios.cjs` |
| codegen | `scripts/lib/codegen.cjs` |
| code-review | `scripts/lib/code-review.cjs` |
| merge_push | `scripts/lib/merge-push.cjs` |
| build | `scripts/lib/build.cjs` |
| deploy | `scripts/lib/deploy.cjs` |
| smoke | `scripts/lib/smoke.cjs` |
| ui_e2e | `scripts/lib/ui-e2e.cjs` |
| report | `scripts/lib/report.cjs` |

`run-pipeline.cjs` 支持 `--from-stage=<stage> --to-stage=<stage>` 续跑，`--force-rerun=<stage>` 强制重跑单个 stage。

---

## 4. Agent 卡点速查

| 场景 | 退出码 | 处理方式 |
| --- | ---: | --- |
| `inputs/req.md` / `config.env` 未填完 | 2 | 用户补全后重跑 `--from-stage=setup` |
| prd-spec 不符合 schema / 需求变更 | 4 | Agent 按 `prompts/prd-spec-author.md` 更新，重跑 `--from-stage=prd` |
| 缺少 `prd-review-auto.json` | 4 | Agent 按 `prompts/prd-review.md` 产出，重跑 `--from-stage=prd-review` |
| prd-review `decision=failed` | 4 | Agent 改 PRD，重跑 `--from-stage=prd` |
| design.json 校验失败 | 4 | Agent 修 design，重跑 `--from-stage=design` |
| 缺少 `design-review-auto.json` | 4 | Agent 按 `prompts/design-review.md` 产出，重跑 `--from-stage=design-review` |
| design-review `blocking` gap | 4 | Agent 改 design，重跑 `--from-stage=design` |
| UI 场景 schema 校验失败 | 4 | Agent 修 scenarios，重跑 `--from-stage=create-ui-scenarios` |
| codegen Agent 超时 | 3 | 调大 `timeouts.stages.codegen_s`，重跑 `--from-stage=codegen --feature=<id>` |
| code-review `critical_issues > 0` | 4 | Agent 修代码，重跑 `--from-stage=codegen --force-rerun=codegen` |
| merge_push 冲突 | 4 | 人工解冲突后重跑 `--from-stage=merge_push` |
| merge_push push 失败 | 7 | 网络/权限问题，修复后重跑 `--from-stage=merge_push` |
| build 失败 | 1 | 修配置/代码，重跑 `--from-stage=build` |
| deploy 未授权 destructive | 1 | 配置 `allow_destructive_deploy=true` 或加 `--explicit-confirm` |
| smoke 检查失败 | 4 | 检查部署状态，修复后重跑 `--from-stage=smoke` |
| ui_e2e 场景失败 | 4 | 修 UI 或场景步骤，重跑 `--from-stage=ui_e2e` |

---

## 5. prompts 文件清单（待建）

| prompt | 被哪个 stage 调用 | 职责 |
| --- | --- | --- |
| `prompts/prd-spec-author.md` | prd | 从 req.md 撰写 prd-spec + 各端文档 |
| `prompts/prd-review.md` | prd-review | 评审 PRD，产出分期 JSON |
| `prompts/design-spec.md` | design | 产出 design.json |
| `prompts/design-review.md` | design-review | 评审 design.json，产出评审 JSON |
| `prompts/create-ui-scenarios.md` | create-ui-scenarios | 从 acceptance 派生 UI 场景 YAML |
| `prompts/codegen-impl.md` | codegen | worktree 内实现代码 + 自嵌测试 |
| `prompts/code-review-agent.md` | code-review | 评审代码，产出评审 JSON |
