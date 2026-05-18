# setup 阶段

[← 规范索引](../std3.md) · [门闸链](../std3.md#2-门闸链汇总) · [编排映射](../std3.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std3.md#4-agent-卡点速查)

> 初始化 inputs、校验需求、注册项目、创建 stages.json。

## 脚本

`setup.cjs`、`setup-inputs.cjs`、`verify-inputs.cjs`、`sync-config.cjs`、`register-project.cjs`（已存在，保持现有实现）

## 输入

| 来源 | 要求 |
| --- | --- |
| `docs/spec/std3/templates/req-template.md` | 模板；若 `inputs/req.md` 不存在则拷贝 |
| `docs/spec/std3/templates/config.env.template` | 模板；若 `inputs/config.env` 不存在则拷贝 |

## 处理逻辑

1. `setup-inputs.cjs`：拷贝模板到 `<业务项目根绝对路径>/inputs/`；已存在则跳过。
2. `verify-inputs.cjs`：检查 `<业务项目根绝对路径>/inputs/req.md` 所有带 `*` 的 H2 节是否非空；检查 `<业务项目根绝对路径>/inputs/config.env` 的 `CLOUD_PROVIDER` 与对应密钥变量非空；后续可扩展校验其它 `<业务项目根绝对路径>/inputs/` 下文件。未通过 → 退出码 **2**，列出缺失项等用户补全。
3. `sync-config.cjs`：将 `<业务项目根绝对路径>/inputs/config.env` 内容写入 `<业务项目根绝对路径>/docs/config.env`（覆盖）, 把云平台配置同步到业务项目根目录下`<业务项目根绝对路径>/docs/config.<dev|release>.json`, 若该文件不存在，则从`docs/spec/std3/templates/config.json.template`中拷贝后再填入。
4. `register-project.cjs`：注册业务项目到`<skills_root>/_projects/<project_name>/runtime.json`文件，若项目已存在，则更新项目信息。
5. setup.cjs: 
5.1 初始化业务项目根目录下`<业务项目根绝对路径>/.pipeline/stages.json`文件，若该文件不存在，则从`docs/spec/std3/templates/stages.json.template`中拷贝后再填入：
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
```

## 日志事件（setup）

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

## 输出

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

## 解锁

`stages.setup.status=completed` → 可运行 `prd`。

---
