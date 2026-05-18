# deploy 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 在 **build** 产出就绪后，按 **`docs/config.{dev|release}.json`** 与 **`docs/config.env`** 将各端部署到配置的云平台。
>
> **本期实现范围**：仅 **Cloudflare** 自动化（`deploy.provider=cloudflare`）；`manual` 登记 URL；其它 provider 注册表预留，调用时退出码 **1** 并提示未实现。
>
> **参考 v3（ai-publish-dev3）**：`libs/providers/cloudflare.cjs`（Pages / Workers、域名与 DNS）、`artifacts.cjs` 产物映射、`allow_destructive_deploy` 门闸；本 stage 在 skill 内 **自包含实现**（不 spawn `ai-publish-dev3`），并增加 **失败 Agent 分诊 + 脚本自修复重试**。
>
> **不在 deploy 内隐式 build**；缺产物 → 退出码 **1**。
>
> **内联 smoke（无独立 smoke stage）**：每个 service 部署成功后对该 URL 执行匹配的 `smoke.checks[]`（见 [§2.1](#21-单-service-部署后内联-smoke)）；汇总为 `outputs.inline_smoke_passed`，供 `ui_e2e` 门闸使用。

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `stages/deploy.cjs` | 编排：门闸 → bootstrap → 按 service 部署 → 失败分诊 → validate |
| `libs/deploy-preflight.cjs` | 读 config / config.env、destructive 确认、凭证预检、可部署端判定 |
| `libs/providers/cloudflare.cjs` | Cloudflare API：Pages 上传、Workers 部署、自定义域名 / DNS |
| `libs/providers/manual.cjs` | `provider=manual`：仅校验 `deploy.services[].url` 并写回 stages |
| `libs/providers/registry.cjs` | provider 分派；未实现 provider → 抛错 |
| `libs/deploy-triage.cjs` | 组装错误包、调用 Agent、解析 `deploy-triage.json`、驱动重试或退出码 |
| `libs/http-smoke.cjs` | 内联 HTTP 冒烟（codegen / deploy 共用；无独立 smoke stage） |

> 实现目录前缀：`ai-std3/scripts/`（`stages/` 为主脚本，`libs/` 为子脚本）。

```bash
node ai-std3/scripts/stages/deploy.cjs --project=<业务项目根绝对路径> [--explicit-confirm]
```

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.build.status=completed` 且 `validation.passed=true` |
| **产物** | `deploy.enabled=true` 时，`deploy.services[]` 每条须能在 `stages.build.outputs.artifacts[]` 中 **唯一** 映射到 `status=completed` 且 `artifact_path` 非空（与 [build](build.md) / publish3 一致） |
| **停止信号** | 启动时存在 `stop.signal` → 退出码 **5** |

## 跳过条件（整段 `skipped`）

满足**任一**即写 `stages.deploy.status=skipped`、`validation.passed=true`、退出码 **0**（**不**调用云 API）：

| 条件 | `outputs.skip_reason` 示例 |
| --- | --- |
| `deploy.enabled=false` | `deploy.disabled` |
| **项目无可部署 Web/Admin/Backend 端** | `no_deployable_targets` |
| `deploy.provider=manual` 且全部 `services[].url` 已预填、仅登记 | `manual_prefilled`（可选，实现可仍跑 manual 校验） |

**「无可部署端」判定**（须**同时**不满足下列任一条才跳过）：

1. `stages.prd.outputs.client_targets[]` 含 `website` / `admin` / `backend` 之一；
2. 项目根存在 `src/website/`、`src/admin/` 或 `src/backend/`（目录存在即可）；
3. `deploy.services[]` 中某条 `client_target ∈ {website, admin, backend}`。

> 仅有 `mobile` / `desktop` 等、且无上述三者 → **跳过 deploy**；`ui_e2e` 若需 URL 须在 `smoke.checks[]` 或 `ui_e2e` 配置中写完整 URL。

## 配置与凭证

| 文件 | 用途 |
| --- | --- |
| `docs/config.dev.json` | 默认 dev 流水线；`deploy.*`、`pipeline.autorun.allow_destructive_deploy` |
| `docs/config.release.json` | release 部署（`deploy.cjs --config=release`） |
| `docs/config.env` | **不进 git**；`CLOUD_PROVIDER`、`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID` 等 |

**Destructive 保护**（与 publish3 / setup 一致）：

| 路径 | 要求 |
| --- | --- |
| **autorun**（`run-pipeline.cjs`） | `pipeline.autorun.allow_destructive_deploy=true`，否则退出码 **1** |
| **手工** | CLI `--explicit-confirm`，否则退出码 **1** |

**Cloudflare 凭证预检**（`provider=cloudflare`，启动 deploy 前）：

| 变量 | 缺失时 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 退出码 **1**（`reason: missing_secret`，**不**派发 Agent） |
| `CLOUDFLARE_ACCOUNT_ID` | 退出码 **1** |
| `CLOUD_PROVIDER` | 应为 `cloudflare`；不符 → **WARN**，以 config.json `deploy.provider` 为准 |

凭证值**禁止**写入 `stages.json` 或日志正文；日志仅允许 `token_prefix`（前 4 字符 + `***`）。

## `deploy.services[]` 与产物映射

与 v3 / [build](build.md) 对齐，每条 service：

| 字段 | 说明 |
| --- | --- |
| `name` | 逻辑名（如 `website`） |
| `client_target` | `website` / `admin` / `backend` / … |
| `sub_platform` | 空或未声明视为 `default` |
| `type` | Cloudflare：`pages` \| `workers` |
| `domain` | 自定义域名或路径前缀（传给 provider） |
| `url` | 部署成功后写回；manual 可预填 |
| `artifact_ref` | 可选；`"<client_target>:<sub_platform>"` 或产物路径 |

映射失败（0 条或多条 artifact）→ 退出码 **1**，日志 `validation_fail` 含 `formatArtifactMappingFailure` 风格人话原因。

## 处理逻辑

### 1. `deploy-bootstrap`（门闸 + 哈希）

1. **PID 锁**：路径 `.pipeline/locks/deploy.pid`；检查现有锁 PID 是否存活——不存活则视为过期锁，清除并继续；若存活则退出码 1（防并发部署）。
2. **配置加载**：加载 `--config=dev|release`（默认 `dev`）与 `docs/config.env`（仅注入子进程 `env`，不写日志原文）。
3. **配置跳过条件检查**（见[跳过条件](#跳过条件整段-skipped)）：命中则写 `stages.deploy.status=skipped`、`outputs.skip_reason`，打 `stage_skipped` 事件，退出码 0。（此 `status=skipped` 与 hash 命中跳过区分：配置跳过是主动不部署，hash 命中跳过是已完成无需重做）
4. **门闸**：destructive / build / artifact 映射门闸；任一不满足 → 退出码 1。
5. **先读旧值**：读取 `stages.deploy.inputs.summary_hash`（骨架不存在则为 `null`）。
6. **计算新值**：`summary_hash_new` = SHA-256(规范化 JSON 包含 `build.inputs.summary_hash`、deploy 相关 config 子树（`provider`、`services[]` 结构、`fail_fast`）、消费的 `artifacts[]` `(client_target, sub_platform, artifact_path)` 列表）。
7. **hash 门控（全段跳过）**：若 `summary_hash_new == 旧值` **且** `stages.deploy.status=completed` 且 `validation.passed=true`（且未带 `--force-rerun=deploy`）→ 写 `stage_skipped` 日志事件，保持 `status=completed` **不变**，退出码 0。
8. **骨架处理 + 写入新值**（非跳过路径）：
   - 写入 `inputs.summary_hash = summary_hash_new`。
   - 若骨架不存在：初始化 `stages.deploy`，`status=running`、`environment`、`outputs.services[]` 占位（每条 service 含 `name`/`status=pending`/`smoke_passed=null`）、`outputs.attempts=0`。
   - 若骨架已存在：写入新 hash；保留上次 `status=completed` 的 service 条目（续跑幂等，已部署成功的 service **不重新部署**）；`status=pending`/`failed`/`timed_out` 的 service 重置为 `pending`。
9. 写 `stages.deploy.status=running`；写入 PID 锁。

### 2. 按 service 顺序部署（Cloudflare）

对每个 `deploy.services[]` 条目（建议顺序：**backend → admin → website**，避免 Workers 路由依赖未就绪）：

0. 若 `outputs.services[<name>].status=completed`（bootstrap 续跑保留）→ 打 `deploy_service_skipped`（INFO，`reason: "already_deployed"`）并跳过，不重新调用 API。
1. 打 `deploy_service_start`（INFO）：`service_name`、`client_target`、`type`、`artifact_path`、`domain`。
2. 解析 artifact；记录 `inputs.artifacts[]` 消费行。
3. 调用 `libs/providers/cloudflare.cjs`：
   - **`pages`**：确保 Pages 项目存在 → 上传 `artifact_path` 目录 → 绑定 `domain`（Domains API，失败则 DNS CNAME + 橙云说明写日志）。
   - **`workers`**：部署脚本/捆绑产物 → 绑定路由或 custom domain。
4. 子步骤须写 **结构化 + 人话** 日志（见 [日志要求](#日志要求)）。
5. 成功 → `deploy_service_complete`，`outputs.services[]` 追加 `{ name, client_target, sub_platform, type, url, version, deployed_at }`。
6. **[§2.1 内联 smoke](#21-单-service-部署后内联-smoke)**（`smoke.deploy.enabled=true` 时）：对该 service 的 `url` 解析并执行匹配的检查项；结果写入 `services[].smoke_checks[]`、`services[].smoke_passed`。
7. 失败 → 捕获 **完整错误包**（见下），进入 §3，**不**继续后续 service（`fail_fast` 默认 true）。

#### 2.1 单 service 部署后内联 smoke

1. 从 `smoke.checks[]` 筛选 `client_targets` 含本 service 的 `client_target`，或 `url` / `path` 含占位符 `{deploy.services.<name>.url}` / `{deploy.services.<client_target>.url}`。
2. 将占位符替换为刚写入的 `services[].url`（**禁止**在 deploy 完成前对含 `{deploy.*}` 的项发起请求）。
3. `lib/http-smoke.cjs` 执行；超时 `smoke.deploy.timeout_s`（默认 `min(120, deploy_s/3)`）。
4. 失败 → 记 `outputs.inline_smoke_failures[]`；`fail_fast=true` 时中止后续 service 并进入 §3 分诊（与部署失败相同路径）；`fail_fast=false` 时继续部署但 stage 终态 `validation.passed=false`、退出码 **4**。
5. 事件：`smoke_inline_complete` / `smoke_inline_failed`（`meta.service_name` 必填）。

**`smoke.checks[]` 字段**（`config.json`，与 v3 publish3 对齐，**非** stage）：

| 字段 | 说明 |
| --- | --- |
| `url` | 绝对 URL，或含 `{deploy.services.*.url}` 占位符（仅 deploy 内联可解析） |
| `path` | 与 `url` 二选一；相对 `base_url` 的路径 |
| `method` | `GET` / `HEAD` / `POST`（非 GET/HEAD 须 `safe: true`） |
| `expected_status` | 默认 `200` |
| `body_contains` | 可选 |
| `client_targets` | 可选；用于 codegen/deploy 筛选 |
| `scope` | 可选：`codegen` \| `deploy` \| `both`（默认 `both`） |

**错误包**（写入 `<项目根>/.pipeline/deploy-last-error.json` 并作为 Agent 输入）：

```json
{
  "failed_at": "2026-05-18 14:30:00 +0800",
  "service": { "name": "website", "client_target": "website", "type": "pages" },
  "provider": "cloudflare",
  "http_status": 403,
  "api_errors": ["Authentication error"],
  "stderr_tail": "...",
  "deploy_log_path": "logs/stages/deploy/2026-05-18_14-30-00-website.log",
  "config_redacted": { "account_id": "abcd***", "domain": "app.example.com" }
}
```

**超时**：单 service 挂钟 ≤ `timeouts.stages.deploy_s`（默认 600s）；超时 → `timed_out=true`，进入分诊，最终可映射退出码 **3** 或 **8**（见退出码表）。

### 3. 失败分诊（Agent + 重试）

任一步骤失败且未跳过时：

1. 打 `deploy_failed`（ERROR），附 `deploy_log_path`、`http_status`。
2. **`deploy-triage.cjs`** 派发 Agent（`AI_STD3_AGENT_BIN`），提示词 **`ai-std3/prompts/deploy-triage.md`**，只读输入：
   - `.pipeline/deploy-last-error.json`
   - `logs/stages/deploy/<datetime>*.log`（失败 service 相关）
   - `docs/config.{dev|release}.json` 的 `deploy` 子树（无密钥）
   - **仅可读** `ai-std3/scripts/libs/providers/cloudflare.cjs` 与 `stages/deploy.cjs`（用于判断脚本缺陷）
3. Agent **必须**产出 **`.pipeline/deploy-triage.json`**（Ajv：`deploy-triage-output.schema.json`）：

| 字段 | 说明 |
| --- | --- |
| `decision` | `fix_script` \| `retry_deploy` \| `blocked` |
| `category` | `script_bug` \| `config` \| `credentials` \| `permissions` \| `quota` \| `transient` \| `unknown` |
| `reason` | 人话摘要（中文） |
| `evidence[]` | 引用日志行或 API 错误 |
| `patch_hints[]` | `fix_script` 时：建议修改的 **skill 脚本** 相对路径与要点（不得改业务仓） |
| `user_actions[]` | `blocked` 时：用户须在 Cloudflare 控制台 / IAM 完成的操作 |

**脚本对 `decision` 的处理**：

| decision | 行为 | 退出码（若仍失败） |
| --- | --- | --- |
| `fix_script` | Agent 或紧随其后的 **同一次** Agent 会话修改 `ai-std3/scripts/**` 中 deploy 相关脚本；`outputs.agent_fix_attempts += 1`；若 `≤ pipeline.stages.deploy.agent_fix_max_attempts`（默认 **2**）→ **整段 deploy 重试**（从失败 service 起） | 用尽 → **4**（可再人工改脚本后 `--from-stage=deploy`） |
| `retry_deploy` | 不改脚本，仅重试部署（如瞬时 5xx）；`outputs.deploy_retries += 1`；`≤ deploy_retry_max`（默认 **1**） | 仍失败 → 再次分诊或 **8** |
| `blocked` | 写 `outputs.blocked_reason`、`outputs.user_actions[]`；**立即终止流水线** | **9** |

**确定性 `blocked`（不派发 Agent）**：预检已失败（缺 token → **1**）；若 API 返回明确且不可自动修复的码表命中，可直接 **9**：

- Cloudflare `10000` 系列鉴权 + 账号被禁用；
- `403` 且 message 含 `access denied` / `insufficient permissions` 且 token 前缀校验通过（非 typo）；
- 配额 / 账单类 `429` / 特定 error code（维护于 `lib/deploy-blocked-codes.json`）。

**退出码 4 vs 8 vs 9**（deploy 专用，见 [std3 退出码](../std3.md#退出码)）：

- **4**：Agent 判定可修复（脚本/配置/可重试逻辑），但自动修复次数用尽或需再跑 stage；
- **8**：云 API / 托管侧错误，**尚未**判定为须人工阻断，或 `retry_deploy` 用尽；
- **9**：**须人工介入**，流水线 **必须停**（权限、账号策略、审批、配额等 Agent 显式 `blocked`）。

### 4. `deploy-validate`（汇总 + 报告）

1. 全部 service 部署完成；汇总内联 smoke：`outputs.inline_smoke_passed = (inline_smoke_failures.length === 0)`。
2. `inline_smoke_passed=true` 且无部署失败 → `status=completed`、`validation.passed=true`；否则 `failed`、退出码 **4**（smoke）或 **8/9**（部署路径）。
3. 生成 **`.pipeline/reports/deploy-summary.md`**：每 service 的 url、smoke 结果、provider、耗时；失败时链到日志与分诊结论。
4. 写 `outputs.report_path`；释放锁；`stage_complete`。

## 日志要求

**分 service 日志**：`<项目根>/logs/stages/deploy/<datetime>-<service.name>.log`（API 请求摘要、上传进度、域名绑定结果）。

**stage 总日志**：`logs/stages/deploy/<datetime>.log`。

每条 Cloudflare API 调用在总日志中至少一条 `deploy_api_call`（DEBUG 或 INFO）：

| 字段 | 示例 |
| --- | --- |
| `method` | `POST` |
| `path` | `/accounts/{id}/pages/projects` |
| `status` | `200` |
| `duration_ms` | `842` |
| `success` | `true` |
| `error_summary` | 失败时必填，来自 API `errors[].message` |

**人类可读**（ERROR 必填）：`[deploy] service=website step=pages_upload 失败：HTTP 403 — Authentication error；详见 logs/stages/deploy/...`。

禁止只打 `failed` 无 service/step 上下文。

## 日志事件

| event | LEVEL | 触发时机 | meta 必填字段 |
| --- | --- | --- | --- |
| `stage_start` | INFO | stage 启动 | `run_id`, `stage`, `project`, `started_at` |
| `stage_skipped` | INFO | hash 命中或配置跳过 | `reason`, `exit_code: 0` |
| `deploy_service_skipped` | INFO | 续跑时已完成的 service 跳过 | `service_name`, `reason: "already_deployed"` |
| `deploy_service_start` | INFO | 开始部署单 service | `service_name`, `client_target`, `type`, `artifact_path` |
| `deploy_api_call` | INFO/DEBUG | Cloudflare API 往返 | `method`, `path`, `status`, `duration_ms`, `success` |
| `deploy_service_complete` | INFO | 单 service 成功 | `service_name`, `url`, `duration_ms` |
| `deploy_failed` | ERROR | 单 service 失败 | `service_name`, `http_status`, `error_summary`, `deploy_log_path` |
| `deploy_triage_start` | INFO | 启动分诊 Agent | `agent_id`, `prompt`, `attempt` |
| `deploy_triage_complete` | INFO | 分诊 JSON 落盘 | `decision`, `category`, `reason` |
| `deploy_script_patched` | INFO | `fix_script` 后改了 skill 脚本 | `files[]`, `attempt` |
| `deploy_retry` | WARN | 重试部署 | `reason`, `deploy_retries`, `agent_fix_attempts` |
| `deploy_blocked` | ERROR | `decision=blocked` | `reason`, `user_actions[]`, `exit_code: 9` |
| `smoke_inline_complete` | INFO | 单 service 内联 smoke 通过 | `service_name`, `url`, `checks_passed` |
| `smoke_inline_failed` | ERROR | 单 service 内联 smoke 失败 | `service_name`, `url`, `failures[]` |
| `stage_complete` | INFO | stage 完成 | `stage`, `duration_ms`, `exit_code: 0`, `services_deployed` |
| `stage_failed` | ERROR | 任意步骤失败 | `stage`, `step`, `exit_code`, `reason` |

## 退出码（本 stage）

| 码 | 场景 | stages.deploy.status |
| ---: | --- | --- |
| 0 | 全部 service 部署 + smoke 通过 | `completed` |
| 0 | hash 命中整段跳过 | `completed`（不变） |
| 0 | `deploy.enabled=false` 等配置跳过 | `skipped` |
| 1 | 门闸未满足 / 凭证缺失 / 配置无法解析 / PID 锁占用 | `failed` |
| 3 | 单 service 挂钟超时（`deploy_s`） | `failed` |
| 4 | 自动修复次数用尽，仍部署失败；或内联 smoke 失败 | `failed` |
| 5 | `stop.signal` | `stopped` |
| 8 | 云 API 错误，`retry_deploy` 用尽，但未判定须人工阻断 | `failed` |
| 9 | Agent 判定 `blocked`（权限/账单/人工审批等须人工介入） | `failed` |

## 输出

| 路径 | 说明 |
| --- | --- |
| 线上 URL | `stages.deploy.outputs.services[].url` |
| `.pipeline/reports/deploy-summary.md` | 部署报告 |
| `.pipeline/deploy-last-error.json` | 最近一次失败快照（供分诊） |
| `.pipeline/deploy-triage.json` | Agent 分诊结论 |
| `.pipeline/stages.json` | `stages.deploy` |

**`stages.deploy.outputs` 主要字段**：`services[]`（含 `smoke_passed` / `smoke_checks[]`）、`inline_smoke_passed`、`inline_smoke_failures[]`、`report_path`、`provider`、`environment`、`deploy_retries`、`agent_fix_attempts`、`blocked_reason`、`user_actions[]`、`duration_ms`、`timed_out`。

## 解锁

| 条件 | 效果 |
| --- | --- |
| `status=completed` 且 `validation.passed=true`（含 `inline_smoke_passed=true` 当 `smoke.deploy.enabled=true`） | 可运行 `ui_e2e` |
| `status=skipped` | 可运行 `ui_e2e`（若 `ui_e2e.require_deploy_smoke_passed=false` 或未配置 deploy 相关 checks） |
| `status=failed` + 退出码 **9** | **流水线停止**；人工处理后 `--from-stage=deploy` |
| `status=failed` + 退出码 **4/8** | 按 [卡点速查](../std3.md#4-agent-卡点速查) 修复后重跑 |

## 配置示例

```json
{
  "deploy": {
    "enabled": true,
    "provider": "cloudflare",
    "domain": "example.com",
    "services": [
      {
        "name": "backend",
        "client_target": "backend",
        "type": "workers",
        "domain": "api.example.com"
      },
      {
        "name": "website",
        "client_target": "website",
        "type": "pages",
        "domain": "app.example.com"
      }
    ]
  },
  "pipeline": {
    "autorun": { "allow_destructive_deploy": true },
    "stages": {
      "deploy": {
        "agent_fix_max_attempts": 2,
        "deploy_retry_max": 1,
        "fail_fast": true
      }
    }
  },
  "smoke": {
    "checks": [
      {
        "url": "{deploy.services.backend.url}/health",
        "method": "GET",
        "expected_status": 200,
        "client_targets": ["backend"],
        "scope": "deploy"
      }
    ],
    "codegen": { "enabled": true, "timeout_s": 60 },
    "deploy": { "enabled": true, "timeout_s": 120 }
  },
  "timeouts": {
    "stages": { "deploy_s": 600 }
  }
}
```

---
