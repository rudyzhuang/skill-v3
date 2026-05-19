# codegen 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [codegen 并行编排](../std3.md#32-codegen--create-ui-scenarios-并行编排) · [卡点速查](../std3.md#4-agent-卡点速查)

> 按 **feature** 派发 Agent，在 git worktree 内按 `design.json` 实现代码 + 自嵌测试。
>
> **长时间任务保障**：每个 feature worker 内置 **心跳 / FS / stdout 三路静默检测 + 挂钟硬上限**；任一路超阈视为 Agent 假死，worker **先快照保存已生成代码**（git wip commit + file_signatures），**再中断 Agent 进程**（SIGINT→SIGKILL），然后用 **恢复版提示词**（`codegen-impl-resume.md`）注入「上一 attempt 进度 + 禁止覆盖列表」继续执行；既避免长时间卡死，也保证已写入文件不被覆盖。
>
> **与 create-ui-scenarios 并行**：本 stage 与 [create-ui-scenarios](create-ui-scenarios.md) **无相互门闸**，design-review 释放某 group 后两条 track 同时启动；调度见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)。

## 脚本

脚本根目录前缀 **`ai-std3/scripts/`**：`stages/codegen.cjs`（编排入口，支持 **`--tick`**）、`libs/codegen-bootstrap.cjs`、`libs/codegen-worker.cjs`（长驻 worker）、`libs/codegen-validate.cjs`、`libs/http-smoke.cjs`（内联 smoke）。

```bash
node ai-std3/scripts/stages/codegen.cjs --project=<业务项目根绝对路径> [--tick] [--feature=<feature_id>]
```

> **不**派发 UI 场景、**不**评审代码；只产出 worktree 代码与 git commit。
>
> **内联 smoke（无独立 smoke stage）**：每个 feature 在 Agent 实现完成、可选 self-check 通过后，由 worker 调用 `libs/http-smoke.cjs` 执行与该 feature 相关的 `smoke.checks[]`（见 [§2.4.1](#241-内联-smoke)）；失败按 `self_check_failed` 同类处理（可 resume），**不**单独占用流水线 stage。

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.design_review.outputs.can_enter_codegen=true`（任一 group 已 release，与 create-ui-scenarios 同级） |
| **单 feature 入队** | `stages.design_review.features.<feature_id>.can_enter_codegen=true` 且 `docs/designs/<feature_id>.design.json` 存在并 Ajv 通过 |

> 与 create-ui-scenarios 共用同一组 feature 级释放条件；**不**互相阻塞。`docs/ui-scenarios/<feature_id>.scenarios.yaml` 为 codegen 的**软依赖**（若已就绪，Agent 可选读以理解验收边界；缺失**不**阻塞 codegen）。

## 并发配置（feature 级线程池）

模型与 `design` / `design-review` / `create-ui-scenarios` 完全一致，并发度与超时阈值取自业务项目 **`docs/config.dev.json`**：

```
effective_parallel = min(
  pipeline.stages.codegen.feature_max_parallel,
  pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.codegen.feature_max_parallel` | `3` | 本 stage 同时运行的 worker / Agent 上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | **全局天花板**（design / design-review / codegen / create-ui-scenarios 等合计在途 Agent 不得超过此值） |
| `timeouts.stages.codegen_s` | `1800` | 单 feature **累计挂钟硬上限**（含所有 attempt）；超出即 `failed`、退出码 `3` |
| `pipeline.stages.codegen.attempt_max_s` | `null`（派生：`floor(codegen_s / (max_resume_attempts + 1))`） | **单个 attempt** 内挂钟上限；超出按 `hang_kind=wall_timeout` 触发 resume |
| `pipeline.stages.codegen.agent_hang_threshold_s` | `180` | Agent **心跳静默**阈值；超出视为假死 |
| `pipeline.stages.codegen.fs_idle_threshold_s` | `240` | worktree 内**任意文件无写入**的阈值；超出视为假死 |
| `pipeline.stages.codegen.stdout_idle_threshold_s` | `120` | Agent **stdout/stderr 无新增字节**的阈值；超出视为假死 |
| `pipeline.stages.codegen.heartbeat_interval_s` | `30` | prompt 中向 Agent 申明的心跳最小频率 |
| `pipeline.stages.codegen.max_resume_attempts` | `2` | 单 feature 因假死/单步骤超时/自检失败触发的 resume 最大次数（首次 attempt 不计；超出后该 feature `failed`） |
| `pipeline.stages.codegen.graceful_kill_s` | `15` | 先 SIGINT，等待此秒后仍存活再 SIGKILL |
| `pipeline.stages.codegen.self_check.enabled` | `false` | 是否在 Agent 自报 `final` 后由 worker 跑构建/测试自检 |
| `pipeline.stages.codegen.self_check.commands` | `[]` | 自检命令（按 client_target 派发，如 `{"backend":"npm test","website":"npm run build"}`） |
| `pipeline.stages.codegen.self_check.timeout_s` | `300` | 自检命令单次超时 |
| `smoke.codegen.enabled` | `true` | 是否在 feature 完成路径上跑内联 HTTP smoke |
| `smoke.codegen.timeout_s` | `60` | 单 feature 内联 smoke 挂钟上限 |
| `smoke.checks[]` | `[]` | 检查项定义（与旧 smoke stage 同形；见 [deploy](deploy.md) 占位符说明） |

> 实现要求：固定大小 Worker 池，**禁止**按 feature 无限制起线程。每个在途 feature 对应**一个长驻** `codegen-worker.cjs` 子进程，持有 Agent 子进程与看门狗循环，**跨 `--tick` 存活**；`codegen.cjs --tick` 仅做「收割终态 + 启动新 worker」的轻量调度。组内若槽位不足，按 `dependency_groups[].topo_order` **优先启动依赖端 feature 的 codegen**（与 design / design-review / create-ui-scenarios 一致）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.design.outputs.design_specs[]` | feature 列表（与 `stages.design.features.<id>.status=completed` 一致） |
| `stages.design_review.outputs.released_groups[]` | 已 release 的 group / `features.<id>.can_enter_codegen` |
| `stages.prd.outputs.features[]` | feature 元数据（`client_targets`、优先级；与 `design.json.client_targets` 交叉校验） |
| `<业务项目根绝对路径>/docs/designs/<feature_id>.design.json` | 代码生成依据（`file_plan` / `api_outline` / `acceptance` / `constraints` / `dependencies`） |
| `<业务项目根绝对路径>/docs/ui-scenarios/<feature_id>.scenarios.yaml` | 可选（**软依赖**）：若已存在，仅供 Agent 理解验收边界 |
| `<业务项目根绝对路径>/docs/config.dev.json` | 并发上限、各项超时阈值、`heartbeat_interval_s`、`self_check.*` |
| `inputs/config.env` → `CURSOR_API_KEY` | `@cursor/sdk` Agent（`libs/invoke-sdk-agent.cjs` 同类封装） |

**CLI 过滤**：`--feature=<feature_id>` 仅处理单个 feature（失败后重跑）；仍遵守上游门闸。

**`--tick`**：单轮调度后返回，由 `run-pipeline.cjs` 与 `create-ui-scenarios --tick` 交替调用（见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)）。

## 处理逻辑

1. **`codegen-bootstrap.cjs`（bootstrap + 增量门控）**：
   - **先读旧值**：读取 `stages.codegen.inputs.release_bundle_hash`（骨架不存在则为 `null`）与 `inputs.design_bundle_hash`。
   - **计算新值**：
     - `release_bundle_hash_new`：取 `stages.design_review.features.<id>.can_enter_codegen=true` 的 feature_id 按字典序排列各自 `docs/designs/<id>.design.json` SHA-256，对该列表做 `JSON.stringify + SHA-256`（hash-of-hashes 方式，与其他 stage 一致）。
     - `design_bundle_hash_new`：同上，但范围为所有 `design.features.<id>.status=completed` feature 的 `design.json` SHA-256 列表。
   - **hash 门控（全段跳过）**：若两个新值均等于旧值 **且** `stages.codegen.status=completed` **且** 全部目标 feature 已 `status=completed` **且** 各 worktree HEAD == `features.<id>.commit`，则**整段跳过**（写 `stage_skipped` + 退出码 0，不启动任何 worker）。
   - **骨架处理 + 写入新值**（非跳过路径）：
     - 若骨架**不存在**：初始化 `stages.codegen`，含 `inputs.release_bundle_hash = release_bundle_hash_new`、`inputs.design_bundle_hash = design_bundle_hash_new`、`features.<feature_id>.{status=pending, group_id, branch, worktree_path=null, ...}`、`outputs.feature_artifacts[]`、`outputs.released_groups_seen[]`、`outputs.decision=pending`。
     - 若骨架**已存在**：写入新 hash 值；不重置已 `completed` feature 的状态。
   - **worktree 管理**（非跳过路径，对每个待 codegen feature）：
     - 若 worktree 路径 `<项目根>/.pipeline/worktrees/v3-<feature_id>/` **不存在**：`git worktree add` 创建，分支 `features/v3-<feature_id>`（**从 base 分支 fork**）；记录 `branch` / `worktree_path` / `base_commit`。
     - 若 worktree **已存在**（续跑/resume）：验证分支与 `features.<id>.branch` 一致；若不一致或 worktree 损坏则重建（删除旧 worktree 后重新 fork，**保留原 state.json 的 hang_history 与 progress 信息**）。
   - 按 `design.json.file_plan.new_files[]` 预建空文件与目录骨架；**保留已存在文件不动**（兼容续跑 / resume 场景）。
   - **确定性预检**（不调用 Agent，命中则该 feature **不**入池）：
     - `design.json.file_plan.new_files.length == 0` 且 `modify_files.length == 0` → `blocking`（无实现目标）；
     - `dependencies[]` 中某 id 对应 `stages.codegen.features.<dep>.status` ≠ `completed` 且本期亦未在 release → `pending_dep`（等依赖完成，由调度器按 group 拓扑序后续重试）。
   - **清理僵尸 worker state**：扫 `.pipeline/workers/codegen/*.state.json`，若 `status=running` 但对应 `pid` 不存活 → 将 state 文件标为 `crashed`，**同时**更新 `stages.codegen.features.<feature_id>.status=crashed`（使后续 tick 收割逻辑能识别）。
   - 写 `stages.codegen.status=running`；日志记录 `effective_parallel`、`pending_feature_ids[]`、`pending_dep_feature_ids[]`、`blocking_feature_ids[]`、`zombie_features_reset[]`。

2. **`codegen-worker.cjs`（单 feature 长驻 worker，feature 并发 + 看门狗 + 心跳 + resume）**：

   每个 worker 由 `codegen.cjs --tick` 通过 `spawn`（**detached**）拉起，占用一个 `effective_parallel` 槽位直至 feature 终态；worker 进程**跨 `--tick` 存活**，自身完整托管 Agent 生命周期：

   ```text
   worker init
     ├─ 读 design.json + scenarios.yaml(可选) + 上次 state(若续跑)
     ├─ attempt_index = 1（首次）或 已存 state.attempt_index（续跑/resume）
     ├─ 启动 Agent 子进程：
     │     - attempt_index == 1 → prompt = ai-std3/prompts/codegen-impl.md
     │     - attempt_index >= 2 → prompt = ai-std3/prompts/codegen-impl-resume.md
     │     - cwd = worktree_path
     │     - 通过 .codegen-resume-context.json 注入恢复上下文（仅 resume）
     ├─ 看门狗循环（每 10s tick）：
     │     - 检查 stop.signal → 优雅停止（不强杀 Agent，等其完成当前一行后再 SIGINT）
     │     - 读 Agent stdout JSON 行 → 解析 heartbeat / progress / final
     │     - 比对 last_heartbeat_age / fs_idle / stdout_idle / wall_time(attempt) / wall_time(total)
     │     - 任一阈值超出 → 触发 hang 处理（snapshot → interrupt → resume 或 failed）
     │     - Agent 自然退出 → 跳出
     ├─ Agent 退出后：
     │     - 可选 self-check（build/test）；失败按 hang 走 resume
     │     - 成功 → git commit + 写 features.<id>.status=completed
     └─ 写终态到 .pipeline/workers/codegen/<feature_id>.state.json，worker 进程退出 0
   ```

   ### 2.1 心跳协议（worker ↔ Agent 弱契约）

   Agent 须以 **JSON Lines** 形式向 stdout 输出**心跳**与**最终结果**（由 prompt 显式约束）：

   ```jsonl
   {"type":"heartbeat","ts":"2026-05-18 08:30:15.123 +0800","phase":"editing","files_touched":["src/x.ts"],"acceptance_done":["AC1"],"acceptance_pending":["AC2","AC3"]}
   {"type":"heartbeat","ts":"2026-05-18 08:30:46.012 +0800","phase":"running_command","command":"npm test"}
   {"type":"final","status":"completed","acceptance_done":["AC1","AC2","AC3"],"files_changed":["src/x.ts","tests/x.test.ts"]}
   ```

   | 字段 | 说明 |
   | --- | --- |
   | `type` | `heartbeat` \| `final` |
   | `phase` | `editing` \| `writing` \| `testing` \| `running_command` \| `self_check` \| `thinking` |
   | `command` | 当 `phase=running_command`，附本次命令文本（≥30s 命令前后必须各打一次心跳） |
   | `acceptance_done[]` / `acceptance_pending[]` | 当前已完成 / 待完成的 `design.json.acceptance[]` 条目编号或全文（任选其一，需与 design 中条目可对照） |
   | `files_touched[]` | 本 attempt 中已修改 / 新增的文件相对路径 |

   worker 同步跟踪四个时间戳：

   | 信号 | 来源 |
   | --- | --- |
   | `last_heartbeat_at` | 最近一条合法 `heartbeat` JSON 行 |
   | `last_fs_mtime_at` | worktree 内任意文件最新 `mtime`（`chokidar` 监听，排除 `.git/`、`node_modules/`、`.codegen-resume-context.json`） |
   | `last_stdout_at` | Agent 进程 stdout/stderr 最近一次有字节到达 |
   | `wall_started_at(attempt)` / `wall_started_at(total)` | 本 attempt / 本 feature 整体启动时间 |

   任一项与当前时刻差值超过对应阈值，即视为 **hang**，记 `hang_kind`：

   | `hang_kind` | 阈值键 |
   | --- | --- |
   | `no_heartbeat` | `agent_hang_threshold_s` |
   | `fs_idle` | `fs_idle_threshold_s` |
   | `stdout_idle` | `stdout_idle_threshold_s` |
   | `wall_timeout` | `attempt_max_s`（单 attempt 上限） |
   | `total_timeout` | `timeouts.stages.codegen_s`（全 feature 累计上限，**不**再 resume，直接 `failed`） |
   | `self_check_failed` | 自检脚本退出码非 0（详见 2.4） |

   ### 2.2 Hang 处理（中断 + 快照 + 恢复，绝不覆盖已生成代码）

   1. **打日志**：`agent_hang_detected`（WARN），meta 含 `hang_kind`、`last_heartbeat_age_s`、`fs_idle_s`、`stdout_idle_s`、`elapsed_attempt_s`、`elapsed_total_s`、`attempt_index`。
   2. **快照已完成工作**（在中断 Agent **之前**完成，避免 SIGKILL 丢失内存中未刷盘的进度记录；文件系统部分已由 Agent 自行 fsync 保障）：
      - 计算 `file_signatures[]`：worktree 内**全部受跟踪 + 新增**文件的 `{path, sha256, size, mtime}`；
      - 在 worktree 执行 `git add -A && git commit --no-verify -m "wip(<feature_id>): attempt <n> snapshot before resume"`；若无 diff 则跳过 commit（不产生空 commit）；记录 `snapshot_commit`（HEAD sha）；
      - 收集 `progress`：以最近一条 heartbeat 的 `acceptance_done[]` / `acceptance_pending[]` / `files_touched[]` / `phase` / `command` 为准；若未上报，则取 `git diff <base_commit>..HEAD --name-only` 作为兜底；
      - 追加一条 `hang_history[]` 记录到 `features.<feature_id>`：`{ attempt_index, hang_kind, detected_at, snapshot_commit, files_at_snapshot: N }`。
   3. **中断 Agent 进程**：
      - 先 `SIGINT` → 等待 `graceful_kill_s` 秒；仍存活 → `SIGKILL`；
      - 关闭 stdin/stdout/stderr 与文件监听器；
      - 打 `agent_interrupted`（WARN）。
   4. **判定是否 resume**：
      - 若 `hang_kind == total_timeout` 或 `attempts_used >= max_resume_attempts` → **不** resume；写 `features.<id>.status=failed`、`last_error: <hang_kind>`、`timed_out: true`、`exit_code: 3`；worker 退出 1。
      - 否则 `attempt_index += 1`，进入 **resume**（2.3）。

   ### 2.3 Resume Agent 启动（恢复版提示词 + 禁止覆盖列表）

   1. 在 worktree 写入 **`.codegen-resume-context.json`**（仅本 attempt 期间存在，attempt 结束后由 worker 删除；**不**纳入 git 跟踪，已加入 worktree `.git/info/exclude`）：

      ```json
      {
        "feature_id": "NOTE-CRUD-001",
        "attempt_index": 2,
        "previous_hang_kind": "no_heartbeat",
        "snapshot_commit": "<sha>",
        "base_commit": "<sha>",
        "file_signatures": [
          { "path": "src/routes/notes.ts", "sha256": "...", "size": 1842, "mtime": "..." },
          { "path": "tests/notes.test.ts", "sha256": "...", "size": 612,  "mtime": "..." }
        ],
        "progress": {
          "acceptance_done": ["AC1", "AC3"],
          "acceptance_pending": ["AC2"],
          "files_touched": ["src/routes/notes.ts", "tests/notes.test.ts"],
          "last_phase": "testing",
          "last_command": "npm test"
        },
        "acceptance_full": [
          "AC1: 用户可创建笔记并持久化",
          "AC2: 用户可编辑、删除自己的笔记",
          "AC3: 列表分页返回正确 total"
        ],
        "do_not_overwrite": [
          "src/routes/notes.ts",
          "tests/notes.test.ts"
        ],
        "constraints": [
          "仅对 do_not_overwrite[] 列出的文件做增量 edit；禁止清空或重写",
          "禁止删除/重命名 do_not_overwrite[] 中任何文件",
          "禁止 git reset --hard / git checkout <path> / rm 等抹除操作",
          "仅完成 progress.acceptance_pending[]；progress.acceptance_done[] 不重复实现",
          "心跳间隔必须 ≤ heartbeat_interval_s 秒；外部命令前后各打一次心跳"
        ]
      }
      ```

   2. 拉起新 Agent 子进程，`prompt = ai-std3/prompts/codegen-impl-resume.md`，并通过 prompt 模板强制要求 Agent：
      - **先读** `.codegen-resume-context.json` 与 `git log -p <base_commit>..HEAD` 理解上次进度；
      - **核验 file_signatures**：若发现文件已被外部修改（hash 不一致），打心跳 `phase:"reconciling"` 并以现状为准，不视为冲突；
      - **禁止抹除已生成代码**：`do_not_overwrite[]` 中的文件**只能 edit**（增量 diff），不可清空、删除或重命名；
      - **禁止重新创建**：`do_not_overwrite[]` 列表中的路径不得作为「新建」目标；
      - 完成剩余 `acceptance_pending[]`；
      - 完成后输出 `{"type":"final","status":"completed","acceptance_done":[...全部 AC],"files_changed":[...]}`；
      - 若 Agent 自行判定**无法**在不破坏现有代码的前提下继续 → 输出 `{"type":"final","status":"needs_human","reason":"<人话原因>","blockers":[...]}`，worker 据此写 `failed`、`exit_code: 4`（按卡点速查由人介入或下次 resume 调大配额）。

   3. 重新进入看门狗循环（2.1）。

   ### 2.4 Agent 自然退出后的处理

   - 收到 `{"type":"final","status":"completed",...}` 后 worker：
     1. 校验 `git status` 有变更（无变更 → 视为 `self_check_failed`，触发 resume）；
     2. 若 `pipeline.stages.codegen.self_check.enabled=true`：按 `design.json.client_target` 在 `commands` 中查命令并执行（超时 `self_check.timeout_s`）；
        - 失败 → `hang_kind=self_check_failed`，附 `stderr_tail`（末 200 行），按 2.2 走 resume（带回 `do_not_overwrite[]` + 错误日志）；
        - 通过 → 继续；
     3. **[§2.4.1 内联 smoke](#241-内联-smoke)**（`smoke.codegen.enabled=true` 时）；
     4. `git add -A && git commit -m "feat(<feature_id>): implement per design"`；
     5. 写 `features.<id>`：`status=completed`、`commit`、`files_changed[]`、`design_hash`、`file_signatures[]`、`attempts_used`、`duration_ms`、`smoke_passed`、`smoke_checks[]`；
     6. 删除 `.codegen-resume-context.json`；
     7. worker 退出 0。

   #### 2.4.1 内联 smoke

   在 **git commit 之前**执行（避免未通过 smoke 的代码进入 commit；若 smoke 仅依赖已启动的本地服务，Agent 须在 final 前已拉起进程并在 heartbeat 中报告 `phase:"running_command"`）。

   1. 从 `docs/config.dev.json` → `smoke.checks[]` 筛选与本 feature 相关的项：
      - `check.client_targets[]` 与 `design.json.client_targets[]` 有交集；或
      - 未声明 `client_targets` 且 `check.scope=codegen`（或缺省视为 codegen 阶段可用）；
      - 排除仅含 `{deploy.services.*}` 占位符、且无 `codegen.base_url` / 绝对 URL 的项（留给 deploy 内联）。
   2. 解析 `base_url`：优先 `smoke.codegen.base_url`；否则 `check.url` 中的绝对 URL；否则 `http://127.0.0.1:<port>`（`port` 来自 worker 记录的 `local_dev_port`，若无则跳过并 `WARN`）。
   3. 调用 `libs/http-smoke.cjs`（与 publish3 同语义：GET/HEAD 或 `safe=true` 的 POST）；超时 `smoke.codegen.timeout_s`。
   4. 结果写入 `features.<feature_id>.smoke_checks[]`：`{ name, url, status_code, passed, body_snippet }`；汇总 `smoke_passed`（bool）。
   5. 任一必检项失败 → `hang_kind=smoke_failed`（等同质量门），按 §2.2 resume；stage 级退出码 **4**。
   6. 打 `smoke_inline_complete`（INFO）或 `smoke_inline_failed`（ERROR）。

   `smoke.codegen.enabled=false` 或筛选后 `checks.length=0` → 跳过，`smoke_passed=true`，`smoke_skipped_reason` 记入 meta。
   - 收到 `{"type":"final","status":"needs_human",...}` 或 `{"type":"final","status":"failed",...}` 或 Agent 进程退出码 ≠ 0 且无 final：
     - 若 `attempts_used < max_resume_attempts` → 按 hang 走 resume（`hang_kind=agent_error`）；否则 `features.<id>.status=failed`、`exit_code: 4`。

   ### 2.5 `--tick` 调度（`codegen.cjs --tick`）

   1. **检查 stop.signal**：存在则不启动新 worker，打 `pipeline_stop`，退出 5；已在途 worker 由其自身的看门狗在下一轮检测信号并优雅停止。
   2. **收割**：遍历 `.pipeline/workers/codegen/*.state.json`：
      - 终态（`completed` / `failed` / `crashed`）→ 落入 `stages.codegen.features.<id>`，归档 state.json 至 `.pipeline/workers/codegen/archive/<feature_id>.<attempt_index>.state.json`，释放槽位；
      - `running` 但 `pid` 不存活 → 标 `crashed`、`reason: "worker process crashed"`，释放槽位；若 `attempts_used < max_resume_attempts` 下一轮 tick 重新调度该 feature；否则 `failed`。
   3. **启动**：在 `effective_parallel` 与全局上限剩余槽位内，按以下优先级挑选就绪 feature：
      a. 同 group 内、依赖已 `completed` 且 `topo_order` 靠前者；
      b. 已 release 但尚未启动过 worker 者；
      c. 上一轮 `crashed` 且未触顶 `max_resume_attempts` 者（注入上次 state.json 的快照，按 resume 启动）。
   4. 打 `agent_batch_start` / `agent_batch_complete`（meta 含本轮新增 + 收割汇总）。
   5. 退出 0。

   ### 2.6 单 feature 输入与 Agent 硬约束

   **单 feature 输入**（首次 attempt）：
   - `<worktree_path>` 下源码（多为空骨架）；
   - 通过 prompt 注入只读引用：`docs/designs/<feature_id>.design.json`、可选 `docs/ui-scenarios/<feature_id>.scenarios.yaml`、依赖 feature 已完成的 `docs/designs/<dep>.design.json`（不读其代码 worktree，避免误抄）；
   - `docs/config.dev.json` 中的 `heartbeat_interval_s` 数值（用于 prompt 渲染）。

   **resume attempt 另读**：`.codegen-resume-context.json`、`git log -p <base_commit>..HEAD`。

   **Agent 硬约束（首次 + resume 通用）**：
   - **不得**新增 `design.json.file_plan` 之外的文件；只能 `edit` `modify_files[]`、`create` `new_files[]`；
   - **不得**修改 `docs/designs/` / `docs/prd-*` / `docs/ui-scenarios/` / `.pipeline/` / `.git/`；
   - **不得**调用网络服务（项目内 `npm i <dep>` / `flutter pub add <dep>` 允许，但须在 heartbeat 中报 `phase:"running_command"` + `command`）；
   - API 端点与 `api_outline` 一致；实现内嵌单元 + 集成测试（**无独立 test stage**，但 Agent 须自我校验）；
   - 心跳频度 ≤ `heartbeat_interval_s`；任何 ≥ 30s 的外部命令前后必须各打一次心跳；
   - **resume 时**：严格遵守 `.codegen-resume-context.json` 的 `do_not_overwrite[]` 与 `constraints[]`。

   > **稳定性保障**：
   >
   > | 机制 | 说明 |
   > | --- | --- |
   > | **按 feature 哈希门控** | 若 `features.<id>.design_hash == sha256(design.json)` 且 `status=completed` 且 worktree HEAD == `features.<id>.commit` → 跳过该 feature worker（`agent_skipped`） |
   > | **三路静默检测** | 心跳 / FS / stdout 三路阈值各自独立；任一超阈触发 hang，不依赖 Agent 自报 |
   > | **快照 + resume** | 中断**前**先 wip commit + file_signatures；resume Agent 读 `.codegen-resume-context.json` 与 `git log`，禁止覆盖已生成代码 |
   > | **attempt 与总挂钟分层** | 单 attempt 触顶 → resume；全 feature 累计触顶 → 直接 `failed`（不再 resume），退出码 `3` |
   > | **僵尸 worker 自愈** | worker pid 死亡但 state `running` → 下一轮 tick 标 `crashed` 并可 resume 一次（计入 `attempts_used`） |
   > | **stop.signal 优雅停止** | 看门狗每 10s 检查；存在则 SIGINT Agent 并等当前一行结束，写 `status=stopped`，**不**写 completed |
   > | **build/test 自检（可选）** | 通过后才 commit；失败按 hang 走 resume（携带 stderr_tail 注入 resume 上下文） |

3. **`codegen-validate.cjs`（merge + finalize）**：
   - 遍历目标 feature_ids：每个 feature 必须 `features.<id>.status ∈ {completed, failed, skipped}` 且无在途 worker（`.pipeline/workers/codegen/<id>.state.json` 不在 `running`）。
   - 对 `completed`：校验 `commit` 存在、worktree HEAD == `commit`、`files_changed[]` 非空、`design_hash == sha256(design.json)`、`file_signatures[]` 所列文件全部存在；若 `smoke.codegen.enabled=true` 且该 feature 有匹配 checks → `smoke_passed=true`。
   - 汇总 `outputs.feature_artifacts[]`：`{ feature_id, group_id, branch, commit, files_changed_count, attempts_used, hang_count, duration_ms }`。
   - **门闸（两级）**：
     - **feature 级**：worker 终态 `failed` → `features.<id>.status=failed`，记 `last_error`、`hang_history[]`、`attempts_used`；该 feature **不**回滚 create-ui-scenarios（已并行进行），但其 `code-review` 必然失败 → 由 [report](report.md) 按 feature 标记。
     - **stage 级**：全部目标 feature `completed` → `status=completed`、`outputs.decision=passed`、`validation.passed=true`；存在任何 `failed` → `status=failed`、`outputs.decision=needs_fix`、退出码 **4**（按卡点速查重跑 `--from-stage=codegen --feature=<id>`）。
   - 写 `outputs.total_attempts`、`outputs.resume_count`（`inputs.release_bundle_hash` / `design_bundle_hash` 已由 bootstrap 写入，此处无需重算）。
   - 生成 `.pipeline/reports/codegen-summary.md`（每 feature 一行：分支、commit、`attempts_used`、`hang_history` 摘要、耗时；含全 stage `total_attempts` / `resume_count` / `failed_count`）。
   - 失败时：`--from-stage=codegen --feature=<id>` 重跑（worker 会读取上次 state，自动以 resume 方式继续，**不**清空 worktree）。

## 日志事件

> 步骤 2 按 feature 并发：每轮 `--tick` 打 `agent_batch_start` / `agent_batch_complete`；每个 feature worker 独立 `agent_start` / `agent_complete` / `agent_failed` / `agent_skipped` / `agent_retry`，`meta.feature_id` 与 `meta.attempt_index` **必填**。

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间）, `parallel_with: ["create_ui_scenarios"]` |
| 步骤1：初始化/更新 | `file_created` / `file_updated` | INFO | `path`（stages.codegen），`zombie_features_reset[]` |
| 步骤1：worktree 准备 | `file_created` | INFO | `feature_id`, `worktree_path`, `branch`, `base_commit` |
| 步骤1：确定性预检 | `validation_pass` / `validation_fail` | INFO/ERROR | `pending_feature_ids[]`, `blocking_feature_ids[]`, `pending_dep_feature_ids[]` |
| 步骤1：bundle 哈希 | `hash_check` | INFO | `release_bundle_hash`, `design_bundle_hash`, `stored_hash`, `computed_hash`, `hit` |
| 步骤1：整体跳过 Agent | `stage_skipped` | INFO | `reason: "design_bundle_hash matched, all features fresh"` |
| 步骤1：清理僵尸 worker | `validation_pass` | WARN | `crashed_feature_ids[]` |
| 步骤1：写 running | `file_updated` | INFO | `status: "running"`, `effective_parallel` |
| 步骤2：本轮调度开始 | `agent_batch_start` | INFO | `batch_id: "codegen-tick-<n>"`, `feature_ids[]`, `agents_total`, `agents_skipped[]`, `effective_parallel`, `inflight_after_tick` |
| 步骤2：worker 启动 | `agent_start` | INFO | `agent_id: "codegen-worker-<feature_id>"`, `feature_id`, `attempt_index: 1`, `prompt: "codegen-impl.md"`, `worktree_path`, `branch`, `pid`, `input_files: ["designs/<feature_id>.design.json"]` |
| 步骤2：心跳收到 | `agent_heartbeat` | DEBUG | `feature_id`, `attempt_index`, `phase`, `acceptance_done_count`, `acceptance_pending_count`, `files_touched_count`, `command`（若有） |
| 步骤2：单 feature 跳过 | `agent_skipped` | INFO | `agent_id`, `feature_id`, `reason: "design_hash matched, prior completed"` |
| 步骤2：检测到卡死 | `agent_hang_detected` | WARN | `agent_id`, `feature_id`, `attempt_index`, `hang_kind`, `last_heartbeat_age_s`, `fs_idle_s`, `stdout_idle_s`, `elapsed_attempt_s`, `elapsed_total_s` |
| 步骤2：快照已写 | `file_updated` | INFO | `feature_id`, `attempt_index`, `snapshot_commit`, `file_signatures_count`, `acceptance_done_count`, `acceptance_pending_count` |
| 步骤2：进程中断 | `agent_interrupted` | WARN | `agent_id`, `feature_id`, `attempt_index`, `signal: "SIGINT" \| "SIGKILL"`, `wait_ms`, `exit_code` |
| 步骤2：resume 触发 | `agent_retry` | WARN | `agent_id`, `feature_id`, `attempt`（=新 `attempt_index`）, `reason: <hang_kind>`, `prompt: "codegen-impl-resume.md"`, `do_not_overwrite_count` |
| 步骤2：self-check 失败 | `validation_fail` | WARN | `feature_id`, `attempt_index`, `command`, `exit_code`, `stderr_tail`（≤200 行） |
| 步骤2：内联 smoke | `smoke_inline_complete` / `smoke_inline_failed` | INFO/ERROR | `feature_id`, `checks_total`, `checks_passed`, `failures[]`, `base_url` |
| 步骤2：worker 崩溃 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `reason: "worker process crashed"`, `pid`, `attempts_used` |
| 步骤2：单 feature 完成 | `agent_complete` | INFO | `agent_id`, `feature_id`, `duration_ms`, `attempts_used`, `commit`, `files_changed`, `output_files: [...]` |
| 步骤2：单 feature 失败 | `agent_failed` | ERROR | `agent_id`, `feature_id`, `exit_code: 3 \| 4`, `reason`, `timed_out`（bool）, `attempts_used`, `hang_history[]` |
| 步骤2：本轮调度结束 | `agent_batch_complete` | INFO | `batch_id`, `agents_succeeded[]`, `agents_failed[]`, `agents_skipped[]`, `duration_ms`, `inflight_remaining` |
| 步骤2：git commit | `git_commit` | INFO | `feature_id`, `branch`, `commit_hash`, `files_changed` |
| 步骤3：合并 | `file_updated` | INFO | `feature_artifacts_count`, `failed_features_count`, `total_attempts`, `resume_count` |
| 步骤3：门闸未通过 | `validation_fail` | ERROR | `decision: "needs_fix"`, `failed_feature_ids[]`, `exit_code: 4` |
| 步骤3：门闸通过 | `validation_pass` | INFO | `decision: "passed"`, `features_total` |
| 步骤3：写完成态 | `file_updated` | INFO | `status: "completed"`, `release_bundle_hash` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0`, `features_total`, `failed_count` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`, `exit_code`, `reason`, `failed_feature_id`（若有） |

## 退出码（本 stage）

| 码 | 场景 | stages.codegen.status |
| ---: | --- | --- |
| 0 | 成功（所有 feature completed） | `completed` |
| 0 | `--tick` 单轮完成（部分在途） | `running` |
| 0 | 全局 hash 命中整段跳过 | `completed`（不变） |
| 1 | 上游门闸未满足、worktree 创建失败 | `failed` |
| 3 | 单 feature 累计挂钟超 `codegen_s` | feature 级 `failed`；stage 级视全局 |
| 4 | 存在 `failed` feature、内联 smoke 失败、resume 用尽 | `failed` |
| 5 | 检测到 `stop.signal`（完成当前原子操作后中止） | `stopped` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/worktrees/v3-<feature_id>/` | 每 feature 的 git worktree（代码 + 测试 + wip 快照 commit 历史） |
| `.pipeline/workers/codegen/<feature_id>.state.json` | worker 运行态快照（每次心跳与转态写入；feature 终态后归档至 `archive/<feature_id>.<attempt_index>.state.json`） |
| `.pipeline/stages.json` | `stages.codegen`：`features.<id>`（含 `smoke_passed` / `smoke_checks[]` 等）、`outputs.feature_artifacts[]`、`outputs.smoke_summary`（`passed_count` / `failed_count`）、`validation.passed` |
| `.pipeline/reports/codegen-summary.md` | 每 feature 一行人话摘要（分支、commit、attempts、卡死次数、耗时、失败原因） |

## 解锁

| 粒度 | 条件 | 效果 |
| --- | --- | --- |
| **feature → code-review** | `features.<id>.status=completed` 且 `commit` 非空 | 该 feature 进入 code-review 队列 |
| **stage 完成** | 全部目标 feature `status ∈ {completed, failed}`（无在途 worker） | `stages.codegen.status=completed`（全 pass）或 `failed`（任一 failed） |
| **与 create-ui-scenarios 关系** | **无相互门闸**（见 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排)） | 同 group 内 feature 同时进入两条 track；codegen 完成不等待场景，反之亦然 |
| **与 code-review 关系** | `code-review` 启动前须 `codegen.status=completed`（编排级 join） | 由 `run-pipeline.cjs` 在进入 code-review 前确认；任一 feature `failed` → code-review 不启动，退出码 `4` 提示重跑 codegen |

---
