# ui_e2e 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 在 **`create-ui-scenarios`** 与 **`deploy`** 均就绪后，按 **`docs/ui-scenarios/<feature_id>.scenarios.yaml`** 中的场景定义，用 **MCP** 驱动各端 UI 验收。
>
> **执行器**：`website` / `admin`（`platform=web`）→ **Browser MCP**（`cursor-ide-browser`）；`mobile`（`platform=android|ios`）→ **Dart MCP**（`user-dart`）。**`desktop` 本期不实现**，相关场景记 `skipped`（`desktop_not_implemented`）。
>
> **无独立 smoke stage**：HTTP 冒烟已内联于 [codegen](codegen.md) / [deploy](deploy.md)；本 stage 仅做 **UI 交互**验收。
>
> **失败闭环**：场景失败 → Agent 分诊（`ui-e2e-triage`）→ 可修 **skill 内 codegen 提示词**（独立提交推送）和/或 **业务仓 worktree 代码**，再对所属 **feature** 触发子链：`code-review` → `merge_push` → `build` → `deploy` → `ui_e2e`（仅重跑失败场景或整 feature，见 [§4](#4-失败分诊与-feature-修复子链)）。

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `ui-e2e.cjs` | 编排：bootstrap → 场景并行执行 → validate；失败时触发分诊与子链 |
| `ui-e2e-bootstrap.cjs` | 门闸、展开场景队列、MCP/设备预检、写 `running` |
| `lib/ui-e2e-runner.cjs` | **单场景**执行：解析 YAML 步骤、调 MCP、写日志与截图、判定 `expect[]` |
| `lib/ui-e2e-triage.cjs` | 失败时派发 Agent，产出 `ui-e2e-triage-<feature_id>.json`，驱动修复 |
| `lib/ui-e2e-repair-chain.cjs` | 对单 feature 顺序 spawn：`code-review` → `merge_push` → `build` → `deploy` → `ui-e2e` |
| `lib/skill-prompt-publish.cjs` | **仅**在 `fix_prompt` 路径：于 **ai-std3 skill 目录** git commit + push 提示词变更（**不**动业务仓） |
| `ui-e2e-validate.cjs` | 汇总场景结果、报告、stage 门闸 |

> 实现目录前缀：`ai-std3/scripts/`。

```bash
node ai-std3/scripts/lib/ui-e2e.cjs --project=<业务项目根绝对路径> [--feature=<id>] [--scenario=<id>]
```

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.create_ui_scenarios.status ∈ {completed, skipped}` **且** `stages.deploy.status ∈ {completed, skipped}` |
| **配置** | `ui_e2e.enabled=true`；否则 `status=skipped`、退出 **0** |
| **场景来源** | 对每个候选 `feature_id`：`stages.create_ui_scenarios.features.<id>.status=completed` 且 `docs/ui-scenarios/<id>.scenarios.yaml` 存在并通过 Ajv |
| **代码来源** | `stages.codegen.features.<id>.status=completed`（无代码则该 feature 下全部场景 `skipped`，`reason: no_codegen`） |
| **部署 URL** | `platform=web` 场景须能解析 `base_url`（来自 `deploy.outputs.services[]`）；`deploy.skipped` 时 web 场景须 YAML 内写绝对 URL 或 config 覆盖 |
| **deploy 内联 smoke**（可选） | `ui_e2e.require_deploy_smoke_passed=true`（默认）时须 `deploy.outputs.inline_smoke_passed=true`（`deploy` 跳过时视为满足） |
| **停止信号** | 启动时 `stop.signal` → 退出 **5** |

**编排级 join**（`run-pipeline.cjs` 在进入本 stage 前校验，与 [§3.2](../std3.md#32-codegen--create-ui-scenarios-并行编排) 一致）：

```text
create_ui_scenarios ∈ {completed, skipped}
AND deploy ∈ {completed, skipped}
AND (require_deploy_smoke_passed=false OR deploy.outputs.inline_smoke_passed=true)
```

## 并发配置（按场景并行）

调度粒度为 **`scenario`**（`scenarios[].id`），按端类型选用 MCP，**web 与 mobile 可混合并行**（受全局天花板约束）。

```
effective_parallel = min(
  pipeline.stages.ui_e2e.scenario_max_parallel,
  pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.ui_e2e.scenario_max_parallel` | `3` | 同时执行的场景数上限 |
| `pipeline.autorun.feature_max_parallel` | `3` | 全局 Agent/MCP 并发天花板 |
| `timeouts.stages.ui_e2e_s` | `1800` | **整个 ui_e2e stage** 挂钟上限（含修复子链重入前首轮） |
| `timeouts.stages.ui_e2e_scenario_s` | `600` | **单场景**执行上限；超时 → 该场景 `failed`、`exit_code: 3` |
| `ui_e2e.commands.scenario_max_fix_attempts` | `2` | 单场景 MCP 执行失败后的即时重试（不含分诊后子链） |
| `pipeline.stages.ui_e2e.triage_max_attempts` | `2` | 单 feature 分诊 + 修复循环上限 |
| `pipeline.stages.ui_e2e.prompt_fix_max_attempts` | `1` | 每次分诊最多触发几次 skill 提示词修补 + push |
| `pipeline.stages.ui_e2e.fail_fast` | `false` | `true` 时首场景失败即不再启动新场景（在途跑完） |

> **mobile 预检**：在**首次**调度 `platform ∈ {android, ios}` 场景前，脚本须确认 Dart MCP 可用、设备/模拟器在线（`ui_e2e.mobile.*`）；不满足 → 该 feature 下 mobile 场景批量 `skipped`（`mobile_env_unsatisfied`），**不**记 stage 失败（除非 `ui_e2e.strict_mobile=true`）。

## 输入

| 来源 | 要求 |
| --- | --- |
| `docs/ui-scenarios/<feature_id>.scenarios.yaml` | [create-ui-scenarios](create-ui-scenarios.md) 产出；Ajv：`ui-scenarios.yaml.schema.json` |
| `stages.deploy.outputs.services[]` | 解析 `{base_url}`、`ui_e2e.web.<client_target>.base_url_from` |
| `stages.codegen.features.<feature_id>` | `worktree_path` / `commit` / `branch`（修复子链与日志关联） |
| `docs/config.dev.json` | `ui_e2e.*`、`timeouts.*` |
| `docs/config.env` | 可选：`UI_E2E_TEST_USER` / `UI_E2E_TEST_PASSWORD` 等（替换 `{test_user}`） |
| MCP | Browser MCP、Dart MCP（由 runner 或执行 Agent 调用） |

**CLI**：`--feature=<feature_id>` 仅跑该 feature 下场景；`--scenario=<scenario_id>` 仅跑单场景（调试）；`--skip-repair-chain` 分诊后只记结论不自动子链。

## 处理逻辑

### 1. `ui-e2e-bootstrap`

1. PID 锁：`<项目根>/.pipeline/locks/ui_e2e.pid`。
2. 校验 [上游门闸](#上游门闸)；`ui_e2e.enabled=false` → `stage_skipped`。
3. 从 `stages.create_ui_scenarios.outputs.scenario_files[]` 与磁盘 YAML 展开 **`scenario_queue[]`**：
   - 每项：`{ scenario_id, feature_id, client_target, platform, yaml_path, base_url, mcp: "browser"|"dart"|"none" }`；
   - `platform=web` → `mcp=browser`；`android|ios` → `mcp=dart`；`desktop` 或未知 → `mcp=none`，`status=skipped`；
   - `scenario_id` 全局唯一；重复 → 退出 **1**。
4. 解析 `base_url`：按 `ui_e2e.web.website.base_url_from` 等从 `deploy.outputs.services[]` 取值；失败则该 web 场景 `blocked` 或 `skipped`（依 `strict_urls`）。
5. MCP 预检：Browser / Dart 各打 `mcp_preflight` 日志；不可用 → web 或 mobile 队列整体标记不可跑。
6. 初始化 `stages.ui_e2e`：`status=running`、`outputs.scenarios[]` 占位、`outputs.scenario_total`。
7. `stage_start`（`meta.scenario_total`、`effective_parallel`）。

### 2. 场景并行执行（`lib/ui-e2e-runner.cjs`）

对每个 `pending` 场景（线程池 `effective_parallel`）：

1. **`ui_scenario_start`**（INFO）：`scenario_id`、`feature_id`、`platform`、`base_url`、`mcp`。
2. 创建日志：
   - 场景专用：`<项目根>/logs/stages/ui_e2e/<datetime>-<scenario_id>.log`（**完整** MCP 往返、步骤、expect 判定）；
   - 关联 feature：`<项目根>/logs/features/<feature_id>/<datetime>.log`（追加摘要行）。
3. **执行步骤**（读 YAML `steps[]`）：
   - **Browser MCP**：`navigate` / `click` / `type` / `hover` / `snapshot` / `wait` / `back` 等映射到 MCP 工具；`selector_hint` 由 Agent/启发式解析为 ref（**禁止**要求 YAML 写 CSS/XPath）。
   - **Dart MCP**：`integration_test` 或 MCP 等价能力执行 mobile 步骤；启动/附着 `ui_e2e.mobile.bundle_id`、`device`。
   - 每步 `snapshot` 或失败自动截图：从 MCP 取图像字节，写入  
     **`<项目根>/.pipeline/logs/snapshots/<scenario_id>/<datetime>.jpg`**  
     （同一场景可多帧：`.../<datetime>_<step_index>.jpg`；**至少**失败时 1 张）。
4. **判定 `expect[]`**：脚本确定性校验 `url_contains` / `text_present` / `element_present`（以 MCP 快照/返回值为准）；失败附 **期望 vs 实际** 人话摘要。
5. 写 `outputs.scenarios[]` 行：

| 字段 | 说明 |
| --- | --- |
| `scenario_id` | 场景 ID |
| `feature_id` | 所属 feature |
| `platform` | web / android / ios |
| `status` | `completed` \| `failed` \| `skipped` \| `timed_out` |
| `passed` | bool |
| `duration_ms` | 挂钟 |
| `log_path` | 场景日志相对路径 |
| `snapshot_paths[]` | 截图相对路径列表 |
| `failure_summary` | 失败时必填 |
| `fix_attempts` | 本场景 MCP 重试次数 |

6. **`ui_scenario_complete`** / **`ui_scenario_failed`**（ERROR 须含 `failure_summary`、`log_path`、最近 `snapshot_paths[]`）。

**即时重试**：MCP 瞬态错误（超时、tab 丢失）且 `fix_attempts < scenario_max_fix_attempts` → 同场景重跑，打 `ui_scenario_retry`（WARN）。

**停止信号**：不再入队新场景；在途场景允许跑完当前步后 `stopped`。

### 3. `ui-e2e-validate`（首轮汇总）

1. 统计 `passed` / `failed` / `skipped` / `timed_out`。
2. 生成 **`.pipeline/reports/ui-e2e-<session>.md`**：
   - 总览表（scenario_id、feature、platform、结果、耗时、截图链接）；
   - **失败章节**：每场景 `failure_summary`、日志尾 80 行、截图路径。
3. 若存在 `failed` 且 `triage_max_attempts` 未用尽 → 进入 [§4](#4-失败分诊与-feature-修复子链)（按 **feature** 聚合失败场景）。
4. 全部 `passed` 或仅剩 `skipped` → `status=completed`、`validation.passed=true`、`stage_complete`。
5. 仍有 `failed` 且分诊/子链用尽 → `status=failed`、退出码 **4**。

### 4. 失败分诊与 feature 修复子链

对每个存在 `failed` 场景的 **`feature_id`**（去重）：

#### 4.1 分诊 Agent

1. 组装 **`.pipeline/ui-e2e-last-error-<feature_id>.json`**：
   - 失败场景列表、`failure_summary`、`log_path`、`snapshot_paths[]`；
   - 相关 `design.json` 摘要、`codegen` commit、worktree 路径；
   - 报告摘录：`.pipeline/reports/ui-e2e-<session>.md` 中该 feature 段落。
2. 派发 Agent：**`ai-std3/prompts/ui-e2e-triage.md`**，产出 **`.pipeline/ui-e2e-triage-<feature_id>.json`**（Ajv：`ui-e2e-triage-output.schema.json`）。

| `decision` | 含义 | 后续动作 |
| --- | --- | --- |
| `fix_prompt` | 根因是 codegen 提示词不清/遗漏约束 | 改 `ai-std3/prompts/codegen-impl.md` 等 → [§4.2](#42-skill-提示词修补与独立推送) → 重跑该 feature 场景（**不改**业务代码） |
| `fix_code` | 根因是实现代码 | Agent/脚本在 **worktree** 修代码 → [§4.3](#43-feature-修复子链) |
| `fix_both` | 先 `fix_prompt` 再 `fix_code` | 顺序执行上两行 |
| `fix_scenario` | 场景 YAML 错误 | 提示 `--from-stage=create-ui-scenarios --feature=<id>`；本 stage 记 `blocked_scenario` |
| `blocked` | 环境/权限/产品决策，AI 无法自动修 | 退出码 **9**，写 `outputs.blocked_features[]` |

#### 4.2 skill 提示词修补与独立推送

**范围**：仅允许修改 **`ai-std3` skill 安装目录** 下 `prompts/**`（如 `codegen-impl.md`、`codegen-impl-resume.md`），**禁止**改业务项目内任何文件。

1. 分诊 Agent 或紧随步骤写入 patch 内容（或 unified diff 说明）。
2. 调用 **`lib/skill-prompt-publish.cjs`**（在 **skill 根目录**执行 git，非业务 `project`）：
   ```bash
   node ai-std3/scripts/lib/skill-prompt-publish.cjs \
     --skill-root=<ai-std3 绝对路径> \
     --message "fix(ui-e2e): <feature_id> triage <reason 摘要>"
   ```
3. 流程：`git add prompts/` → `git commit` → `git push`（遵守用户环境代理规则）；失败 → 打 `prompt_publish_failed`（ERROR），本分诊记 `fix_prompt` 未生效，**不**阻塞其它 feature。
4. 成功后 **仅重跑**该 `feature_id` 下此前失败的场景（`ui-e2e.cjs --feature=<id> --scenario=<ids>`），**不**自动走 §4.3，除非仍失败且 `decision` 含 `fix_code`。

> **与业务仓隔离**：业务项目 `.git` **不**提交 skill 提示词变更；流水线日志 `event=prompt_published` 记录 skill commit hash。

#### 4.3 feature 修复子链

当 `decision` 为 `fix_code` 或 `fix_both` 且代码已写入 **`/.pipeline/worktrees/v3-<feature_id>/`** 后：

```text
ui_e2e_repair_chain(feature_id):
  1. code-review.cjs       --feature=<id>
  2. merge-push.cjs        # 合并该 feature 分支入主干（若已合并则增量 merge）
  3. build.cjs             # 仅构建该 feature 涉及的 client_targets
  4. deploy.cjs            # 仅部署受影响 deploy.services[]
  5. ui-e2e.cjs            --feature=<id>  # 重跑失败场景；全部通过则该 feature 记 repaired
```

- 由 **`lib/ui-e2e-repair-chain.cjs`** 顺序 `spawn` 上述脚本；任一步非 0 → 记录 `repair_chain_failed_at`、中止子链、该 feature 保持 `failed`。
- 子链执行期间 `stages.ui_e2e.status=running`（或 `repairing` 写入 `outputs.repair_state`）；**不**释放 ui_e2e PID 锁直至子链结束或中止。
- 子链成功后更新 `features.<id>.repair_status=passed`；汇总到 `outputs.repaired_features[]`。
- **build/deploy 范围**：由失败场景的 `platform` / `client_target` 推导（web → website/admin；mobile → mobile 产物）。

**codegen 提示词优化后**若仅 `fix_prompt`：跳过子链，直接重跑 ui_e2e 场景；若新代码仍需上线验证，用户或分诊可显式选择 `fix_both`。

#### 4.4 分诊耗尽

- `triage_max_attempts` 用尽仍有失败 → `validation.passed=false`、退出码 **4**。
- `decision=blocked` → 立即退出码 **9**（整段流水线停止，与 [deploy](deploy.md) 一致）。

## 日志与截图路径

| 路径 | 说明 |
| --- | --- |
| `<项目根>/logs/stages/ui_e2e/<datetime>.log` | stage 总日志 |
| `<项目根>/logs/stages/ui_e2e/<datetime>-<scenario_id>.log` | 单场景 **完整** 执行日志（MCP 请求/响应摘要） |
| `<项目根>/logs/features/<feature_id>/<datetime>.log` | feature 级追加摘要 |
| **`<项目根>/.pipeline/logs/snapshots/<scenario_id>/<datetime>.jpg`** | MCP 截图（**标准落盘路径**；report 用相对路径引用） |

**人类可读要求**（ERROR）：

```text
[ui_e2e] scenario=NOTE-CRUD-001-smoke-001 platform=web 失败：expect text_present「笔记」未找到；
  log=logs/stages/ui_e2e/2026-05-18_14-30-00-NOTE-CRUD-001-smoke-001.log
  snapshot=.pipeline/logs/snapshots/NOTE-CRUD-001-smoke-001/2026-05-18_14-30-15.jpg
```

## 日志事件

| event | LEVEL | 触发时机 | meta 必填字段 |
| --- | --- | --- | --- |
| `mcp_preflight` | INFO | Browser/Dart 预检 | `mcp`, `ok`, `reason` |
| `ui_scenario_start` | INFO | 场景开跑 | `scenario_id`, `feature_id`, `platform`, `mcp`, `base_url` |
| `ui_scenario_step` | DEBUG | 单步完成 | `scenario_id`, `step_index`, `action`, `duration_ms` |
| `ui_scenario_snapshot` | INFO | 截图已写 | `scenario_id`, `path`, `step_index` |
| `ui_scenario_retry` | WARN | 场景即时重试 | `scenario_id`, `attempt`, `reason` |
| `ui_scenario_complete` | INFO | 场景通过 | `scenario_id`, `duration_ms`, `snapshot_paths[]` |
| `ui_scenario_failed` | ERROR | 场景失败 | `scenario_id`, `feature_id`, `failure_summary`, `log_path`, `snapshot_paths[]` |
| `ui_e2e_triage_start` | INFO | 分诊 Agent 启动 | `feature_id`, `failed_scenario_ids[]` |
| `ui_e2e_triage_complete` | INFO | 分诊 JSON 落盘 | `feature_id`, `decision`, `reason` |
| `prompt_published` | INFO | skill 提示词已 push | `skill_commit`, `files[]`, `feature_id` |
| `repair_chain_start` | INFO | 子链开始 | `feature_id`, `stages[]` |
| `repair_chain_step` | INFO | 子链单步结束 | `feature_id`, `stage`, `exit_code`, `duration_ms` |
| `repair_chain_failed` | ERROR | 子链中断 | `feature_id`, `failed_stage`, `exit_code`, `reason` |
| `repair_chain_complete` | INFO | 子链成功 | `feature_id`, `duration_ms` |
| `ui_e2e_blocked` | ERROR | `decision=blocked` | `feature_id`, `reason`, `exit_code: 9` |

## 输出

| 路径 | 说明 |
| --- | --- |
| `.pipeline/reports/ui-e2e-<session>.md` | 全量场景报告 |
| `.pipeline/ui-e2e-triage-<feature_id>.json` | 分诊结论 |
| `.pipeline/ui-e2e-last-error-<feature_id>.json` | 分诊输入快照 |
| `.pipeline/logs/snapshots/<scenario_id>/*.jpg` | MCP 截图 |
| `.pipeline/stages.json` | `stages.ui_e2e` |

**`stages.ui_e2e.outputs` 主要字段**：`scenarios[]`、`scenario_total`、`passed_count`、`failed_count`、`skipped_count`、`report_path`、`repaired_features[]`、`blocked_features[]`、`repair_state`、`triage_attempts`。

**`stages.ui_e2e.features.<feature_id>`**（可选聚合）：`scenarios_passed`、`scenarios_failed`、`last_triage_decision`、`repair_status`。

## 解锁

| 条件 | 效果 |
| --- | --- |
| `status=completed` 且 `validation.passed=true` | 可运行 `report` |
| `status=skipped` | 可运行 `report`（`ui_e2e.enabled=false`） |
| `status=failed`、退出码 **4** | 阻断 `report` 成功结论；可按 feature 重跑 `--from-stage=ui_e2e --feature=<id>` |
| `status=failed`、退出码 **9** | **流水线停止**；处理 `blocked_features[]` 后续跑 |

## 配置示例

```json
{
  "ui_e2e": {
    "enabled": true,
    "require_deploy_smoke_passed": true,
    "strict_mobile": false,
    "web": {
      "website": { "base_url_from": "deploy.services.website.url" },
      "admin": { "base_url_from": "deploy.services.admin.url" }
    },
    "mobile": {
      "bundle_id": "com.example.app",
      "device": "emulator",
      "auto_launch_emulator": true
    },
    "commands": {
      "scenario_max_fix_attempts": 2
    }
  },
  "pipeline": {
    "stages": {
      "ui_e2e": {
        "scenario_max_parallel": 3,
        "triage_max_attempts": 2,
        "prompt_fix_max_attempts": 1,
        "fail_fast": false
      }
    }
  },
  "timeouts": {
    "stages": {
      "ui_e2e_s": 1800,
      "ui_e2e_scenario_s": 600
    }
  }
}
```

---
