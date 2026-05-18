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
    - 退出码：`0` 成功；`1` 前置/参数/脚本错误；`2` 用户中断/门闸需人工填写；`3` 超时；`4` 需 Agent 介入；`5` 用户主动停止（stop signal）；`7` push 失败
    - stage 状态值：`started` | `running`（Agent 处理中）| `completed` | `failed` | `skipped`
    - 路径占位符：`<client_target>` 表示某一端标识（如 `website`、`backend`、`mobile`）；全文统一使用此写法，**不使用** `<client_target>` 等简写

    **停止机制**：

    #### 停止信号文件

        流水线停止通过**信号文件**驱动，而非 OS 信号（因 Agent 是独立进程，无法可靠传递 SIGTERM）：

        ```
        <项目根>/.pipeline/stop.signal
        ```

        文件内容（JSON）：

        ```json
        {
          "requested_at": "2026-05-18 08:30:15 +0800",
          "reason": "user_request",
          "requested_by": "run-dash | stop-pipeline-cmd | user"
        }
        ```

    #### 信号检查点

        所有脚本在以下位置**必须**检查 `stop.signal` 是否存在，存在则立即执行优雅停止：

        | 检查位置 | 说明 |
        | --- | --- |
        | `run-pipeline.cjs` 每个 stage 启动前 | 不再进入下一 stage |
        | 每个 `lib/<stage>.cjs` 启动时 | 拒绝执行，直接退出码 `5` |
        | 每个 `lib/<stage>.cjs` 调用 Agent 前 | 不派发新 Agent，直接退出码 `5` |
        | Agent-B 每个并发任务启动前 | 已启动的并发 Agent 等其自然完成，不再起新的 |

    #### 优雅停止流程

        1. 检测到 `stop.signal` → 写日志事件 `pipeline_stop`（INFO）
        2. 若当前有 Agent 正在运行（`status=running`）：等待当前 Agent 完成当前步骤（**不强杀**），然后不写 `completed`，写 `status=stopped`
        3. 若当前 stage 为 `setup` / `prd`（无破坏性操作）：直接中止，退出码 `5`
        4. 若当前 stage 为 `codegen` / `merge_push` / `deploy`（有破坏性操作）：完成当前原子操作后中止，在日志中记录中止位置
        5. 写 `pipeline.stop_info`：`{ "stopped_at": "<本地时间>", "stopped_stage": "<stage>", "reason": "<reason>" }`
        6. 删除 `stop.signal` 文件（避免下次重跑被误拦截）
        7. 退出码 `5`

    **通用日志规范**：

    #### 日志文件路径

        | 文件 | 写入时机 | 说明 |
        | --- | --- | --- |
        | `<项目根>/logs/<datetime>.log` | 全程追加 | 本次执行的流式总日志，跨所有 stage |
        | `<项目根>/logs/stages/<stage>/<datetime>.log` | stage 运行期间追加 | 该 stage 所有日志，含 Agent 调用细节 |
        | `<项目根>/logs/features/<feature_id>/<datetime>.log` | codegen / code-review / ui_e2e 期间 | 每个 feature 独立日志，供 report 按 feature 分析 |

        `<datetime>` = 本次流水线启动的**本地时间**，格式 `YYYY-MM-DD_HH-mm-ss`（如 `2026-05-18_08-30-15`）。同一次执行所有日志文件共用同一 `<datetime>` 前缀，方便关联。

    #### 日志行格式

        每行为一条结构化记录（方便 report 脚本用 JSON.parse 逐行读取）：

        ```
        [本地时间 YYYY-MM-DD HH:mm:ss.SSS Z] [LEVEL] [<stage>] <event> | <human message> | <JSON meta>
        ```

        | 字段 | 说明 |
        | --- | --- |
        | **本地时间** | 必须使用系统本地时区（`new Date().toLocaleString('zh-CN', {timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone})`），**禁止使用 UTC** |
        | **LEVEL** | `INFO` / `WARN` / `ERROR` / `DEBUG` |
        | **stage** | 当前 stage 名称（如 `setup`、`prd`、`codegen`） |
        | **event** | 标准化事件类型（见下表），report 阶段按 event 聚合分析 |
        | **human message** | 可读描述，中文或英文均可 |
        | **JSON meta** | 事件附属数据，必须是合法单行 JSON，不可省略（无额外数据时写 `{}` ） |

    #### 标准事件类型（所有 stage 通用）

        | event | LEVEL | 触发时机 | meta 必填字段 |
        | --- | --- | --- | --- |
        | `stage_start` | INFO | stage 脚本启动 | `run_id`, `stage`, `project`, `started_at`（本地时间字符串） |
        | `stage_complete` | INFO | stage 成功退出 | `stage`, `duration_ms`, `exit_code: 0` |
        | `stage_failed` | ERROR | stage 异常退出 | `stage`, `exit_code`, `reason`, `duration_ms` |
        | `stage_skipped` | INFO | hash 门控命中，跳过 | `stage`, `reason` |
        | `hash_check` | INFO | 计算并比对输入哈希 | `file`, `stored_hash`, `computed_hash`, `hit`（bool） |
        | `file_created` | INFO | 脚本新建文件 | `path`, `size_bytes`, `from_template`（bool） |
        | `file_updated` | INFO | 脚本更新文件 | `path`, `size_bytes` |
        | `file_skipped` | INFO | 文件已存在，跳过拷贝 | `path` |
        | `validation_pass` | INFO | 校验通过 | `checks`, `warnings[]` |
        | `validation_fail` | ERROR | 校验未通过 | `missing[]`, `invalid[]` |
        | `agent_batch_start` | INFO | 并发 Agent 批次开始 | `batch_id`, `stage`, `client_targets[]`, `agents_total` |
        | `agent_batch_complete` | INFO | 并发 Agent 批次结束 | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
        | `agent_start` | INFO | 启动 Agent 调用 | `agent_id`, `prompt`, `input_files[]`, `model`；并发场景另含 `client_target` |
        | `agent_complete` | INFO | Agent 调用结束 | `agent_id`, `duration_ms`, `output_files[]`；并发场景另含 `client_target`, `decision` |
        | `agent_skipped` | INFO | 单端哈希命中，跳过该 Agent | `agent_id`, `client_target`, `reason` |
        | `agent_retry` | WARN | Agent 校验失败，触发重试 | `agent_id`, `attempt`（1-based）, `reason`；并发场景另含 `client_target` |
        | `agent_failed` | ERROR | Agent 超过重试次数或单端失败 | `agent_id`, `max_attempts`, `last_error`；并发场景另含 `client_target` |
        | `git_commit` | INFO | git commit 完成 | `branch`, `commit_hash`, `files_changed` |
        | `git_push` | INFO | git push 完成 | `remote`, `branch`, `status` |
        | `git_push_failed` | ERROR | git push 失败 | `remote`, `branch`, `error`, `exit_code: 7` |
        | `pipeline_stop` | INFO | 检测到 stop.signal，开始优雅停止 | `stage`, `reason`, `current_agent_id`（若有）, `stopped_at`（本地时间） |
        | `pipeline_stopped` | INFO | 优雅停止完成 | `stage`, `stopped_at`（本地时间）, `exit_code: 5` |

    ---

## 1. stage 实现规范（人话版）

    每节结构：**上游门闸 → 输入 → 处理逻辑（脚本做什么 / Agent 做什么）→ 输出 → 下游解锁条件**。
    ---

### setup — stage: `setup`

    **脚本**：`setup.cjs`、`setup-inputs.cjs`、`verify-inputs.cjs`、`sync-config.cjs`、`register-project.cjs`（已存在，保持现有实现）

    #### 输入

    | 来源 | 要求 |
    | --- | --- |
    | `ai-std3/docs/templates/req-template.md` | 模板；若 `inputs/req.md` 不存在则拷贝 |
    | `ai-std3/docs/templates/config.env.template` | 模板；若 `inputs/config.env` 不存在则拷贝 |

    #### 处理逻辑

    1. `setup-inputs.cjs`：拷贝模板到 `<业务项目根绝对路径>/inputs/`；已存在则跳过。
    2. `verify-inputs.cjs`：检查 `<业务项目根绝对路径>/inputs/req.md` 所有带 `*` 的 H2 节是否非空；检查 `<业务项目根绝对路径>/inputs/config.env` 的 `CLOUD_PROVIDER` 与对应密钥变量非空；后续可扩展校验其它 `<业务项目根绝对路径>/inputs/` 下文件。未通过 → 退出码 **2**，列出缺失项等用户补全。
    3. `sync-config.cjs`：将 `<业务项目根绝对路径>/inputs/config.env` 内容写入 `<业务项目根绝对路径>/docs/config.env`（覆盖）, 把云平台配置同步到业务项目根目录下`<业务项目根绝对路径>/docs/config.<dev|release>.json`, 若该文件不存在，则从`ai-std3/docs/templates/config.json.template`中拷贝后再填入。
    4. `register-project.cjs`：注册业务项目到`<skills_root>/_projects/<project_name>/runtime.json`文件，若项目已存在，则更新项目信息。
    5. setup.cjs: 
        5.1 初始化业务项目根目录下`<业务项目根绝对路径>/.pipeline/stages.json`文件，若该文件不存在，则从`ai-std3/docs/templates/stages.json.template`中拷贝后再填入：
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
        },
        "stages": {
            "setup": {
            "status": "started",
            "started_at": <当前时间戳>,
            "inputs": {
                "source_prd_spec": "<业务项目根绝对路径>/inputs/req.md",
                "summary_hash": "<业务项目根绝对路径>/inputs/req.md 文件的SHA-256哈希",
                "raw_input_refs": []
            }
        }
        ```     
        5.2 调用脚本：setup-inputs.cjs、verify-inputs.cjs、sync-config.cjs、register-project.cjs，若全部退出 0，则继续执行下一步，否则退出码 **2**，列出缺失项等用户补全。
        5.3 增量写入`<业务项目根绝对路径>/.pipeline/stages.json`文件:
        ```json
        {
        "stages": {
            "setup": {
            "status": "completed",
            "completed_at": <当前时间戳>,
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
        
    #### 日志事件（setup）

        | 步骤 | event | LEVEL | 关键 meta 字段 |
        | --- | --- | --- | --- |
        | stage 启动 | `stage_start` | INFO | `run_id`, `project`, `started_at`（本地时间） |
        | 步骤1：拷贝模板 | `file_created` / `file_skipped` | INFO | `path`, `from_template: true` |
        | 步骤2：校验输入 | `validation_pass` / `validation_fail` | INFO/ERROR | `missing[]`（未填的 `*` 节或缺失密钥） |
        | 步骤3：同步 config | `file_created` / `file_updated` | INFO | `path`（config.dev.json / config.release.json） |
        | 步骤4：注册项目 | `file_created` / `file_updated` | INFO | `path`（runtime.json）, `project_id` |
        | 步骤5.1：初始化 stages.json | `file_created` / `file_skipped` | INFO | `path`（stages.json）, `from_template: true` |
        | 步骤5.3：写完成态 | `file_updated` | INFO | `path`（stages.json）, `status: "completed"` |
        | stage 完成 | `stage_complete` | INFO | `duration_ms`, `exit_code: 0` |
        | 任意步骤失败 | `stage_failed` | ERROR | `step`（如 `"verify-inputs"`）, `exit_code`, `reason` |

    #### 输出

    `setup.cjs`退出 0 即视为 setup 通过，`<业务项目根绝对路径>/.pipeline/stages.json`文件已更新, `<skills_root>/_projects/<project_name>/runtime.json`文件已更新。
    ```json
    {
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
    ```

    #### 解锁

    `stages.setup.status=completed` → 可运行 `prd`。

    ---

### prd.cjs — stage: `prd`

    **脚本**：`prd.cjs`（编排器）、`prd-bootstrap.cjs`（步骤1）、`prd-validate.cjs`（步骤4）

    #### 上游门闸

    setup 通过（`stages.setup.status=completed`）且 `stages.setup.validation.passed=true`。

    #### 输入

        | 来源 | 要求 |
        | --- | --- |
        | `<业务项目根绝对路径>/inputs/req.md` | 必填项已齐全 |
        | `<业务项目根绝对路径>/docs/config.env` | 云平台鉴权 |
        | `<业务项目根绝对路径>/docs/config.<dev|release>.json` | 云平台部署配置 |
        | `<业务项目根绝对路径>/.pipeline/stages.json` | setup stage 的输出 |

    #### 处理逻辑

        1. **`prd-bootstrap.cjs`（bootstrap）**：
            - 判断 `<业务项目根绝对路径>/.pipeline/stages.json` 文件的 `stages.prd` 的骨架是否存在，
            若不存在，则根据`<skills_root>/ai-std3/docs/templates/stages.json.template`初始化：
            ```json
            {
                "status": "started",
                "started_at": <当前时间戳>,
                "completed_at": null,
                "inputs": {
                    "req_hash": null,
                    "prd_spec_hash": null,
                    "source_req": "<业务项目根绝对路径>/inputs/req.md",
                    "raw_input_refs": []
                },
                "outputs": {
                    "config_dev": null,
                    "config_release": null,
                    "config_env": null,
                    "client_targets": [],
                    "features": [],
                    "duration_ms": null,
                    "timed_out": false,
                    "timeout_reason": null
                },
                "validation": {
                    "passed": false,
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
            ```
            若存在，则调用脚本 `check_hash.cjs`：计算 `<业务项目根绝对路径>/inputs/req.md` 的 SHA-256 并与 `stages.prd.inputs.req_hash` 比对；若哈希一致且 `stages.prd.status=completed`，则**同时跳过步骤 2（Agent-A）和步骤 3（Agent-B）**，直接进入步骤 4（脚本校验）；否则继续执行步骤 2。

            - 判断 `<业务项目根绝对路径>/docs/prd-spec.md` 文件是否存在，若不存在，从模板 `ai-std3/docs/templates/prd-spec.md.template` 中拷贝后再填入。

        2. **Agent-A（补全 prd-spec，单次调用）**：脚本写 `stages.prd.status=running` 后启动，按 `ai-std3/prompts/prd-spec-author.md` 提示词执行：
            - 同时精读 `<业务项目根绝对路径>/inputs/req.md`（需求原文）与已存在的 `<业务项目根绝对路径>/docs/prd-spec.md`（现有草稿，若为空模板则视为全新），**增量补全** prd-spec，产出 **`<业务项目根绝对路径>/docs/prd-spec.md`**（中文、含 `## 客户端目标` 列表与 `## 核心功能` 表）。
            - Agent-A 完成后退出；脚本从 prd-spec.md 解析 `client_targets[]` 列表，准备并发调用 Agent-B。

        3. **Agent-B（各端 prd.json，每端一个 Agent 并发）**：脚本按 `client_targets[]` 同时启动 N 个 Agent，每个 Agent 仅处理自己的端，按 `ai-std3/prompts/prd-client-author.md` 提示词执行：
            - 精读 `<业务项目根绝对路径>/docs/prd-spec.md` 与当前端的 `<业务项目根绝对路径>/docs/prd-<client_target>.json`（若文件不存在，脚本预先从 `ai-std3/docs/templates/prd-<client_target>.json.template` 拷贝，若该端无专属模板则退化到 `prd-default.json.template`），**增量补全**该端的 prd.json，字段：

                > **`feature_id` 命名规则**（与 v3 prd-spec 保持一致）：
                >
                > | 场景 | 格式 | 第一段规则 | 示例 |
                > | --- | --- | --- | --- |
                > | **单端 feature**（只涉及一个 client target） | `<TARGET>-<AREA>-NNN` | 用**端名前缀**（`WEB`、`ADMIN`、`BACKEND`、`MOB`） | `WEB-AUTH-001`、`BACKEND-NOTE-001` |
                > | **跨端 feature**（涉及多个 client target） | `<DOMAIN>-<AREA>-NNN` | 用**业务领域词**（`AUTH`、`ORDER`、`NOTE`、`BILLING`），**禁止**用端名 | `AUTH-LOGIN-001`、`NOTE-CRUD-001` |
                >
                > - `NNN`：三位数字序号，从 `001` 递增，项目内全局唯一
                > - 全大写，段间用 `-` 分隔；`<AREA>` 可省略为两段（如 `AUTH-001`，但三段可读性更好）
                > - 同一 `feature_id` 跨端一致，不得在不同端的 `prd-*.json` 中出现同义但不同名的 ID

                ```json
                {
                "client_target": "website",
                "project_name": "...",
                "features": [
                    {
                    "feature_id": "AUTH-LOGIN-001",
                    "name": "用户登录/注册",
                    "priority": "P0",
                    "phase": "mvp",
                    "description": "...",
                    "acceptance": ["..."],
                    "api_calls": ["POST /api/auth/login"]
                    },
                    {
                    "feature_id": "WEB-HOME-001",
                    "name": "首页展示",
                    "priority": "P1",
                    "phase": "mvp",
                    "description": "...",
                    "acceptance": ["..."],
                    "api_calls": ["GET /api/notes"]
                    }
                ],
                "deploy": { "domain": "...", "service_type": "..." },
                "auth": { "type": "jwt|session|none", "notes": "..." },
                "constraints": ["..."]
                }
                ```
            - 同时产出 **`<业务项目根绝对路径>/docs/feature_list-<client_target>.md`**（Markdown 表，每行一个 feature_id，含名称、优先级、阶段）。
            - 若该端为后端（backend/api），同时解析域名/部署要求，填写 `<业务项目根绝对路径>/docs/config.dev.json` 的 `domain`、`deploy.services[]`、`smoke.checks[]` 初稿。
            - 所有 Agent-B 全部完成后，脚本继续执行步骤 4。

            > **稳定性保障（防止每次 Agent 输出漂移）**：
            >
            > | 机制 | 作用于 | 说明 |
            > | --- | --- | --- |
            > | **输入哈希门控** | Agent-A / Agent-B | 启动 Agent-A 前：`req.md` SHA-256 与 `stages.prd.inputs.req_hash` 比对，命中且 `prd-spec.md` 已存在则**跳过 Agent-A**；启动各端 Agent-B 前：`prd-spec.md` SHA-256 与 `stages.prd.inputs.prd_spec_hash` 比对，且该端 `docs/prd-<client_target>.json` 与 `docs/feature_list-<client_target>.md` 均已存在时，**跳过该端 Agent-B**（写 `agent_skipped`）；全部端均跳过时直接进入步骤 4 |
            > | **增量写保护** | Agent-A / Agent-B | Prompt 模板明确要求：**只填写占位符或新增缺失字段，禁止删除或修改已有非空内容**；Agent 产出后由脚本做 diff，若发现已有非空字段被清空则拒绝写入并重试 |
            > | **Schema 强校验 + 重试** | Agent-B | 每个端的 prd.json 产出后立即用 Ajv 校验 schema（必填字段、类型、`features[]` 非空）；校验失败则带错误提示**重试该端 Agent，最多 2 次**；仍失败退出码 **4** |
            > | **Prompt 输出格式锁定** | Agent-A / Agent-B | 提示词模板末尾附 `## 输出约束` 节，逐字要求输出格式（文件路径、必填节名称、JSON 字段名），Agent 不得自行增删顶层结构 |

        4. **`prd-validate.cjs`（validate + write）**：
            - 校验 `docs/prd-spec.md` 存在、含 `## 客户端目标` H2、每个 `client_target` 对应的 `docs/prd-<client_target>.json` 与 `docs/feature_list-<client_target>.md` 存在。
            - 校验 `docs/config.dev.json` 存在且合法 JSON，无明文密钥（forbidden key 扫描）。
            - **聚合 features**：遍历所有 `docs/prd-<client_target>.json`，将各端 `features[]` 按 `feature_id` 去重合并，构建跨端特性索引，每条记录格式：
                ```json
                {
                "feature_id": "AUTH-LOGIN-001",
                "name": "用户鉴权",
                "priority": "P0",
                "phase": "mvp",
                "client_targets": ["backend", "website", "mobile"]
                }
                ```
                同一 `feature_id` 在不同端出现时：`priority` 取最高级（P0 > P1 > P2 > P3），`phase` 以**最先可交付**的端为准，`client_targets` 取并集；`name`/`description` 取首次出现值。
            - 通过后写 `stages.prd`：`status=completed`、`validation.passed=true`、`inputs.req_hash`（req.md 哈希）、`inputs.prd_spec_hash`（prd-spec.md 哈希）、`outputs.client_targets[]`、`outputs.features[]`（跨端聚合结果）。
            - 可选 git commit+push（若 `config.dev.json.git.auto_commit=true`）。

    #### 日志事件（prd）

        > 步骤 3 **Agent-B 按端并发**时：须先打 `agent_batch_start`，每端各打一行 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`（`agent_id` 与 `client_target` 一一对应），批次结束打 `agent_batch_complete`，便于 `run-dash` 按端过滤与排障。

        | 步骤 | event | LEVEL | 关键 meta 字段 |
        | --- | --- | --- | --- |
        | stage 启动 | `stage_start` | INFO | `run_id`, `project`, `started_at`（本地时间） |
        | 步骤1：初始化骨架 | `file_created` / `file_skipped` | INFO | `path`（stages.json 中 stages.prd）, `from_template: true` |
        | 步骤1：req 哈希比对 | `hash_check` | INFO | `file`（req.md）, `stored_hash`, `computed_hash`, `hit`, `skip_agent_a`（bool） |
        | 步骤1：整体跳过（req 未变且已完成） | `stage_skipped` | INFO | `reason: "req_hash matched, status=completed"` |
        | 步骤1：拷贝 prd-spec 模板 | `file_created` / `file_skipped` | INFO | `path`（prd-spec.md）, `from_template: true` |
        | 步骤2：写 running | `file_updated` | INFO | `path`（stages.json）, `status: "running"` |
        | 步骤2：Agent-A 启动 | `agent_start` | INFO | `agent_id: "prd-agent-a"`, `prompt: "prd-spec-author.md"`, `input_files: ["req.md","prd-spec.md"]` |
        | 步骤2：Agent-A 跳过 | `agent_skipped` | INFO | `agent_id: "prd-agent-a"`, `reason: "req_hash matched, prd-spec exists"` |
        | 步骤2：Agent-A 完成 | `agent_complete` | INFO | `agent_id: "prd-agent-a"`, `duration_ms`, `output_files: ["prd-spec.md"]`, `client_targets_parsed[]` |
        | 步骤2：Agent-A 失败 | `agent_failed` | ERROR | `agent_id: "prd-agent-a"`, `exit_code: 4`, `reason` |
        | 步骤2：prd-spec 哈希比对 | `hash_check` | INFO | `file`（prd-spec.md）, `stored_hash`, `computed_hash`, `hit`（相对 `prd_spec_hash`） |
        | 步骤3：并发批次开始 | `agent_batch_start` | INFO | `batch_id: "prd-agent-b"`, `client_targets[]`, `agents_total`, `agents_skipped[]` |
        | 步骤3：单端拷贝 prd 模板 | `file_created` / `file_skipped` | INFO | `client_target`, `path`（prd-<client_target>.json）, `from_template`（专属模板名或 `prd-default`） |
        | 步骤3：单端 Agent-B 启动 | `agent_start` | INFO | `agent_id: "prd-agent-b-<client_target>"`, `client_target`, `prompt: "prd-client-author.md"`, `input_files: ["prd-spec.md","prd-<client_target>.json"]`, `template`（所用 json.template 名） |
        | 步骤3：单端 Agent-B 跳过 | `agent_skipped` | INFO | `agent_id`, `client_target`, `reason: "prd_spec_hash matched, target files exist"` |
        | 步骤3：单端 schema 校验失败 | `agent_retry` | WARN | `agent_id`, `client_target`, `attempt`, `reason`, `invalid_fields[]`, `schema`（如 `prd-web.json.schema.json`） |
        | 步骤3：单端 diff 保护拒绝 | `agent_retry` | WARN | `agent_id`, `client_target`, `reason: "existing non-empty fields cleared"`, `cleared_fields[]` |
        | 步骤3：单端 Agent-B 完成 | `agent_complete` | INFO | `agent_id`, `client_target`, `duration_ms`, `output_files: ["prd-<client_target>.json","feature_list-<client_target>.md"]`, `features_count` |
        | 步骤3：单端 Agent-B 失败 | `agent_failed` | ERROR | `agent_id`, `client_target`, `max_attempts: 2`, `last_error`, `exit_code: 4` |
        | 步骤3：并发批次结束 | `agent_batch_complete` | INFO | `batch_id: "prd-agent-b"`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
        | 步骤3：backend 写 config.dev | `file_updated` | INFO | `client_target: "backend"`, `path`（config.dev.json）, `fields_written: ["domain","deploy.services","smoke.checks"]` |
        | 步骤4：校验通过 | `validation_pass` | INFO | `checks: ["prd-spec.md","prd-<client_target>.json×N","feature_list-<client_target>.md×N","config.dev.json"]` |
        | 步骤4：feature 聚合 | `file_updated` | INFO | `path`（stages.json `outputs.features`）, `features_total`, `client_targets[]` |
        | 步骤4：校验失败 | `validation_fail` | ERROR | `missing[]`, `invalid[]` |
        | 步骤4：写完成态 | `file_updated` | INFO | `path`（stages.json）, `status: "completed"`, `req_hash`, `prd_spec_hash`, `client_targets[]`, `features_total` |
        | stage 完成 | `stage_complete` | INFO | `duration_ms`, `client_targets[]`, `features_total` |
        | 任意步骤失败 | `stage_failed` | ERROR | `step`, `exit_code`, `reason`, `failed_client_target`（步骤3 失败时必填） |

    #### 输出

        | 路径 | 说明 |
        | --- | --- |
        | `docs/prd-spec.md` | PRD 总源头 |
        | `docs/prd-<client_target>.json` | 各端结构化 PRD（AI 直接消费） |
        | `docs/feature_list-<client_target>.md` | 特性表（feature_id、名称、优先级、阶段、涉及端） |
        | `docs/config.dev.json` | 部署/smoke 配置初稿 |
        | `.pipeline/stages.json` | `stages.prd` 完成态，含 `outputs.features[]`（跨端聚合） |

    #### 解锁

        `stages.prd.status=completed` → 可运行 `prd-review`。

    ---


### prd-review.cjs — stage: `prd-review`

    **脚本**：`prd-review.cjs`（编排器）、`prd-review-bootstrap.cjs`（步骤1）、`prd-review-validate.cjs`（步骤3）；步骤2 为各端 Agent **并发**调用

    **定位**：**AI 自动评审**（不设单独人工签审节点）。各端 Agent 独立产出 per-target JSON，脚本合并为全局 `prd-review-output.json` 并校验门闸后写入 `stages.prd_review`；人话结论写入 `.pipeline/reports/prd-implementation-summary.md`。

    #### 上游门闸

    `stages.prd.status=completed` 且 `stages.prd.validation.passed=true`，且 `stages.prd.outputs.features[]` 非空。

    #### 输入

        | 来源 | 要求 |
        | --- | --- |
        | `<业务项目根绝对路径>/docs/prd-spec.md` | PRD 总源头 |
        | `<业务项目根绝对路径>/docs/prd-<client_target>.json` | 各端结构化 PRD（`stages.prd.outputs.client_targets[]` 所列每一端） |
        | `<业务项目根绝对路径>/docs/feature_list-<client_target>.md` | 各端特性表（校验与报告展示用） |
        | `<业务项目根绝对路径>/.pipeline/stages.json` | `stages.prd.outputs.features[]`（跨端 feature 全集，评审覆盖门闸的真源） |
        | `<业务项目根绝对路径>/docs/config.dev.json` | 部署/流水线配置（仅非敏感字段，供评审引用） |

    #### 处理逻辑

        1. **`prd-review-bootstrap.cjs`（bootstrap）**：
            - 判断 `stages.prd_review` 骨架是否存在；若不存在则初始化：
                ```json
                {
                  "status": "started",
                  "started_at": <当前时间戳>,
                  "completed_at": null,
                  "inputs": {
                    "prd_spec_hash": null,
                    "requires_stage": "prd",
                    "source_prd_spec": "<业务项目根绝对路径>/docs/prd-spec.md",
                    "feature_index_ref": "stages.prd.outputs.features",
                    "per_target_hashes": {}
                  },
                  "outputs": {
                    "decision": "pending",
                    "can_enter_design": false,
                    "current_phase": null,
                    "duration_ms": null,
                    "timed_out": false,
                    "timeout_reason": null
                  },
                  "review": {
                    "summary": "",
                    "phase_plan": [],
                    "deferred_features": [],
                    "priority_changes": [],
                    "cross_phase_dependencies": [],
                    "config_change_suggestions": { "dev": [], "release": [] },
                    "suggested_prd_spec_changes": []
                  },
                  "blocking_issues": [],
                  "conditions": [],
                  "validation": {
                    "passed": false,
                    "checked_at": null,
                    "summary": null,
                    "required_files": [],
                    "missing_required_fields": [],
                    "warnings": []
                  }
                }
                ```
            - 调用 `check_hash.cjs`：计算 `docs/prd-spec.md` 的 SHA-256，与 `stages.prd_review.inputs.prd_spec_hash` 比对；若哈希一致且 `stages.prd_review.status=completed` 且 `outputs.decision=passed`，且各端 `per_target_hashes` 与当前各 `docs/prd-<client_target>.json` 一致，则**跳过步骤 2（全部各端 Agent）**，直接进入步骤 3；否则对需重评的端继续步骤 2。
            - 写 `stages.prd_review.status=running`。

        2. **Agent-Review（各端评审，每端一个 Agent 并发）**：脚本按 `stages.prd.outputs.client_targets[]` 同时启动 N 个 Agent；**每个 Agent 仅评审本端**，使用**该端专属提示词**（见下表），产出 **`<业务项目根绝对路径>/.pipeline/prd-review-<client_target>.json`**（Agent **不得**直接改写 `stages.json` 全文）。

            | 端标识 | 提示词模板 | 产出文件 |
            | --- | --- | --- |
            | `web` / `website` / `frontend` | `prompts/prd-review-web.md` | `.pipeline/prd-review-web.json`（或 `-website.json`，与 `client_target` slug 一致） |
            | `backend` / `server` / `api` | `prompts/prd-review-backend.md` | `.pipeline/prd-review-backend.json` |
            | `mobile` / `ios` / `android` | `prompts/prd-review-mobile.md` | `.pipeline/prd-review-mobile.json` |
            | `admin` | `prompts/prd-review-admin.md` | `.pipeline/prd-review-admin.json` |
            | 其余端 | `prompts/prd-review-default.md` | `.pipeline/prd-review-<client_target>.json` |

            **单端 Agent 输入**（每次调用仅读下列文件）：
            - `<业务项目根绝对路径>/docs/prd-spec.md`（全文，理解跨端背景）
            - `<业务项目根绝对路径>/docs/prd-<client_target>.json`
            - `<业务项目根绝对路径>/docs/feature_list-<client_target>.md`
            - `stages.prd.outputs.features[]` 中 **`client_targets` 含本端** 的条目（本端评审范围；不得评审与它端无关的 feature）

            **单端产出 JSON**（须满足 `ai-std3/docs/schemas/prd-review-client-output.schema.json`）示例：

            ```json
            {
              "client_target": "website",
              "review": {
                "summary": "本端 PRD 评审结论（中文）",
                "feature_assessments": [
                  {
                    "feature_id": "AUTH-LOGIN-001",
                    "phase": "mvp",
                    "disposition": "include",
                    "notes": "登录页与鉴权流程已对齐 prd-spec"
                  },
                  {
                    "feature_id": "WEB-HOME-001",
                    "phase": "standard",
                    "disposition": "defer",
                    "notes": "首页可延后至 standard"
                  }
                ],
                "deferred_features": [
                  { "feature_id": "WEB-HOME-001", "reason": "非 MVP 必需", "priority": "P2" }
                ],
                "blocking_issues": [],
                "suggested_prd_spec_changes": []
              },
              "outputs": {
                "decision": "passed",
                "features_reviewed": 2,
                "features_deferred": 1
              }
            }
            ```

            **单端 Agent 硬约束**：
            - **`disposition`**：`include`（纳入分期）| `defer`（明确延期）；本端可见的每个 feature 必须有且仅有一条 `feature_assessments` 记录。
            - **`phase`**：`mvp` | `standard` | `complete` | `future`（与 prd feature 枚举一致）；`disposition=include` 时必填。
            - **`feature_id`**：须出现在本端 `prd-<client_target>.json` 的 `features[]` 或 `outputs.features[]` 且 `client_targets` 含本端；命名符合 prd 阶段规则。
            - **禁止**：夹带密钥；改写 `prd-spec.md` / 各端 `prd-*.json` 正文（建议仅写入 `suggested_prd_spec_changes[]`）。
            - **`outputs.decision`**：`passed` 时本端 `blocking_issues` 为空；`failed` 时列出阻塞项。各端完成后由编排器等待全部 Promise  settle，再进入步骤 3。

            > **稳定性保障（各端 Agent）**：
            >
            > | 机制 | 说明 |
            > | --- | --- |
            > | **按端哈希门控** | 启动某端 Agent 前，计算 `docs/prd-<client_target>.json` 的 SHA-256 与 `stages.prd_review.inputs.per_target_hashes.<client_target>` 比对；若与上次评审一致且该端上次 `decision=passed`，则**跳过该端 Agent** |
            > | **Schema 强校验 + 重试** | 单端 JSON 产出后立即 Ajv 校验 `prd-review-client-output.schema.json`；失败则带错误重试该端，**最多 2 次**；仍失败则记该端 `failed`，整 stage 退出码 **4** |
            > | **Prompt 输出格式锁定** | 各端模板末尾附 `## 输出约束`，锁定 `feature_assessments[]` 字段名与 `disposition` 枚举 |

        3. **`prd-review-validate.cjs`（merge + validate + write）**：
            - **合并各端产出**：读取全部 `.pipeline/prd-review-<client_target>.json`，合成 **`<业务项目根绝对路径>/.pipeline/prd-review-output.json`**（全局形态，供门闸与 stages 消费）：
                - `review.summary`：按端拼接各端 `review.summary`（Markdown 小节标题为端名）。
                - `review.phase_plan[]`：将各端 `disposition=include` 的 feature 按 `phase` 分组；同一 `feature_id` 跨端出现时，`phase` 取**最先可交付**（`mvp` < `standard` < `complete` < `future`）；`goal` / `exit_criteria` 由脚本从各端 `notes` 与 `prd-spec.md` 提炼生成（每 phase 至少 1 条）。
                - `review.deferred_features[]`：合并各端 `defer` 项并去重；若某 feature 在一端 `include`、另一端 `defer`，记为**冲突**，`outputs.decision=failed`。
                - `outputs.decision`：仅当**所有端** `outputs.decision=passed` 且合并无冲突时为 `passed`。
                - `blocking_issues` / `conditions`：合并各端数组；全局 `passed` 时均为 `[]`。
            - 对合成后的 `prd-review-output.json` 用 Ajv 校验 `prd-review-output.schema.json`。
            - **覆盖门闸**：以 `stages.prd.outputs.features[].feature_id` 为全集：
                - 每个 id 须在 `phase_plan` 或 `deferred_features` 中出现且仅出现一次；
                - `phase_plan` 中每个 id 须存在于全集；
                - `phase_plan[*].phase` 须为合法枚举；
                - `phase_plan[*].feature_ids` 非空，`goal` / `exit_criteria` 非空。
            - **交叉校验**：各 `feature_id` 须能在至少一个 `docs/feature_list-<client_target>.md` 或对应 `docs/prd-<client_target>.json` 的 `features[]` 中找到（与 prd 产出一致）。
            - `outputs.decision=failed` → 写 `stages.prd_review.outputs.decision=failed`、`validation.passed=false`，退出码 **4**，提示重跑 `--from-stage=prd` 或 `--from-stage=prd-review`。
            - `outputs.decision=passed` → 合并 JSON 入 `stages.prd_review`：`status=completed`、`validation.passed=true`、`inputs.prd_spec_hash`（prd-spec.md 哈希）、`inputs.per_target_hashes`（各端 `prd-<client_target>.json` 哈希）、`outputs.decision=passed`、`outputs.can_enter_design=true`、`outputs.current_phase`（取 `phase_plan[0].phase`）、`review.*`；调用 `prd-implementation-report.cjs` 生成 `.pipeline/reports/prd-implementation-summary.md`（顶部含 **「AI 评审门闸结果」** 节）。
            - 可选 git commit+push（若 `config.dev.json.git.auto_commit=true`）。

    #### 日志事件（prd-review）

        > 步骤 2 按端并发时，**每个 Agent 独立一行** `agent_start` / `agent_complete` / `agent_failed`，`agent_id` 与 `client_target` 一一对应，便于 `run-dash` 与 report 按端过滤。

        | 步骤 | event | LEVEL | 关键 meta 字段 |
        | --- | --- | --- | --- |
        | stage 启动 | `stage_start` | INFO | `run_id`, `project`, `started_at`（本地时间） |
        | 步骤1：初始化骨架 | `file_created` / `file_skipped` | INFO | `path`（stages.json 中 stages.prd_review） |
        | 步骤1：全局哈希比对 | `hash_check` | INFO | `file`（prd-spec.md）, `stored_hash`, `computed_hash`, `hit` |
        | 步骤1：按端哈希比对 | `hash_check` | INFO | `client_target`, `file`（prd-<client_target>.json）, `stored_hash`, `computed_hash`, `hit`, `skip_agent`（bool） |
        | 哈希命中，跳过全部 Agent | `stage_skipped` | INFO | `reason: "prd_spec_hash and all per_target_hashes matched"` |
        | 步骤1：写 running | `file_updated` | INFO | `path`（stages.json）, `status: "running"` |
        | 步骤2：并发批次开始 | `agent_batch_start` | INFO | `batch_id: "prd-review-agents"`, `client_targets[]`, `agents_total`, `agents_skipped[]` |
        | 步骤2：单端 Agent 启动 | `agent_start` | INFO | `agent_id: "prd-review-agent-<client_target>"`, `client_target`, `prompt`（如 `prd-review-web.md`）, `input_files: ["prd-spec.md","prd-<client_target>.json","feature_list-<client_target>.md"]`, `features_in_scope[]` |
        | 步骤2：单端 Agent 跳过 | `agent_skipped` | INFO | `agent_id`, `client_target`, `reason: "per_target_hash matched"` |
        | 步骤2：单端 schema 失败重试 | `agent_retry` | WARN | `agent_id`, `client_target`, `attempt`, `reason`, `invalid_fields[]` |
        | 步骤2：单端 Agent 完成 | `agent_complete` | INFO | `agent_id`, `client_target`, `duration_ms`, `output_files: ["prd-review-<client_target>.json"]`, `decision`, `features_reviewed`, `features_deferred` |
        | 步骤2：单端 Agent 失败 | `agent_failed` | ERROR | `agent_id`, `client_target`, `exit_code: 4`, `reason`, `blocking_issues_count` |
        | 步骤2：并发批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
        | 步骤3：合并各端产出 | `file_created` | INFO | `path`（.pipeline/prd-review-output.json）, `merged_from[]`（各端 json 路径） |
        | 步骤3：合并冲突 | `validation_fail` | ERROR | `conflict_feature_ids[]`, `details`（端间 include/defer 不一致） |
        | 步骤3：全局 schema 失败 | `validation_fail` | ERROR | `missing[]`, `invalid[]`, `schema: "prd-review-output.schema.json"` |
        | 步骤3：覆盖门闸失败 | `validation_fail` | ERROR | `uncovered_feature_ids[]`, `duplicate_feature_ids[]`, `unknown_feature_ids[]` |
        | 步骤3：校验通过 | `validation_pass` | INFO | `decision: "passed"`, `phase_plan_phases[]`, `features_in_plan`, `features_deferred`, `per_target_decisions`（`{ "<client_target>": "passed" }`） |
        | 步骤3：写完成态 | `file_updated` | INFO | `path`（stages.json）, `status: "completed"`, `prd_spec_hash`, `per_target_hashes`, `current_phase` |
        | 步骤3：生成报告 | `file_created` | INFO | `path`（.pipeline/reports/prd-implementation-summary.md） |
        | stage 完成 | `stage_complete` | INFO | `duration_ms`, `decision`, `phase_count`, `client_targets_reviewed[]` |
        | 任意步骤失败 | `stage_failed` | ERROR | `step`, `exit_code`, `reason`, `failed_client_target`（若有） |

    #### 输出

        | 路径 | 说明 |
        | --- | --- |
        | `.pipeline/prd-review-<client_target>.json` | 各端 Agent 原始产出（校验通过后保留） |
        | `.pipeline/prd-review-output.json` | 脚本合并后的全局评审 JSON（门闸真源） |
        | `.pipeline/stages.json` | `stages.prd_review` 完成态：`outputs.decision`、`review.phase_plan[]`、`review.deferred_features[]` |
        | `.pipeline/reports/prd-implementation-summary.md` | 人话版分期摘要与门闸结论 |

    #### 解锁

        `stages.prd_review.status=completed` 且 `stages.prd_review.outputs.decision=passed` 且 `stages.prd_review.validation.passed=true` → 可运行 `design`。

    ---


### design.cjs — stage: `design`

    **脚本**：`design.cjs`（编排器）、`design-bootstrap.cjs`（步骤1）、`design-validate.cjs`（步骤3）；步骤2 为按 **feature** 并发的 Agent 池

    **定位**：为 `prd-review` 分期计划中的每个 `feature_id` 产出可实现的 **`design.json`**，作为 codegen / create-ui-scenarios / design-review 的直接输入（**不使用**契约五件套）。

    #### 上游门闸

    `stages.prd_review.status=completed` 且 `stages.prd_review.outputs.decision=passed` 且 `stages.prd_review.validation.passed=true`，且 `stages.prd_review.review.phase_plan` 非空。

    #### 并发配置（feature 级线程池）

    design 与后续 codegen 等 stage 均按 **feature** 派发 Agent。并发度由业务项目 **`docs/config.dev.json`** 控制，脚本取：

    ```
    effective_parallel = min(
      pipeline.stages.design.feature_max_parallel,
      pipeline.autorun.feature_max_parallel
    )
    ```

    | 配置键 | 默认值 | 说明 |
    | --- | --- | --- |
    | `pipeline.stages.design.feature_max_parallel` | `3` | **本 stage** 同时运行的 design Agent 上限 |
    | `pipeline.autorun.feature_max_parallel` | `3` | **全局天花板**（design / codegen / create-ui-scenarios 等凡按 feature 并发的 stage 均不得超过此值） |
    | `timeouts.stages.design_s` | `1200` | 单个 feature 的 Agent 超时（秒），超时记该 feature `failed` |

    配置示例（写入 `docs/config.dev.json`，由 `sync-config.cjs` 从模板合并）：

    ```json
    {
      "pipeline": {
        "autorun": {
          "feature_max_parallel": 3
        },
        "stages": {
          "design": {
            "feature_max_parallel": 3
          }
        }
      },
      "timeouts": {
        "stages": {
          "design_s": 1200
        }
      }
    }
    ```

    > 实现要求：`design.cjs` 维护固定大小为 `effective_parallel` 的 Worker 池；**不按 feature 无限起线程**。依赖未满足的 feature 不入池，待依赖 feature 的 `design.json` 完成后再入队。

    #### 输入

        | 来源 | 要求 |
        | --- | --- |
        | `stages.prd_review.review.phase_plan[]` | 待设计 feature 来源；脚本展开为 `feature_ids[]`（去重并保持 `phase` 归属） |
        | `stages.prd.outputs.features[]` | 跨端 feature 索引真源（校验 `feature_id` 合法、`client_targets`） |
        | `stages.prd.outputs.client_targets[]` | 决定需加载哪些端的 PRD / feature_list |
        | `<业务项目根绝对路径>/docs/prd-spec.md` | 总源头 |
        | `<业务项目根绝对路径>/docs/prd-<client_target>.json` | 各端 PRD（仅加载该 feature 涉及的端） |
        | `<业务项目根绝对路径>/docs/feature_list-<client_target>.md` | 各端特性表 |
        | `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、`timeouts.stages.design_s` |
        | 环境变量 `AI_STD3_AGENT_BIN` | 外部 Agent 可执行路径（可选） |

        **CLI 过滤**：`--feature=<feature_id>` 仅处理单个 feature（用于重跑失败项）；仍遵守依赖门闸（依赖 feature 须已有 `design.json` 或同次运行中先完成）。

    #### 处理逻辑

        1. **`design-bootstrap.cjs`（bootstrap）**：
            - 初始化 `stages.design` 骨架（若不存在），含 `inputs.feature_ids[]`、`features.<feature_id>.status`（`pending`）、`outputs.design_specs[]`。
            - 从 `phase_plan` 展开 `feature_ids[]`，与 `stages.prd.outputs.features[]` 交叉校验；缺失则退出码 **1**。
            - 计算 `phase_plan_hash`（`review.phase_plan` 稳定序列化后 SHA-256）与 `prd_spec_hash`（`docs/prd-spec.md`）。
            - 若 `phase_plan_hash` 与 `stages.design.inputs.phase_plan_hash` 一致且 `stages.design.status=completed` 且全部目标 feature 的 `design.json` 哈希未变，则**跳过步骤 2**，直接进入步骤 3。
            - 写 `stages.design.status=running`；日志记录 `effective_parallel`、`feature_ids[]`、`dependency_waves[]`（拓扑分层结果）。

        2. **Agent-Design（按 feature 并发，有向无环依赖调度）**：
            - 对每个待处理 `feature_id` 构建依赖图（来自 PRD / 已有草稿中的 `dependencies[]`，仅限 `feature_ids[]` 内）。
            - 按拓扑分层 **wave** 执行：同一 wave 内最多 `effective_parallel` 个 Agent 并发；**wave 内 feature 互不依赖**。
            - 每个 Agent 按 **`ai-std3/prompts/design-spec.md`**（传入 `feature_id`）执行，仅产出 **`docs/designs/<feature_id>.design.json`**（若目录不存在则脚本预先创建 `docs/designs/`）。
            - **单 feature 输入**：`prd-spec.md`、该 feature 在 `outputs.features[]` 中的元数据、所涉各端的 `prd-<client_target>.json` 与 `feature_list-<client_target>.md`、**已完成的依赖 feature** 的 `docs/designs/<dep>.design.json`（若无依赖则省略）。
            - **单 feature 产出 JSON** 字段：

                | 字段 | 说明 |
                | --- | --- |
                | `feature_id` | 与文件名一致，符合 prd 命名规则 |
                | `client_target` | 主责端（`website` / `backend` / `mobile` / `admin` / …） |
                | `client_targets` | 该 feature 涉及的全部端（与 `stages.prd.outputs.features[].client_targets` 一致） |
                | `title` | 功能名称 |
                | `phase` | `mvp` \| `standard` \| `complete` \| `future`（与 prd-review 分期一致） |
                | `file_plan` | `{ "new_files": [{ "path", "role" }], "modify_files": [{ "path", "role" }] }` |
                | `api_outline` | `[{ "method", "path", "summary" }]`（无 API 则 `[]`） |
                | `data_outline` | 主要表/结构说明（字符串或对象数组） |
                | `acceptance` | 验收标准，**至少 3 条**字符串 |
                | `constraints` | 技术约束字符串数组 |
                | `dependencies` | 依赖的 `feature_id[]`，须为 `feature_ids[]` 子集 |
                | `risks` | 风险条目 |

                示例：

                ```json
                {
                  "feature_id": "NOTE-CRUD-001",
                  "client_target": "backend",
                  "client_targets": ["backend", "website", "mobile"],
                  "title": "笔记 CRUD",
                  "phase": "mvp",
                  "file_plan": {
                    "new_files": [
                      { "path": "src/routes/notes.ts", "role": "API 路由" }
                    ],
                    "modify_files": []
                  },
                  "api_outline": [
                    { "method": "GET", "path": "/api/notes", "summary": "列表" },
                    { "method": "POST", "path": "/api/notes", "summary": "创建" }
                  ],
                  "data_outline": "notes(id, user_id, title, body, updated_at)",
                  "acceptance": [
                    "用户可创建笔记并持久化",
                    "用户可编辑、删除自己的笔记",
                    "列表分页返回正确 total"
                  ],
                  "constraints": ["须复用现有 JWT 中间件"],
                  "dependencies": ["AUTH-LOGIN-001"],
                  "risks": []
                }
                ```

            > **稳定性保障**：
            >
            > | 机制 | 说明 |
            > | --- | --- |
            > | **按 feature 哈希门控** | 若 `docs/designs/<feature_id>.design.json` 存在且 SHA-256 等于 `stages.design.features.<feature_id>.design_hash`，则**跳过该 feature Agent**（`agent_skipped`） |
            > | **Schema 强校验 + 重试** | 产出后立即 Ajv 校验 `design.json.schema.json`；失败则重试该 feature Agent，**最多 2 次** |
            > | **依赖门闸** | `dependencies[]` 中任一 id 无对应 `design.json` 且未在同次运行中完成 → 该 feature 不得入队 |
            > | **循环依赖检测** | bootstrap 建图时若发现环 → 退出码 **1**，列出 `cycle_feature_ids[]` |

        3. **`design-validate.cjs`（validate + write）**：
            - 遍历 `feature_ids[]`：文件存在、Ajv 通过、`feature_id` 与文件名一致、`acceptance.length >= 3`。
            - 每个 `dependencies[]` 条目须在 `feature_ids[]` 内且对应 `design.json` 存在。
            - 汇总 `outputs.design_specs[]`：`{ feature_id, client_target, phase, new_files_count, modify_files_count, design_hash }`。
            - 若有 feature `failed` → `stages.design.status=failed`、`validation.passed=false`，退出码 **4**（可 `--feature=` 重跑）。
            - 全部通过 → `status=completed`、`validation.passed=true`、`inputs.phase_plan_hash`、`inputs.prd_spec_hash`、更新各 `features.<id>.design_hash`。
            - 可选 git commit+push（`config.dev.json.git.auto_commit=true`）。

    #### 日志事件（design）

        > 步骤 2 按 **feature 并发**（受 `effective_parallel` 限制）：每 wave 打 `agent_batch_start` / `agent_batch_complete`；每个 feature 打独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`，`meta.feature_id` 必填。

        | 步骤 | event | LEVEL | 关键 meta 字段 |
        | --- | --- | --- | --- |
        | stage 启动 | `stage_start` | INFO | `run_id`, `project`, `started_at` |
        | 步骤1：初始化 | `file_created` / `file_skipped` | INFO | `path`（stages.design） |
        | 步骤1：展开 phase_plan | `validation_pass` | INFO | `feature_ids[]`, `phase_plan_hash`, `waves_count`, `effective_parallel` |
        | 步骤1：循环依赖 | `validation_fail` | ERROR | `cycle_feature_ids[]`, `exit_code: 1` |
        | 步骤1：整体跳过 | `stage_skipped` | INFO | `reason: "phase_plan_hash matched, all designs fresh"` |
        | 步骤1：写 running | `file_updated` | INFO | `status: "running"` |
        | 步骤2：wave 开始 | `agent_batch_start` | INFO | `batch_id: "design-wave-<n>"`, `wave_index`, `feature_ids[]`, `agents_total`, `effective_parallel` |
        | 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "design-agent-<feature_id>"`, `feature_id`, `wave_index`, `prompt: "design-spec.md"`, `dependencies[]`, `client_targets[]` |
        | 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "design_hash matched"` |
        | 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
        | 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `output_files: ["designs/<feature_id>.design.json"]`, `dependencies_count` |
        | 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 4`, `reason`, `timed_out`（bool） |
        | 步骤2：wave 结束 | `agent_batch_complete` | INFO | `batch_id`, `wave_index`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
        | 步骤3：校验通过 | `validation_pass` | INFO | `features_total`, `design_specs_count` |
        | 步骤3：校验失败 | `validation_fail` | ERROR | `missing[]`, `failed_feature_ids[]` |
        | 步骤3：写完成态 | `file_updated` | INFO | `status`, `phase_plan_hash`, `features_completed` |
        | stage 完成 | `stage_complete` | INFO | `duration_ms`, `features_total`, `effective_parallel` |
        | 任意步骤失败 | `stage_failed` | ERROR | `step`, `exit_code`, `reason`, `failed_feature_id`（若有） |

    #### 输出

        | 路径 | 说明 |
        | --- | --- |
        | `docs/designs/<feature_id>.design.json` | 每 feature 设计规格（下游真源） |
        | `.pipeline/stages.json` | `stages.design`：`features.<id>` 逐条状态、`outputs.design_specs[]`、`validation.passed` |

    #### 解锁

        `stages.design.status=completed` 且 `stages.design.validation.passed=true` → 可运行 `design-review`。

    ---


### design-review.cjs — stage: `design-review`

    **脚本**：`design-review.cjs`（编排器）、`design-review-bootstrap.cjs`（步骤1）、`design-review-validate.cjs`（步骤3）；步骤2 为按 **feature** 并发的 Agent 池

    **定位**：**AI 自动评审** design 阶段产出（**不使用**契约五件套）。各 feature Agent 产出评审 JSON，脚本做确定性检查 + 合并门闸后写入 `stages.design_review`；通过后方可进入 `create-ui-scenarios` / `codegen`。

    > **注意**：直接评审 `design.json` 与 PRD 对齐；**不**评审、**不**修改 `docs/contracts/` 五件套。

    #### 上游门闸

    `stages.design.status=completed` 且 `stages.design.validation.passed=true`，且 `stages.design.outputs.design_specs[]` 非空。

    #### 并发配置（feature 级线程池）

    与 `design` stage 相同模型，并发度取自 **`docs/config.dev.json`**：

    ```
    effective_parallel = min(
      pipeline.stages.design_review.feature_max_parallel,
      pipeline.autorun.feature_max_parallel
    )
    ```

    | 配置键 | 默认值 | 说明 |
    | --- | --- | --- |
    | `pipeline.stages.design_review.feature_max_parallel` | `3` | 本 stage 同时运行的 design-review Agent 上限 |
    | `pipeline.autorun.feature_max_parallel` | `3` | 全局天花板（与 design / codegen 共用） |
    | `timeouts.stages.design_review_s` | `900` | 单 feature 评审 Agent 超时（秒） |

    配置示例：

    ```json
    {
      "pipeline": {
        "stages": {
          "design_review": {
            "feature_max_parallel": 3
          }
        }
      },
      "timeouts": {
        "stages": {
          "design_review_s": 900
        }
      }
    }
    ```

    > 实现要求：固定大小 Worker 池，**禁止**按 feature 无限制起线程。各 feature 评审**互不依赖**，可全量并行（仅受 `effective_parallel` 限制）。

    #### 输入

        | 来源 | 要求 |
        | --- | --- |
        | `stages.design.outputs.design_specs[]` | 待评审 feature 列表（与 `stages.design.features` 完成态一致） |
        | `stages.prd_review.review.phase_plan[]` | 分期目标 / `exit_criteria`（Agent 对齐用） |
        | `stages.prd.outputs.features[]` | feature 元数据（`client_targets`、优先级） |
        | `<业务项目根绝对路径>/docs/designs/<feature_id>.design.json` | 评审对象 |
        | `<业务项目根绝对路径>/docs/prd-spec.md` | 需求总源头 |
        | `<业务项目根绝对路径>/docs/prd-<client_target>.json` | 各端 PRD（按 feature 涉及端加载） |
        | `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、`timeouts.stages.design_review_s` |

        **CLI 过滤**：`--feature=<feature_id>` 仅重评单个 feature。

    #### 处理逻辑

        1. **`design-review-bootstrap.cjs`（bootstrap + 确定性预检）**：
            - 初始化 `stages.design_review` 骨架（若不存在），含 `features.<feature_id>.status`、`outputs.gaps[]`、`outputs.decision=pending`。
            - 从 `stages.design.outputs.design_specs[]` 收集 `feature_ids[]`；校验对应 `design.json` 均存在。
            - 计算 `design_bundle_hash`（所有待评审 `design.json` 内容按 `feature_id` 排序后拼接再 SHA-256）与 `phase_plan_hash`（同 design stage）。
            - **确定性预检**（不调用 Agent，直接写入初始 `gaps[]`）：
                - `acceptance.length < 3` → `blocking`；
                - `dependencies[]` 中 id 不在本期 `feature_ids[]` → `blocking`；
                - 跨 feature **modify_files** 路径冲突（同一文件被多个 feature 修改）→ `warning`（可配置升级为 `blocking`）；
                - `file_plan.new_files` 与 `modify_files` 路径重叠 → 该 feature `blocking`。
            - 若 `design_bundle_hash` 与 `stages.design_review.inputs.design_bundle_hash` 一致且 `outputs.decision=passed`，则**跳过步骤 2**，直接进入步骤 3。
            - 写 `stages.design_review.status=running`。

        2. **Agent-Review（按 feature 并发）**：对步骤 1 中**无 blocking 确定性 gap** 的 feature（或全部 feature，确定性 gap 带入合并结果），按 `effective_parallel` 并发启动 Agent，每个 Agent **仅评审一个 feature**，按 **`ai-std3/prompts/design-review.md`** 执行，产出 **`<业务项目根绝对路径>/.pipeline/design-review-<feature_id>.json`**（**不得**直接修改 `design.json` 或 `stages.json`）。

            **单 feature 产出 JSON**（须满足 `design-review-feature-output.schema.json`）：

            ```json
            {
              "feature_id": "NOTE-CRUD-001",
              "outputs": {
                "decision": "passed",
                "alignment_summary": "design 与 prd-spec、各端 prd 对齐，可实现。"
              },
              "gaps": [
                {
                  "field": "api_outline",
                  "category": "prd_alignment",
                  "severity": "warning",
                  "message": "POST /api/notes 未在 backend prd 的 endpoints 中声明"
                }
              ]
            }
            ```

            **Agent 硬约束**：
            - 评审维度：**完整性**（`file_plan` / `acceptance` / `api_outline`）、**可实现性**、**与 PRD 对齐**（`prd-spec` + 所涉 `prd-<client_target>.json`）、**跨端一致性**（`client_targets[]`）。
            - `outputs.decision`：`passed` | `failed` | `needs_design_fix`（**无** `needs_contract_fix`，std3 不使用契约五件套）。
            - `passed` 时：无 `severity=blocking` 的 gap（`warning` 允许）。
            - `failed` / `needs_design_fix`：须含至少一条 `blocking` gap 或明确 `message`。
            - **禁止**：改写 `design.json`；缺口只写入 JSON 的 `gaps[]`。

            > **稳定性保障**：
            >
            > | 机制 | 说明 |
            > | --- | --- |
            > | **按 feature 哈希门控** | 若该 feature 的 `design.json` 哈希与 `stages.design_review.features.<id>.design_hash` 一致且上次评审 `decision=passed`，则**跳过该 feature Agent** |
            > | **Schema 强校验 + 重试** | 产出后 Ajv 校验；失败重试该 feature，**最多 2 次** |
            > | **确定性 gap 保留** | bootstrap 写入的 blocking gap 不因 Agent `passed` 被覆盖 |

        3. **`design-review-validate.cjs`（merge + finalize）**：
            - 读取全部 `.pipeline/design-review-<feature_id>.json`（被跳过的 feature 沿用上次的评审结果或仅含确定性 gap）。
            - 合并为 `outputs.gaps[]`（附 `feature_id`）与逐 feature `decision`。
            - **整体门闸**：
                - 任一 feature 含 `blocking` gap（确定性或 Agent）→ `outputs.decision=needs_fix`，`can_enter_codegen=false`，退出码 **4**；
                - 全部 feature `decision=passed` 且无 blocking gap → `outputs.decision=passed`，`can_enter_codegen=true`。
            - 写 `stages.design_review`：`status=completed`、`validation.passed=true`、`inputs.design_bundle_hash`、`inputs.phase_plan_hash`、`outputs.decision`、`outputs.can_enter_codegen`、`outputs.blocking_count`、`outputs.warning_count`。
            - 生成 `.pipeline/reports/design-review-summary.md`（可选，人话摘要）。
            - 失败时提示：`needs_design_fix` → 重跑 `--from-stage=design`（或 `--feature=`）；仅评审问题 → 重跑 `--from-stage=design-review`。

    #### 日志事件（design-review）

        > 步骤 2 按 feature 并发：每轮调度打 `agent_batch_start` / `agent_batch_complete`；每个 feature 独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped`，`meta.feature_id` 必填。

        | 步骤 | event | LEVEL | 关键 meta 字段 |
        | --- | --- | --- | --- |
        | stage 启动 | `stage_start` | INFO | `run_id`, `project`, `started_at` |
        | 步骤1：初始化 | `file_created` / `file_skipped` | INFO | `path`（stages.design_review） |
        | 步骤1：确定性预检 | `validation_pass` / `validation_fail` | INFO/ERROR | `feature_ids[]`, `deterministic_blocking_count`, `deterministic_warning_count` |
        | 步骤1：bundle 哈希 | `hash_check` | INFO | `design_bundle_hash`, `stored_hash`, `computed_hash`, `hit` |
        | 步骤1：整体跳过 Agent | `stage_skipped` | INFO | `reason: "design_bundle_hash matched, decision=passed"` |
        | 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `effective_parallel` |
        | 步骤2：批次开始 | `agent_batch_start` | INFO | `batch_id: "design-review-agents"`, `feature_ids[]`, `agents_total`, `agents_skipped[]`, `effective_parallel` |
        | 步骤2：单 feature 启动 | `agent_start` | INFO | `agent_id: "design-review-agent-<feature_id>"`, `feature_id`, `prompt: "design-review.md"`, `input_files: ["designs/<feature_id>.design.json","prd-spec.md",...]` |
        | 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "design_hash matched, prior passed"` |
        | 步骤2：schema 失败重试 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`, `invalid_fields[]` |
        | 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `decision`, `gaps_blocking`, `gaps_warning`, `output_files: ["design-review-<feature_id>.json"]` |
        | 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 4`, `reason`, `timed_out` |
        | 步骤2：批次结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms` |
        | 步骤3：合并 | `file_updated` | INFO | `gaps_total`, `blocking_count`, `warning_count`, `per_feature_decisions` |
        | 步骤3：门闸未通过 | `validation_fail` | ERROR | `decision: "needs_fix"`, `blocking_feature_ids[]`, `exit_code: 4` |
        | 步骤3：门闸通过 | `validation_pass` | INFO | `decision: "passed"`, `can_enter_codegen: true` |
        | 步骤3：写完成态 | `file_updated` | INFO | `status: "completed"`, `design_bundle_hash` |
        | stage 完成 | `stage_complete` | INFO | `duration_ms`, `decision`, `features_reviewed` |
        | 任意步骤失败 | `stage_failed` | ERROR | `step`, `exit_code`, `reason`, `failed_feature_id` |

    #### 输出

        | 路径 | 说明 |
        | --- | --- |
        | `.pipeline/design-review-<feature_id>.json` | 各 feature Agent 评审产出 |
        | `.pipeline/stages.json` | `stages.design_review`：`outputs.decision`、`outputs.can_enter_codegen`、`outputs.gaps[]`、`features.<id>` |
        | `.pipeline/reports/design-review-summary.md` | 可选人话摘要 |

    #### 解锁

        `stages.design_review.status=completed` 且 `stages.design_review.validation.passed=true` 且 `stages.design_review.outputs.can_enter_codegen=true` → 可运行 `create-ui-scenarios`。

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
            feature_id: NOTE-CRUD-001
            client_target: website          # website | admin | mobile
            scenarios:
              - id: NOTE-CRUD-001-smoke-001
                platform: web               # web | android | ios
                steps:
                  - action: navigate
                    url: "{base_url}/"
                  - action: snapshot
                expect:
                  - type: text_present
                    value: "欢迎"           # 从 acceptance[] 提取关键词
              - id: NOTE-CRUD-001-form-submit-001
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
    | design | `stages.prd_review.outputs.decision=passed` |
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

    **自动启动看板**：`run-pipeline.cjs` 在启动流水线的同时，自动以 `spawn`（detached）方式在独立终端拉起 `run-dash.cjs`，默认传入当前 `--project` 路径：

        ```
        启动顺序：
        1. run-pipeline.cjs 解析 --project（见"项目自动探测"规则）
        2. spawn run-dash.cjs --project=<解析后的绝对路径>（detached，不阻塞流水线）
        3. 正常执行 stage 链
        ```

        若当前终端不支持 TUI（如 CI 环境、`NO_COLOR=1`、`CI=true`），则跳过自动启动看板，仅输出纯文本进度到 stdout。

    **停止信号检查**：`run-pipeline.cjs` 在每个 stage 进入前检查 `<项目根>/.pipeline/stop.signal`：

        ```
        for each stage in stageList:
            if stop.signal exists → log pipeline_stop → write pipeline.stop_info → exit(5)
            spawn lib/<stage>.cjs ...
        ```

        各 `lib/<stage>.cjs` 脚本在启动时及每次调用 Agent 前同样执行相同检查；检测到信号后写 `pipeline_stop` 日志，`status` 置为 `stopped`（非 `failed`），退出码 `5`。

        续跑时（`--from-stage`）会自动清除残留的 `stop.signal`，避免误拦截。

    ---


## 4. Agent 卡点速查

    | 场景 | 退出码 | 处理方式 |
    | --- | ---: | --- |
    | `inputs/req.md` / `config.env` 未填完 | 2 | 用户补全后重跑 `--from-stage=setup` |
    | prd-spec 不符合 schema / 需求变更 | 4 | Agent 按 `prompts/prd-spec-author.md` 更新，重跑 `--from-stage=prd` |
    | 缺少 `.pipeline/prd-review-<client_target>.json`（某端） | 4 | 对该端重跑 Agent（`--from-stage=prd-review`）；检查对应 `prompts/prd-review-*.md` |
    | 合并后缺少 `.pipeline/prd-review-output.json` | 4 | 重跑 `prd-review-validate.cjs` 或 `--from-stage=prd-review` |
    | prd-review `decision=failed` | 4 | Agent 改 PRD，重跑 `--from-stage=prd` |
    | design.json 校验失败 | 4 | Agent 修 design，重跑 `--from-stage=design` |
    | 缺少 `.pipeline/design-review-<feature_id>.json` | 4 | 对该 feature 重跑 Agent，`--from-stage=design-review [--feature=<id>]` |
    | design-review `blocking` gap / `needs_fix` | 4 | Agent 改 `design.json`，重跑 `--from-stage=design`；仅评审问题可重跑 `--from-stage=design-review` |
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
    | `prompts/prd-spec-author.md` | prd（Agent-A） | 读 req.md + prd-spec 草稿，增量补全 prd-spec.md |
    | `prompts/prd-client-author.md` | prd（Agent-B） | 读 prd-spec.md + 端草稿，增量补全该端 prd.json + feature_list.md |
    | `prompts/prd-review-web.md` | prd-review（每端 Agent） | 评审 website/前端端 PRD，产出 `prd-review-<client_target>.json` |
    | `prompts/prd-review-backend.md` | prd-review（每端 Agent） | 评审 backend 端 PRD |
    | `prompts/prd-review-mobile.md` | prd-review（每端 Agent） | 评审 mobile 端 PRD |
    | `prompts/prd-review-admin.md` | prd-review（每端 Agent） | 评审 admin 端 PRD |
    | `prompts/prd-review-default.md` | prd-review（每端 Agent，兜底） | 评审未知端 PRD |
    | `prompts/design-spec.md` | design（每 feature Agent） | 传入 `feature_id`，读 prd-spec / 各端 prd / 依赖 design，产出 `docs/designs/<feature_id>.design.json` |
    | `prompts/design-review.md` | design-review（每 feature Agent） | 传入 `feature_id`，读 design.json + prd-spec / 各端 prd，产出 `.pipeline/design-review-<feature_id>.json` |
    | `prompts/create-ui-scenarios.md` | create-ui-scenarios | 从 acceptance 派生 UI 场景 YAML |
    | `prompts/codegen-impl.md` | codegen | worktree 内实现代码 + 自嵌测试 |
    | `prompts/code-review-agent.md` | code-review | 评审代码，产出评审 JSON |

    ---


## 6. 附录：模板文件内容

    所有模板文件位于 `ai-std3/docs/templates/`。脚本在目标文件不存在时从此处拷贝，拷贝后由脚本或 Agent 填入实际值。

    ---

    ### `req-template.md`

        > 路径：`ai-std3/docs/templates/req-template.md`
        > `verify-inputs.cjs` 检查所有标 `*` 的 H2 节必须非空。

        ```markdown
        # 项目需求说明

        <!-- 填写项目基本信息与功能需求，带 * 的节为必填项 -->

        ## 项目名称 *

        <!-- 示例：RealNotes -->

        ## 项目简介 *

        <!-- 一段话描述项目定位与目标用户 -->

        ## 客户端目标 *

        <!-- 列出需要实现的端，从以下选项中勾选（可多选），并说明各端定位：
        - website    — 面向用户的前端网站
        - admin      — 后台管理界面
        - backend    — 服务端 API
        - mobile     — iOS / Android App（Flutter）
        -->

        ## 核心功能 *

        <!-- 按优先级列出功能，示例格式：
        | feature_id      | 功能名称      | 优先级 | 阶段 | 涉及端 | 简述 |
        | --- | --- | --- | --- | --- | --- |
        | AUTH-LOGIN-001  | 用户登录/注册 | P0 | mvp | backend, website | JWT 鉴权（跨端用业务域前缀） |
        | NOTE-CRUD-001   | 笔记 CRUD    | P0 | mvp | backend, website, mobile | 跨端 feature |
        | WEB-HOME-001    | 首页展示      | P1 | mvp | website | 单端 feature，用端名前缀 |
        -->

        ## 非功能需求

        <!-- 性能、安全、可用性等要求 -->

        ## 部署与域名要求 *

        <!-- 示例：
        - 云平台：Cloudflare
        - website 域名：notes.example.com
        - backend 域名：api.example.com
        - 环境：dev / release
        -->

        ## 鉴权方案 *

        <!-- 示例：JWT，有效期 7 天；或 session；或 none -->

        ## 技术约束

        <!-- 指定技术栈、禁用框架、第三方限制等 -->

        ## 其他说明

        <!-- 上线时间、MVP 范围、已知风险等 -->
        ```

        ---

    ### `config.env.template`

        > 路径：`ai-std3/docs/templates/config.env.template`
        > 拷贝为 `<业务项目根绝对路径>/inputs/config.env`，**不进 git**。
        > `verify-inputs.cjs` 检查 `CLOUD_PROVIDER` 及对应密钥非空。

        ```bash
        # ── 云平台选择 ───────────────────────────────────────────
        # 可选值：cloudflare | aws | gcp | manual
        CLOUD_PROVIDER=

        # ── Cloudflare（CLOUD_PROVIDER=cloudflare 时必填）─────────
        CLOUDFLARE_API_TOKEN=
        CLOUDFLARE_ACCOUNT_ID=

        # ── AWS（CLOUD_PROVIDER=aws 时必填）──────────────────────
        AWS_ACCESS_KEY_ID=
        AWS_SECRET_ACCESS_KEY=
        AWS_REGION=

        # ── 通用 ─────────────────────────────────────────────────
        # Git 远端（可选，默认 origin）
        GIT_REMOTE=origin
        ```

        ---

    ### `config.json.template`

        > 路径：`ai-std3/docs/templates/config.json.template`
        > 拷贝为 `<业务项目根绝对路径>/docs/config.dev.json` 与 `config.release.json`。
        > `sync-config.cjs` 负责从 config.env 填入云凭证无关的结构字段；凭证永远只存 config.env。

        ```json
        {
        "pipeline": {
            "autorun": {
            "allow_destructive_deploy": false,
            "feature_max_parallel": 3
            },
            "stages": {
            "design": {
                "feature_max_parallel": 3
            },
            "design_review": {
                "feature_max_parallel": 3
            },
            "codegen": {
                "feature_max_parallel": 3
            }
            }
        },
        "git": {
            "remote": "origin",
            "default_branch": "main",
            "auto_commit": false
        },
        "build": {
            "client_targets": [],
            "commands": {
            "website": "npm run build",
            "admin":   "npm run build",
            "backend": "npm run build",
            "mobile":  "flutter build apk --release"
            }
        },
        "deploy": {
            "enabled": false,
            "provider": "cloudflare",
            "services": [
            {
                "name": "website",
                "client_target": "website",
                "type": "pages",
                "domain": "",
                "url": ""
            },
            {
                "name": "backend",
                "client_target": "backend",
                "type": "workers",
                "domain": "",
                "url": ""
            }
            ]
        },
        "smoke": {
            "checks": [
            {
                "url": "{deploy.services.website.url}/",
                "method": "GET",
                "expected_status": 200,
                "body_contains": null,
                "safe": true
            },
            {
                "url": "{deploy.services.backend.url}/health",
                "method": "GET",
                "expected_status": 200,
                "body_contains": null,
                "safe": true
            }
            ]
        },
        "ui_e2e": {
            "enabled": false,
            "require_smoke_passed": true,
            "web": {
            "base_url_from": "deploy.services.website.url"
            },
            "mobile": {
            "bundle_id": "",
            "device": "emulator"
            },
            "commands": {
            "ui_test_max_fix_attempts": 3
            }
        },
        "timeouts": {
            "stages": {
            "design_s":  1200,
            "design_review_s": 900,
            "build_s":   300,
            "codegen_s": 1800,
            "deploy_s":  600,
            "smoke_s":   120,
            "ui_e2e_s":  1800
            }
        }
        }
        ```

        ---

    ### `stages.json.template`

        > 路径：`ai-std3/docs/templates/stages.json.template`
        > 拷贝为 `<业务项目根绝对路径>/.pipeline/stages.json`，由 `setup.cjs` 初始化并由各 stage 脚本增量写入。
        > `stages` 对象为空，各 stage 首次运行时由脚本按本规范追加各自的骨架。

        ```json
        {
        "pipeline": {
            "current_stage": null,
            "last_completed_stage": null,
            "updated_at": null,
            "updated_by": "ai-std3",
            "project": {
            "project_id": null,
            "root_path": null,
            "name": null,
            "git": {
                "remote": null,
                "remote_url": null,
                "default_branch": null,
                "repo_initialized_at": null,
                "remote_configured_at": null
            }
            }
        },
        "stages": {}
        }
        ```

        ---

    ### `prd-spec.md.template`

        > 路径：`ai-std3/docs/templates/prd-spec.md.template`
        > 拷贝为 `<业务项目根绝对路径>/docs/prd-spec.md`。
        > Agent-A 按 `prompts/prd-spec-author.md` 增量补全此文件；脚本校验 `## 客户端目标` 与 `## 核心功能` H2 节存在且非空。

        ```markdown
        # PRD 规格说明

        <!-- 由 Agent-A 根据 inputs/req.md 增量补全，人工可直接编辑 -->

        ## 项目概述

        <!-- 项目名称、定位、目标用户、核心价值 -->

        ## 客户端目标

        <!-- 格式：每行一个端，示例：
        - website  — 用户前端（React/Next.js）
        - admin    — 管理后台（React/Next.js）
        - backend  — REST API 服务（Node.js/Hono）
        - mobile   — iOS + Android App（Flutter）
        -->

        ## 核心功能

        <!-- 功能总表，Agent 从 req.md 提炼，示例：
        | feature_id | 功能名称 | 优先级 | 阶段 | 涉及端 |
        | --- | --- | --- | --- | --- |
        | AUTH-LOGIN-001 | 用户鉴权 | P0 | mvp | backend, website, mobile |
        | NOTE-CRUD-001  | 笔记 CRUD | P0 | mvp | backend, website, mobile |
        -->

        ## 鉴权方案

        <!-- JWT / session / none，token 有效期，刷新策略 -->

        ## 部署架构

        <!-- 各端部署方式、域名、环境（dev/release） -->

        ## 非功能需求

        <!-- 性能基线、安全要求、可用性 SLA -->

        ## 技术约束

        <!-- 禁用技术、指定版本、第三方限制 -->

        ## 分期计划

        <!-- mvp / standard / complete / future 功能划分，由 prd-review 阶段补全 -->
        ```

        ---

    ### `prd-<client_target>.json.template`

        > **路径规则**：每个端对应一个独立模板文件，放置于 `ai-std3/docs/templates/` 下：
        >
        > | 端标识 | 模板文件 | 目标文件 |
        > | --- | --- | --- |
        > | `web` / `frontend` | `prd-web.json.template` | `docs/prd-web.json` |
        > | `backend` / `server` | `prd-backend.json.template` | `docs/prd-backend.json` |
        > | `mobile` / `ios` / `android` | `prd-mobile.json.template` | `docs/prd-mobile.json` |
        > | `admin` | `prd-admin.json.template` | `docs/prd-admin.json` |
        > | 其余端 | `prd-default.json.template`（兜底） | `docs/prd-<client_target>.json` |
        >
        > 脚本在 Agent-B 启动前判断：若 `docs/prd-<client_target>.json` 不存在，则先从对应的专属模板（或 `prd-default.json.template` 兜底）拷贝；Agent-B 按 `prompts/prd-client-author.md` **增量补全**此文件；脚本用 Ajv 校验必填字段非空。

        #### `prd-web.json.template`（前端 / Web）

            ```json
            {
            "client_target": "web",
            "project_name": "",
            "tech_stack": { "framework": "", "css": "", "bundler": "" },
            "features": [
                {
                "feature_id": "",
                "name": "",
                "priority": "P0",
                "phase": "mvp",
                "description": "",
                "acceptance": [],
                "pages": [],
                "api_calls": []
                }
            ],
            "routing": { "type": "spa", "notes": "" },
            "auth": { "type": "none", "notes": "" },
            "constraints": []
            }
            ```

        #### `prd-backend.json.template`（服务端）

            ```json
            {
            "client_target": "backend",
            "project_name": "",
            "tech_stack": { "language": "", "framework": "", "db": "" },
            "features": [
                {
                "feature_id": "",
                "name": "",
                "priority": "P0",
                "phase": "mvp",
                "description": "",
                "acceptance": [],
                "endpoints": [],
                "db_tables": []
                }
            ],
            "deploy": { "platform": "", "domain": "", "service_type": "" },
            "auth": { "type": "none", "notes": "" },
            "constraints": []
            }
            ```

        #### `prd-mobile.json.template`（移动端 iOS / Android）

            ```json
            {
            "client_target": "mobile",
            "project_name": "",
            "tech_stack": { "framework": "", "min_os_version": "" },
            "features": [
                {
                "feature_id": "",
                "name": "",
                "priority": "P0",
                "phase": "mvp",
                "description": "",
                "acceptance": [],
                "screens": [],
                "api_calls": []
                }
            ],
            "permissions": [],
            "auth": { "type": "none", "notes": "" },
            "constraints": []
            }
            ```

        #### `prd-admin.json.template`（管理后台）

            ```json
            {
            "client_target": "admin",
            "project_name": "",
            "tech_stack": { "framework": "", "css": "" },
            "features": [
                {
                "feature_id": "",
                "name": "",
                "priority": "P0",
                "phase": "mvp",
                "description": "",
                "acceptance": [],
                "pages": [],
                "roles": []
                }
            ],
            "auth": { "type": "session", "notes": "" },
            "constraints": []
            }
            ```

        #### `prd-default.json.template`（通用兜底）

            ```json
            {
            "client_target": "",
            "project_name": "",
            "features": [
                {
                "feature_id": "",
                "name": "",
                "priority": "P0",
                "phase": "mvp",
                "description": "",
                "acceptance": [],
                "api_hints": []
                }
            ],
            "deploy": { "domain": "", "service_type": "" },
            "auth": { "type": "none", "notes": "" },
            "constraints": []
            }
            ```

    ---


## 7. `run-dash` — 流水线状态看板

    **脚本**：`ai-std3/scripts/run-dash.cjs`

    **调用形态**：

        ```bash
        # 手动启动（手动指定项目）
        node ai-std3/scripts/run-dash.cjs --project=<业务项目根绝对路径> [--tail=50]

        # 自动启动（由 run-pipeline.cjs 在流水线启动时自动调用，无需手工执行）
        node ai-std3/scripts/run-dash.cjs --project=<绝对路径> --auto-launched
        ```

    #### 项目自动探测

        `run-dash` 与 `run-pipeline.cjs` 共用同一套项目路径解析规则，**优先级从高到低**：

        | 优先级 | 来源 | 说明 |
        | --- | --- | --- |
        | 1 | `--project=<路径>` 参数 | 显式指定，绝对或相对路径均可（自动转绝对） |
        | 2 | 环境变量 `AI_STD3_PROJECT` | `export AI_STD3_PROJECT=/path/to/project` |
        | 3 | **当前工作目录（`process.cwd()`）** | 在哪个项目目录下运行 skill，就默认用哪个 |

        取到路径后校验：若 `<路径>/.pipeline/stages.json` 不存在，则提示"未找到已初始化的 std3 项目，请先运行 setup"，退出码 `1`。

    #### 功能定位

        `run-dash` 是一个**只读 TUI（终端 UI）看板**，实时监视流水线状态，提供停止按钮。
        它不参与流水线执行逻辑，任何时候退出看板都不影响正在运行的流水线。

    #### 实现依赖

        | 依赖 | 说明 |
        | --- | --- |
        | `blessed` 或 `ink` | TUI 渲染（推荐 `blessed`，纯 Node.js，无需编译） |
        | `fs.watch` / `chokidar` | 监听 `stages.json` 与日志文件变更 |
        | `tail-file` 或手动 `readline` | 追读日志文件新增行 |

    #### TUI 布局

        ```
        ┌─────────────────────────────────────────────────────────────────┐
        │  ai-std3 流水线看板  项目: RealNotes  启动: 2026-05-18 08:30:15 │
        ├───────────────────────────┬─────────────────────────────────────┤
        │  阶段状态                 │  当前阶段日志（末 50 行）            │
        │                           │                                     │
        │  ✓ setup      00:12       │  [08:32:01] [INFO] [prd] agent_start│
        │  ⟳ prd    ←当前 03:45    │  agent_id: prd-agent-a              │
        │  ○ prd-review             │  prompt: prd-spec-author.md         │
        │  ○ design                 │  [08:32:04] [INFO] [prd] file_update│
        │  ○ design-review          │  path: docs/prd-spec.md             │
        │  ○ create-ui-scenarios    │  size_bytes: 4821                   │
        │  ○ codegen                │  ...                                │
        │  ○ code-review            │                                     │
        │  ○ merge_push             │                                     │
        │  ○ build                  │                                     │
        │  ○ deploy                 │                                     │
        │  ○ smoke                  │                                     │
        │  ○ ui_e2e                 │                                     │
        │  ○ report                 │                                     │
        ├───────────────────────────┴─────────────────────────────────────┤
        │  [S] 停止流水线   [R] 刷新   [↑/↓] 滚动日志   [Q] 退出看板     │
        └─────────────────────────────────────────────────────────────────┘
        ```

        | 状态图标 | 含义 |
        | --- | --- |
        | `✓` | completed |
        | `⟳` | running（Agent 处理中），显示已用时长 |
        | `✗` | failed |
        | `↷` | skipped |
        | `◈` | stopped |
        | `○` | pending（未开始） |

    #### 数据来源与刷新机制

        | 数据 | 来源文件 | 刷新触发 |
        | --- | --- | --- |
        | 阶段状态列表 | `<项目根>/.pipeline/stages.json` | `fs.watch` 文件变更事件，变更后 100ms 防抖重读 |
        | 阶段耗时 | `stages.json` 中各 stage 的 `started_at` / `completed_at`；running 状态时取当前本地时间动态计算 | 每秒刷新一次计时器 |
        | 日志追读 | `<项目根>/logs/stages/<当前 stage>/<datetime>.log` | `chokidar` 或 `setInterval` 每 500ms 读新增行，追加到日志面板 |
        | 流水线停止状态 | `<项目根>/.pipeline/stop.signal`（是否存在）| `fs.watch` 监听，存在时底部状态栏变红提示"停止中…" |

    #### 键盘操作

        | 按键 | 行为 |
        | --- | --- |
        | `S` / `s` | 弹出确认框："确认停止流水线？[Y/N]"；确认后调用 `stop-pipeline.cjs`，写入 `stop.signal` |
        | `Q` / `q` / `Ctrl+C` | 退出看板（**不停止**流水线） |
        | `R` / `r` | 强制重新读取 `stages.json`，刷新所有状态 |
        | `↑` / `↓` | 滚动日志面板 |
        | `PgUp` / `PgDn` | 日志面板翻页 |

    #### 停止确认交互

        ```
        ╔══════════════════════════════════════╗
        ║  确认停止流水线？                    ║
        ║  当前阶段：prd（Agent 运行中）       ║
        ║  停止后可用 --from-stage=prd 续跑    ║
        ║                                      ║
        ║     [Y] 确认停止    [N] 取消         ║
        ╚══════════════════════════════════════╝
        ```

        确认后：写入 `stop.signal` → 底部状态栏变红显示"停止中，等待当前步骤完成…" → 监听到 `pipeline.stop_info` 写入 `stages.json` 后显示"已停止"。

    ---


## 8. `stop-pipeline` — 停止流水线脚本

    **脚本**：`ai-std3/scripts/stop-pipeline.cjs`

    **调用形态**：

        ```bash
        # 命令行直接停止
        node ai-std3/scripts/stop-pipeline.cjs --project=<业务项目根绝对路径> [--reason="<原因>"]

        # run-dash 内部调用（由看板 S 键触发，无需手工执行）
        ```

    #### 处理逻辑

        1. 检查 `<项目根>/.pipeline/stages.json` 存在，否则退出码 `1`（项目未初始化）。
        2. 检查是否已存在 `stop.signal`，若存在则打印"流水线已在停止中"，退出码 `0`。
        3. 写入 `<项目根>/.pipeline/stop.signal`：
            ```json
            {
              "requested_at": "<本地时间 YYYY-MM-DD HH:mm:ss Z>",
              "reason": "<--reason 参数值，默认 user_request>",
              "requested_by": "stop-pipeline-cmd"
            }
            ```
        4. 打印提示：
            ```
            ✓ 停止信号已写入。流水线将在当前步骤完成后停止。
              续跑命令：node ai-std3/scripts/run-pipeline.cjs --project=<path> --from-stage=<stopped_stage>
            ```
        5. 退出码 `0`。

    #### 注意事项

        - `stop-pipeline.cjs` **只写信号文件**，不做任何 kill 操作，保证原子操作的完整性。
        - 续跑时 `run-pipeline.cjs` 会自动清除 `stop.signal`，无需手工删除。
        - 若需立即强制终止（紧急情况），用 `Ctrl+C` 中断 `run-pipeline.cjs` 进程，但可能导致 stages.json 状态不一致，续跑前需手工校正 `status` 字段。

---


## 9. 附录：JSON Schema 文件

    所有 Schema 文件位于 `ai-std3/docs/schemas/`，供脚本通过 **Ajv**（JSON Schema draft-07）在运行时校验 Agent 产出与脚本写入的 JSON 文件。

    | Schema 文件 | 校验目标 | 调用时机 |
    | --- | --- | --- |
    | `stop.signal.schema.json` | `.pipeline/stop.signal` | `stop-pipeline.cjs` 写入后立即校验 |
    | `stages.json.schema.json` | `.pipeline/stages.json` | 每次增量写入后校验整体结构 |
    | `config.json.schema.json` | `docs/config.dev.json` / `docs/config.release.json` | `sync-config.cjs` 写入后校验 |
    | `prd-client.base.schema.json` | 所有 `docs/prd-*.json`（公共字段） | 被各端 schema 通过 `allOf` 引用 |
    | `prd-web.json.schema.json` | `docs/prd-web.json` | Agent-B（web 端）完成后校验 |
    | `prd-backend.json.schema.json` | `docs/prd-backend.json` | Agent-B（backend 端）完成后校验 |
    | `prd-mobile.json.schema.json` | `docs/prd-mobile.json` | Agent-B（mobile 端）完成后校验 |
    | `prd-admin.json.schema.json` | `docs/prd-admin.json` | Agent-B（admin 端）完成后校验 |
    | `prd-default.json.schema.json` | `docs/prd-<client_target>.json`（未知端兜底） | Agent-B（其余端）完成后校验 |
    | `prd-review-client-output.schema.json` | `.pipeline/prd-review-<client_target>.json` | 各端 Agent 完成后立即校验 |
    | `prd-review-output.schema.json` | `.pipeline/prd-review-output.json` | `prd-review-validate.cjs` 合并后校验 |
    | `design.json.schema.json` | `docs/designs/<feature_id>.design.json` | 各 feature Agent 完成后立即校验 |
    | `design-review-feature-output.schema.json` | `.pipeline/design-review-<feature_id>.json` | 各 feature 评审 Agent 完成后立即校验 |

    ---

### `stop.signal.schema.json`

    > 路径：`ai-std3/docs/schemas/stop.signal.schema.json`
    > 校验 `<项目根>/.pipeline/stop.signal` 文件，写入后立即 `Ajv.validate`；非法则打印错误并以退出码 `1` 中止。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "stop.signal.schema.json",
      "title": "stop.signal",
      "description": "流水线停止信号文件",
      "type": "object",
      "required": ["requested_at", "reason", "requested_by"],
      "additionalProperties": false,
      "properties": {
        "requested_at": {
          "type": "string",
          "description": "本地时间，格式 YYYY-MM-DD HH:mm:ss ±HHMM"
        },
        "reason": {
          "type": "string",
          "minLength": 1,
          "description": "停止原因，默认 user_request"
        },
        "requested_by": {
          "type": "string",
          "enum": ["run-dash", "stop-pipeline-cmd", "user"],
          "description": "发起方"
        }
      }
    }
    ```

    ---

### `stages.json.schema.json`

    > 路径：`ai-std3/docs/schemas/stages.json.schema.json`
    > 校验 `<项目根>/.pipeline/stages.json`，各 stage 脚本每次增量写入后校验。
    > `stages` 对象中 `setup` / `prd` 两个已知 stage 使用各自专属 `$defs`；其余 stage 对应 `stageBase`。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "stages.json.schema.json",
      "title": "stages.json",
      "type": "object",
      "required": ["pipeline", "stages"],
      "additionalProperties": false,
      "properties": {
        "pipeline": { "$ref": "#/$defs/pipeline" },
        "stages":   { "$ref": "#/$defs/stages" }
      },
      "$defs": {
        "pipeline": {
          "type": "object",
          "required": ["current_stage", "last_completed_stage", "updated_at", "updated_by", "project"],
          "properties": {
            "current_stage":        { "type": ["string", "null"] },
            "last_completed_stage": { "type": ["string", "null"] },
            "updated_at":           { "type": ["string", "null"] },
            "updated_by":           { "type": "string", "const": "ai-std3" },
            "project":              { "$ref": "#/$defs/project" },
            "stop_info":            { "$ref": "#/$defs/stopInfo" }
          }
        },
        "project": {
          "type": "object",
          "required": ["project_id", "root_path", "name", "git"],
          "properties": {
            "project_id": { "type": ["string", "null"] },
            "root_path":  { "type": ["string", "null"] },
            "name":       { "type": ["string", "null"] },
            "git": {
              "type": "object",
              "required": ["remote", "remote_url", "default_branch", "repo_initialized_at", "remote_configured_at"],
              "properties": {
                "remote":               { "type": ["string", "null"] },
                "remote_url":           { "type": ["string", "null"] },
                "default_branch":       { "type": ["string", "null"] },
                "repo_initialized_at":  { "type": ["string", "null"] },
                "remote_configured_at": { "type": ["string", "null"] }
              }
            }
          }
        },
        "stopInfo": {
          "type": "object",
          "required": ["stopped_at", "stopped_stage", "reason"],
          "properties": {
            "stopped_at":    { "type": "string" },
            "stopped_stage": { "type": "string" },
            "reason":        { "type": "string" }
          }
        },
        "stageStatus": {
          "type": "string",
          "enum": ["started", "running", "completed", "failed", "skipped"]
        },
        "validation": {
          "type": "object",
          "required": ["passed", "checked_at", "summary", "required_files", "missing_required_fields", "warnings"],
          "properties": {
            "passed":                  { "type": "boolean" },
            "checked_at":              { "type": ["string", "null"] },
            "summary":                 { "type": ["string", "null"] },
            "required_files":          { "type": "array", "items": { "type": "string" } },
            "missing_required_fields": { "type": "array", "items": { "type": "string" } },
            "warnings":                { "type": "array", "items": { "type": "string" } }
          }
        },
        "gitSync": {
          "type": "object",
          "required": ["initial_pushed_at", "docs_pipeline_pushed_at", "last_commit", "last_push_status"],
          "properties": {
            "initial_pushed_at":       { "type": ["string", "null"] },
            "docs_pipeline_pushed_at": { "type": ["string", "null"] },
            "last_commit":             { "type": ["string", "null"] },
            "last_push_status":        { "type": ["string", "null"] }
          }
        },
        "stageOutputsBase": {
          "type": "object",
          "required": ["client_targets", "duration_ms", "timed_out", "timeout_reason"],
          "properties": {
            "client_targets":  { "type": "array", "items": { "type": "string" } },
            "duration_ms":     { "type": ["number", "null"] },
            "timed_out":       { "type": "boolean" },
            "timeout_reason":  { "type": ["string", "null"] }
          }
        },
        "stageBase": {
          "type": "object",
          "required": ["status", "started_at", "completed_at", "validation", "generated_files", "blocking_issues", "git_sync"],
          "properties": {
            "status":          { "$ref": "#/$defs/stageStatus" },
            "started_at":      { "type": ["string", "null"] },
            "completed_at":    { "type": ["string", "null"] },
            "validation":      { "$ref": "#/$defs/validation" },
            "generated_files": { "type": "array", "items": { "type": "string" } },
            "blocking_issues": { "type": "array", "items": { "type": "string" } },
            "git_sync":        { "$ref": "#/$defs/gitSync" }
          }
        },
        "setupStage": {
          "allOf": [{ "$ref": "#/$defs/stageBase" }],
          "properties": {
            "inputs": {
              "type": "object",
              "required": ["source_prd_spec", "summary_hash", "raw_input_refs"],
              "properties": {
                "source_prd_spec": { "type": "string" },
                "summary_hash":    { "type": ["string", "null"] },
                "raw_input_refs":  { "type": "array", "items": { "type": "string" } }
              }
            },
            "outputs": {
              "allOf": [{ "$ref": "#/$defs/stageOutputsBase" }],
              "properties": {
                "config_dev":     { "type": ["string", "null"] },
                "config_release": { "type": ["string", "null"] },
                "config_env":     { "type": ["string", "null"] }
              }
            }
          }
        },
        "prdStage": {
          "allOf": [{ "$ref": "#/$defs/stageBase" }],
          "properties": {
            "inputs": {
              "type": "object",
              "required": ["req_hash", "prd_spec_hash", "source_req", "raw_input_refs"],
              "properties": {
                "req_hash":      { "type": ["string", "null"] },
                "prd_spec_hash": { "type": ["string", "null"] },
                "source_req":    { "type": ["string", "null"] },
                "raw_input_refs":{ "type": "array", "items": { "type": "string" } }
              }
            },
            "outputs": {
              "allOf": [{ "$ref": "#/$defs/stageOutputsBase" }],
              "properties": {
                "config_dev":     { "type": ["string", "null"] },
                "config_release": { "type": ["string", "null"] },
                "config_env":     { "type": ["string", "null"] },
                "features": {
                  "type": "array",
                  "description": "跨端聚合 feature 索引，由步骤4脚本从各端 prd-*.json 合并去重写入",
                  "items": {
                    "type": "object",
                    "required": ["feature_id", "name", "priority", "phase", "client_targets"],
                    "properties": {
                      "feature_id":     { "type": "string", "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$" },
                      "name":           { "type": "string", "minLength": 1 },
                      "priority":       { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
                      "phase":          { "type": "string", "enum": ["mvp", "standard", "complete", "future"] },
                      "client_targets": { "type": "array", "minItems": 1, "items": { "type": "string" } }
                    }
                  }
                }
              }
            }
          }
        },
        "stages": {
          "type": "object",
          "properties": {
            "setup": { "$ref": "#/$defs/setupStage" },
            "prd":   { "$ref": "#/$defs/prdStage" }
          },
          "additionalProperties": { "$ref": "#/$defs/stageBase" }
        }
      }
    }
    ```

    ---

### `config.json.schema.json`

    > 路径：`ai-std3/docs/schemas/config.json.schema.json`
    > 校验 `docs/config.dev.json` 与 `docs/config.release.json`，由 `sync-config.cjs` 写入后调用。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "config.json.schema.json",
      "title": "config.dev.json / config.release.json",
      "type": "object",
      "required": ["pipeline", "git", "build", "deploy", "smoke", "ui_e2e", "timeouts"],
      "properties": {
        "pipeline": {
          "type": "object",
          "required": ["autorun"],
          "properties": {
            "autorun": {
              "type": "object",
              "required": ["allow_destructive_deploy", "feature_max_parallel"],
              "properties": {
                "allow_destructive_deploy": { "type": "boolean" },
                "feature_max_parallel":    { "type": "integer", "minimum": 1, "maximum": 16, "default": 3 }
              }
            },
            "stages": {
              "type": "object",
              "properties": {
                "design": {
                  "type": "object",
                  "properties": {
                    "feature_max_parallel": { "type": "integer", "minimum": 1, "maximum": 16 }
                  }
                },
                "design_review": {
                  "type": "object",
                  "properties": {
                    "feature_max_parallel": { "type": "integer", "minimum": 1, "maximum": 16 }
                  }
                },
                "codegen": {
                  "type": "object",
                  "properties": {
                    "feature_max_parallel": { "type": "integer", "minimum": 1, "maximum": 16 }
                  }
                }
              }
            }
          }
        },
        "git": {
          "type": "object",
          "required": ["remote", "default_branch", "auto_commit"],
          "properties": {
            "remote":         { "type": "string", "minLength": 1 },
            "default_branch": { "type": "string", "minLength": 1 },
            "auto_commit":    { "type": "boolean" }
          }
        },
        "build": {
          "type": "object",
          "required": ["client_targets", "commands"],
          "properties": {
            "client_targets": {
              "type": "array",
              "items": { "type": "string" }
            },
            "commands": {
              "type": "object",
              "additionalProperties": { "type": "string" }
            }
          }
        },
        "deploy": {
          "type": "object",
          "required": ["enabled", "provider", "services"],
          "properties": {
            "enabled":  { "type": "boolean" },
            "provider": { "type": "string", "enum": ["cloudflare", "aws", "gcp", "manual"] },
            "domain":   { "type": "string" },
            "services": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["name", "client_target", "type"],
                "properties": {
                  "name":          { "type": "string", "minLength": 1 },
                  "client_target": { "type": "string" },
                  "type":          { "type": "string" },
                  "domain":        { "type": "string" },
                  "url":           { "type": "string" }
                }
              }
            }
          }
        },
        "smoke": {
          "type": "object",
          "required": ["checks"],
          "properties": {
            "checks": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["url", "method", "expected_status"],
                "properties": {
                  "url":             { "type": "string", "minLength": 1 },
                  "method":          { "type": "string", "enum": ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"] },
                  "expected_status": { "type": "integer", "minimum": 100, "maximum": 599 },
                  "body_contains":   { "type": ["string", "null"] },
                  "safe":            { "type": "boolean" }
                }
              }
            }
          }
        },
        "ui_e2e": {
          "type": "object",
          "required": ["enabled", "require_smoke_passed"],
          "properties": {
            "enabled":              { "type": "boolean" },
            "require_smoke_passed": { "type": "boolean" },
            "web": {
              "type": "object",
              "properties": {
                "base_url_from": { "type": "string" }
              }
            },
            "mobile": {
              "type": "object",
              "properties": {
                "bundle_id": { "type": "string" },
                "device":    { "type": "string" }
              }
            },
            "commands": {
              "type": "object",
              "properties": {
                "ui_test_max_fix_attempts": { "type": "integer", "minimum": 1 }
              }
            }
          }
        },
        "timeouts": {
          "type": "object",
          "required": ["stages"],
          "properties": {
            "stages": {
              "type": "object",
              "properties": {
                "design_s":  { "type": "integer", "minimum": 1 },
                "design_review_s": { "type": "integer", "minimum": 1 },
                "build_s":   { "type": "integer", "minimum": 1 },
                "codegen_s": { "type": "integer", "minimum": 1 },
                "deploy_s":  { "type": "integer", "minimum": 1 },
                "smoke_s":   { "type": "integer", "minimum": 1 },
                "ui_e2e_s":  { "type": "integer", "minimum": 1 }
              }
            }
          }
        }
      }
    }
    ```

    ---

### `prd-client.base.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-client.base.schema.json`
    > **不直接用于校验**，作为各端 schema 的公共基类，通过 `allOf` 引用。
    > 定义所有端共享的 `featureBase`、`auth` 等 `$defs`。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-client.base.schema.json",
      "title": "prd-client base definitions",
      "$defs": {
        "featureBase": {
          "type": "object",
          "required": ["feature_id", "name", "priority", "phase", "description", "acceptance"],
          "properties": {
            "feature_id":  {
              "type": "string",
              "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$",
              "description": "全局唯一；单端格式：TARGET-AREA-NNN（如 WEB-AUTH-001）；跨端格式：DOMAIN-AREA-NNN（如 AUTH-LOGIN-001）"
            },
            "name":        { "type": "string", "minLength": 1 },
            "priority":    { "type": "string", "enum": ["P0", "P1", "P2", "P3"] },
            "phase":       { "type": "string", "enum": ["mvp", "standard", "complete", "future"], "description": "发布阶段：mvp 最小可行版本 | standard 标准功能集 | complete 完整功能集 | future 未来规划" },
            "description": { "type": "string", "minLength": 1 },
            "acceptance":  {
              "type": "array",
              "minItems": 1,
              "items": { "type": "string", "minLength": 1 },
              "description": "验收标准，至少一条"
            }
          }
        },
        "auth": {
          "type": "object",
          "required": ["type"],
          "properties": {
            "type":  { "type": "string", "enum": ["jwt", "session", "oauth2", "none"] },
            "notes": { "type": "string" }
          }
        },
        "prdBase": {
          "type": "object",
          "required": ["client_target", "project_name", "features", "auth", "constraints"],
          "properties": {
            "client_target": { "type": "string", "minLength": 1 },
            "project_name":  { "type": "string", "minLength": 1 },
            "features":      {
              "type": "array",
              "minItems": 1,
              "items": { "$ref": "#/$defs/featureBase" }
            },
            "auth":        { "$ref": "#/$defs/auth" },
            "constraints": { "type": "array", "items": { "type": "string" } }
          }
        }
      }
    }
    ```

    ---

### `prd-web.json.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-web.json.schema.json`
    > 校验 `docs/prd-web.json`（`client_target` 值：`web` / `website` / `frontend`）。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-web.json.schema.json",
      "title": "prd-web.json",
      "type": "object",
      "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/prdBase" }],
      "properties": {
        "client_target": {
          "type": "string",
          "enum": ["web", "website", "frontend"]
        },
        "tech_stack": {
          "type": "object",
          "properties": {
            "framework": { "type": "string" },
            "css":       { "type": "string" },
            "bundler":   { "type": "string" }
          }
        },
        "features": {
          "type": "array",
          "minItems": 1,
          "items": {
            "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/featureBase" }],
            "properties": {
              "pages":     { "type": "array", "items": { "type": "string" } },
              "api_calls": { "type": "array", "items": { "type": "string" } }
            }
          }
        },
        "routing": {
          "type": "object",
          "properties": {
            "type":  { "type": "string", "enum": ["spa", "ssr", "ssg"] },
            "notes": { "type": "string" }
          }
        }
      }
    }
    ```

    ---

### `prd-backend.json.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-backend.json.schema.json`
    > 校验 `docs/prd-backend.json`（`client_target` 值：`backend` / `server` / `api`）。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-backend.json.schema.json",
      "title": "prd-backend.json",
      "type": "object",
      "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/prdBase" }],
      "properties": {
        "client_target": {
          "type": "string",
          "enum": ["backend", "server", "api"]
        },
        "tech_stack": {
          "type": "object",
          "properties": {
            "language":  { "type": "string" },
            "framework": { "type": "string" },
            "db":        { "type": "string" }
          }
        },
        "features": {
          "type": "array",
          "minItems": 1,
          "items": {
            "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/featureBase" }],
            "properties": {
              "endpoints": {
                "type": "array",
                "items": { "type": "string" },
                "description": "格式：METHOD /path，如 GET /api/notes"
              },
              "db_tables": { "type": "array", "items": { "type": "string" } }
            }
          }
        },
        "deploy": {
          "type": "object",
          "properties": {
            "platform":     { "type": "string" },
            "domain":       { "type": "string" },
            "service_type": { "type": "string" }
          }
        }
      }
    }
    ```

    ---

### `prd-mobile.json.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-mobile.json.schema.json`
    > 校验 `docs/prd-mobile.json`（`client_target` 值：`mobile` / `ios` / `android`）。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-mobile.json.schema.json",
      "title": "prd-mobile.json",
      "type": "object",
      "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/prdBase" }],
      "properties": {
        "client_target": {
          "type": "string",
          "enum": ["mobile", "ios", "android"]
        },
        "tech_stack": {
          "type": "object",
          "properties": {
            "framework":      { "type": "string" },
            "min_os_version": { "type": "string" }
          }
        },
        "features": {
          "type": "array",
          "minItems": 1,
          "items": {
            "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/featureBase" }],
            "properties": {
              "screens":   { "type": "array", "items": { "type": "string" } },
              "api_calls": { "type": "array", "items": { "type": "string" } }
            }
          }
        },
        "permissions": {
          "type": "array",
          "items": { "type": "string" },
          "description": "所需系统权限，如 camera、location"
        }
      }
    }
    ```

    ---

### `prd-admin.json.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-admin.json.schema.json`
    > 校验 `docs/prd-admin.json`（`client_target` 值：`admin`）。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-admin.json.schema.json",
      "title": "prd-admin.json",
      "type": "object",
      "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/prdBase" }],
      "properties": {
        "client_target": {
          "type": "string",
          "enum": ["admin"]
        },
        "tech_stack": {
          "type": "object",
          "properties": {
            "framework": { "type": "string" },
            "css":       { "type": "string" }
          }
        },
        "features": {
          "type": "array",
          "minItems": 1,
          "items": {
            "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/featureBase" }],
            "properties": {
              "pages": { "type": "array", "items": { "type": "string" } },
              "roles": {
                "type": "array",
                "items": { "type": "string" },
                "description": "可访问此功能的角色列表，如 super_admin、operator"
              }
            }
          }
        }
      }
    }
    ```

    ---

### `prd-default.json.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-default.json.schema.json`
    > 未知端类型时的**兜底 Schema**，只校验公共必填字段，允许额外属性，确保最低合规性。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-default.json.schema.json",
      "title": "prd-default.json（兜底）",
      "type": "object",
      "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/prdBase" }],
      "properties": {
        "client_target": {
          "type": "string",
          "minLength": 1
        },
        "features": {
          "type": "array",
          "minItems": 1,
          "items": {
            "allOf": [{ "$ref": "prd-client.base.schema.json#/$defs/featureBase" }],
            "properties": {
              "api_hints": { "type": "array", "items": { "type": "string" } }
            }
          }
        },
        "deploy": {
          "type": "object",
          "properties": {
            "domain":       { "type": "string" },
            "service_type": { "type": "string" }
          }
        }
      }
    }
    ```

    ---

### `prd-review-client-output.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-review-client-output.schema.json`
    > 校验 `<项目根>/.pipeline/prd-review-<client_target>.json`，各端 Agent 产出后由编排器立即 `Ajv.validate`。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-review-client-output.schema.json",
      "title": "prd-review-<client_target>.json",
      "type": "object",
      "required": ["client_target", "review", "outputs"],
      "properties": {
        "client_target": { "type": "string", "minLength": 1 },
        "review": {
          "type": "object",
          "required": ["summary", "feature_assessments"],
          "properties": {
            "summary": { "type": "string", "minLength": 1 },
            "feature_assessments": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": ["feature_id", "disposition"],
                "properties": {
                  "feature_id": {
                    "type": "string",
                    "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
                  },
                  "phase": {
                    "type": "string",
                    "enum": ["mvp", "standard", "complete", "future"]
                  },
                  "disposition": {
                    "type": "string",
                    "enum": ["include", "defer"]
                  },
                  "notes": { "type": "string" }
                }
              }
            },
            "deferred_features": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["feature_id", "reason"],
                "properties": {
                  "feature_id": {
                    "type": "string",
                    "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
                  },
                  "reason":   { "type": "string", "minLength": 1 },
                  "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] }
                }
              }
            },
            "blocking_issues": {
              "type": "array",
              "items": { "type": "object" }
            },
            "suggested_prd_spec_changes": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        },
        "outputs": {
          "type": "object",
          "required": ["decision", "features_reviewed", "features_deferred"],
          "properties": {
            "decision": {
              "type": "string",
              "enum": ["passed", "failed"]
            },
            "features_reviewed": { "type": "integer", "minimum": 0 },
            "features_deferred": { "type": "integer", "minimum": 0 }
          }
        }
      }
    }
    ```

    ---

### `prd-review-output.schema.json`

    > 路径：`ai-std3/docs/schemas/prd-review-output.schema.json`
    > 校验 `<项目根>/.pipeline/prd-review-output.json`（脚本合并各端产出后），由 `prd-review-validate.cjs` 在写入 `stages.prd_review` 前调用。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "prd-review-output.schema.json",
      "title": "prd-review-output.json",
      "type": "object",
      "required": ["review", "outputs", "blocking_issues", "conditions"],
      "properties": {
        "review": {
          "type": "object",
          "required": ["summary", "phase_plan"],
          "properties": {
            "summary": { "type": "string", "minLength": 1 },
            "phase_plan": {
              "type": "array",
              "minItems": 1,
              "items": {
                "type": "object",
                "required": ["phase", "feature_ids", "goal", "exit_criteria"],
                "properties": {
                  "phase": {
                    "type": "string",
                    "enum": ["mvp", "standard", "complete", "future"]
                  },
                  "feature_ids": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                      "type": "string",
                      "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
                    }
                  },
                  "goal": { "type": "string", "minLength": 1 },
                  "exit_criteria": {
                    "type": "array",
                    "minItems": 1,
                    "items": { "type": "string", "minLength": 1 }
                  }
                }
              }
            },
            "deferred_features": {
              "type": "array",
              "items": {
                "oneOf": [
                  { "type": "string", "minLength": 1 },
                  {
                    "type": "object",
                    "required": ["feature_id"],
                    "properties": {
                      "feature_id": {
                        "type": "string",
                        "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
                      },
                      "reason":  { "type": "string" },
                      "priority": { "type": "string", "enum": ["P0", "P1", "P2", "P3"] }
                    }
                  }
                ]
              }
            },
            "suggested_prd_spec_changes": {
              "type": "array",
              "items": { "type": "string" }
            }
          }
        },
        "outputs": {
          "type": "object",
          "required": ["decision"],
          "properties": {
            "decision": {
              "type": "string",
              "enum": ["passed", "failed"]
            }
          }
        },
        "blocking_issues": {
          "type": "array",
          "items": { "type": "object" }
        },
        "conditions": {
          "type": "array",
          "items": { "type": "object" }
        }
      }
    }
    ```

    ---

### `design.json.schema.json`

    > 路径：`ai-std3/docs/schemas/design.json.schema.json`
    > 校验 `docs/designs/<feature_id>.design.json`，各 feature Agent 完成后立即 `Ajv.validate`。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "design.json.schema.json",
      "title": "design.json",
      "type": "object",
      "required": [
        "feature_id",
        "client_target",
        "client_targets",
        "title",
        "phase",
        "file_plan",
        "api_outline",
        "acceptance",
        "dependencies",
        "risks"
      ],
      "properties": {
        "feature_id": {
          "type": "string",
          "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
        },
        "client_target": { "type": "string", "minLength": 1 },
        "client_targets": {
          "type": "array",
          "minItems": 1,
          "items": { "type": "string" }
        },
        "title": { "type": "string", "minLength": 1 },
        "phase": {
          "type": "string",
          "enum": ["mvp", "standard", "complete", "future"]
        },
        "file_plan": {
          "type": "object",
          "required": ["new_files", "modify_files"],
          "properties": {
            "new_files": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["path", "role"],
                "properties": {
                  "path": { "type": "string", "minLength": 1 },
                  "role": { "type": "string" }
                }
              }
            },
            "modify_files": {
              "type": "array",
              "items": {
                "type": "object",
                "required": ["path", "role"],
                "properties": {
                  "path": { "type": "string", "minLength": 1 },
                  "role": { "type": "string" }
                }
              }
            }
          }
        },
        "api_outline": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["method", "path", "summary"],
            "properties": {
              "method": { "type": "string" },
              "path":   { "type": "string" },
              "summary": { "type": "string" }
            }
          }
        },
        "data_outline": {},
        "acceptance": {
          "type": "array",
          "minItems": 3,
          "items": { "type": "string", "minLength": 1 }
        },
        "constraints": {
          "type": "array",
          "items": { "type": "string" }
        },
        "dependencies": {
          "type": "array",
          "items": {
            "type": "string",
            "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
          }
        },
        "risks": {
          "type": "array",
          "items": { "type": "string" }
        }
      }
    }
    ```

    ---

### `design-review-feature-output.schema.json`

    > 路径：`ai-std3/docs/schemas/design-review-feature-output.schema.json`
    > 校验 `.pipeline/design-review-<feature_id>.json`，各 feature 评审 Agent 完成后立即 `Ajv.validate`。

    ```json
    {
      "$schema": "http://json-schema.org/draft-07/schema#",
      "$id": "design-review-feature-output.schema.json",
      "title": "design-review-<feature_id>.json",
      "type": "object",
      "required": ["feature_id", "outputs", "gaps"],
      "properties": {
        "feature_id": {
          "type": "string",
          "pattern": "^[A-Z][A-Z0-9]*(-[A-Z][A-Z0-9]*)*-[0-9]{3}$"
        },
        "outputs": {
          "type": "object",
          "required": ["decision", "alignment_summary"],
          "properties": {
            "decision": {
              "type": "string",
              "enum": ["passed", "failed", "needs_design_fix"]
            },
            "alignment_summary": { "type": "string", "minLength": 1 }
          }
        },
        "gaps": {
          "type": "array",
          "items": {
            "type": "object",
            "required": ["message", "severity"],
            "properties": {
              "feature_id": { "type": "string" },
              "field":    { "type": "string" },
              "category": { "type": "string" },
              "severity": {
                "type": "string",
                "enum": ["blocking", "warning", "info"]
              },
              "blocking": { "type": "boolean" },
              "message":  { "type": "string", "minLength": 1 },
              "suggested_action": { "type": "string" }
            }
          }
        }
      }
    }
    ```
