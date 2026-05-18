# setup 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 初始化 `inputs/`、校验需求与云平台凭证、同步 `docs/config.*`、注册本机 runtime，并创建/更新 `.pipeline/stages.json`。

## 脚本

编排入口与其它 stage 相同，位于 **`ai-std3/scripts/lib/setup.cjs`**；下列子脚本位于 **`ai-std3/scripts/`** 根目录（见 [std3 §3](../std3.md#3-run-pipelinecjs-编排映射)）。

| 脚本 | 职责 |
| --- | --- |
| `lib/setup.cjs` | **编排入口**（`run-pipeline` 调用）；顺序执行下列子脚本并维护 `stages.json` |
| `setup-inputs.cjs` | 从规范模板拷贝 `inputs/req.md`、`inputs/config.env`（已存在则跳过） |
| `verify-inputs.cjs` | 校验 `inputs/req.md` 带 `*` 的 H2 节与 `inputs/config.env` 云平台密钥 |
| `sync-config-env.cjs` | 将 `inputs/config.env` 同步到 `docs/config.env`，并生成/更新 `docs/config.dev.json`、`docs/config.release.json` |
| `register-project.cjs` | 写入 `<skills_root>/_projects/<project.name>/runtime.json`（`project.name` 来自 `config.dev.json`） |

调用形态（与其它 stage 一致）：

```bash
node ai-std3/scripts/lib/setup.cjs --project=<业务项目根绝对路径>
```

子脚本亦可单独调试：`node ai-std3/scripts/verify-inputs.cjs --project=...`。

**`<skills_root>`**：skill 安装根目录，与 [`input-spec.md`](../../input-spec.md) §3 一致（默认 `~/.cursor/skills`）；可由环境变量 `CURSOR_SKILLS_ROOT` 覆盖。`register-project.cjs` 读写 **`<skills_root>/_projects/<project.name>/runtime.json`**（见 [`runtime-pipeline.md`](../../spec/runtime-pipeline.md)）。

## 上游门闸

无（流水线首 stage）。

## 输入

| 来源 | 要求 |
| --- | --- |
| [`templates/req-template.md`](../templates/req-template.md) | 模板；`inputs/req.md` 不存在时拷贝 |
| [`templates/config.env.template`](../templates/config.env.template) | 模板；`inputs/config.env` 不存在时拷贝 |
| [`templates/config.json.template`](../templates/config.json.template) | 模板；`docs/config.dev.json` / `config.release.json` 不存在时由 `sync-config-env.cjs` 拷贝后再填入 |
| [`templates/stages.json.template`](../templates/stages.json.template) | 模板；`.pipeline/stages.json` 不存在时由 `setup.cjs` 拷贝后再填入 |

## 处理逻辑

`setup.cjs` **固定顺序**（与 [std3 §3 编排映射](../std3.md#3-run-pipelinecjs-编排映射) 一致）：

0. **hash 门控**（见「重跑与 hash 门控」）：若可跳过则直接 `stage_skipped` 并退出 **0**。
1. **`setup-inputs.cjs`**：拷贝模板到 `<业务项目根>/inputs/`；已存在则跳过（`file_skipped`）。
2. **初始化 `stages.json`**（仅当 `.pipeline/stages.json` 不存在）：从 `docs/spec/std3/templates/stages.json.template` 拷贝；探测 Git 填写 `pipeline.project`；写入 `stages.setup` 为 `status: "started"`，并记录 `inputs.source_prd_spec`、`inputs.summary_hash`（`req.md` 的 SHA-256）。
3. **`verify-inputs.cjs`**：检查 `inputs/req.md` 所有带 `*` 的 H2 节非空；检查 `inputs/config.env` 的 `CLOUD_PROVIDER` 与对应提供商密钥变量非空（规则见模板注释）。**未通过 → 退出码 2**，`validation_fail`，列出 `missing[]`。
4. **`sync-config-env.cjs`**：将 `inputs/config.env` **覆盖**写入 `docs/config.env`；按 `CLOUD_PROVIDER` 与 req 中的部署意图合并/创建 `docs/config.dev.json`、`docs/config.release.json`（不存在则从 `config.json.template` 拷贝）。**配置/模板错误 → 退出码 1**。
5. **`register-project.cjs`**：注册或更新 `<skills_root>/_projects/<project.name>/runtime.json`（`project.name` 必须已在 `config.dev.json` 中）。**路径/权限错误 → 退出码 1**。
6. **写 setup 完成态**：更新 `pipeline.current_stage`、`pipeline.last_completed_stage`、`pipeline.updated_at`；`stages.setup.status=completed`，`validation.passed=true`，`outputs` 写入 config 路径与 `client_targets: []`（端列表由 **prd** 阶段填充）。

### 重跑与 hash 门控

- 若 `stages.setup.status=completed` 且 `inputs.summary_hash` 与当前 `inputs/req.md` SHA-256 一致 → 整段 setup **skipped**（退出码 **0**，`stage_skipped`）。
- 若用户修改了 `req.md` 或 `config.env` 导致 hash 变化 → 重跑 sync + register，并刷新 `summary_hash`。
- 用户补全 inputs 后：`node ai-std3/scripts/run-pipeline.cjs --project=... --from-stage=setup`（见 [卡点速查](../std3.md#4-agent-卡点速查)）。

### `stages.setup` 完成态字段（节选）

```json
{
  "pipeline": {
    "current_stage": "setup",
    "last_completed_stage": "setup",
    "updated_at": "<本地时间字符串>",
    "updated_by": "ai-std3",
    "project": {
      "project_id": "<稳定 ID>",
      "root_path": "<业务项目根绝对路径>",
      "name": "<与 config.dev.json project.name 一致>",
      "git": {
        "remote": "origin",
        "remote_url": "<url 或 null>",
        "default_branch": "main",
        "repo_initialized_at": null,
        "remote_configured_at": null
      }
    }
  },
  "stages": {
    "setup": {
      "status": "completed",
      "started_at": "<本地时间>",
      "completed_at": "<本地时间>",
      "inputs": {
        "source_prd_spec": "<业务项目根>/inputs/req.md",
        "summary_hash": "<req.md SHA-256>",
        "raw_input_refs": []
      },
      "outputs": {
        "config_dev": "<业务项目根>/docs/config.dev.json",
        "config_release": "<业务项目根>/docs/config.release.json",
        "config_env": "<业务项目根>/docs/config.env",
        "client_targets": [],
        "duration_ms": 0,
        "timed_out": false,
        "timeout_reason": null
      },
      "validation": {
        "passed": true,
        "checked_at": "<本地时间>",
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
```

字段须满足 [`stages.json.schema.json`](../schemas/stages.json.schema.json) 中 `setupStage` 定义。

## 退出码（本 stage）

| 码 | 场景 |
| ---: | --- |
| 0 | 成功；或 hash 命中 `skipped` |
| 1 | `sync-config-env` / `register-project` 配置或 IO 失败；`stages.json` schema 写入失败 |
| 2 | `verify-inputs` 未通过（`req.md` / `config.env` 待用户补全） |
| 5 | 检测到 `stop.signal`（setup 无破坏性操作，立即中止） |

与 [std3 全局退出码表](../std3.md#退出码) 一致。

## 日志事件（setup）

| 步骤 | event | LEVEL | 关键 meta 字段 |
| --- | --- | --- | --- |
| stage 启动 | `stage_start` | INFO | `run_id`, `stage`, `project`, `started_at`（本地时间） |
| 拷贝 inputs 模板 | `file_created` / `file_skipped` | INFO | `path`, `from_template` |
| 校验 inputs | `validation_pass` / `validation_fail` | INFO/ERROR | `checks` 或 `missing[]` |
| 同步 config | `file_created` / `file_updated` | INFO | `path`（config.dev.json / config.release.json / config.env） |
| 注册 runtime | `file_created` / `file_updated` | INFO | `path`, `project_id` |
| 初始化 stages.json | `file_created` / `file_skipped` | INFO | `path`, `from_template` |
| 写完成态 | `file_updated` | INFO | `path`, `status: "completed"` |
| stage 完成 | `stage_complete` | INFO | `stage`, `duration_ms`, `exit_code: 0` |
| 任意步骤失败 | `stage_failed` | ERROR | `stage`, `step`（如 `verify-inputs`）, `exit_code`, `reason`, `duration_ms` |

## 输出

- `stages.setup.status=completed` 且 `stages.setup.validation.passed=true`
- `<业务项目根>/docs/config.dev.json`、`config.release.json`、`config.env` 已就绪
- `<skills_root>/_projects/<project.name>/runtime.json` 已注册

## 解锁

`stages.setup.status=completed` 且 `stages.setup.validation.passed=true` → 可运行 **prd**（prd 上游门闸见 [prd.md](prd.md#上游门闸)）。

---
