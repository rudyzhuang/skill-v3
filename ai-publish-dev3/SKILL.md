---
name: ai-publish-dev3
description: 在业务项目执行 dev 环境 deploy 与 smoke，读写 `.pipeline/stages.json` 与 `docs/config.dev.json`。在用户提及「ai-publish-dev3」「dev 部署」「dev 冒烟」或由 ai-auto3 编排调用 dev 发布时使用。
disable-model-invocation: true
---

# ai-publish-dev3（第三代 dev 发布）

## 规范真源

实现与验收以仓库 **`docs/spec/publish3.md`** 为准；全流水线退出码、超时、日志目录、PID 锁语义见 **`docs/input-spec.md`**。

## 触发词

「ai-publish-dev3」「dev 部署」「dev 冒烟」、以及 **ai-auto3 / autorun** 在 dev 路径上 spawn 本 skill 的 deploy+smoke。

## 必读 / 必写路径

| 用途 | 路径 |
| --- | --- |
| dev 部署配置 | `docs/config.dev.json`（只读） |
| 密钥（仅注入子进程 env，禁止写回 JSON/日志正文） | `docs/config.env` |
| 流水线状态 | `.pipeline/stages.json` |
| 契约（x-smoke 来源之一） | 各端 `api.yaml`（路径见 contract/build 输出或项目约定） |

## 架构约束（摘要）

- 脚本仅驻留在 **本 skill 目录** `scripts/**/*.cjs`，**不**复制到业务仓。
- 调用：`node <skill_dir>/scripts/run.cjs --project=<业务项目根绝对路径> [选项]`；**禁止**以 `process.cwd()` 作为项目根唯一真源。
- **deploy** 与 **release** 能力拆分为两个 skill（见 `publish3.md` §0）；本 skill **仅** dev。
- **destructive**：`deploy` 在 dev 下仍为 destructive（`input-spec.md` §7.2）。**手工**执行真实 deploy（非 `--dry-run`）前须 **`--explicit-confirm`**，表示已在对话/评审中确认。**ai-auto3** 自动 spawn dev deploy 时**不得**传 `--explicit-confirm`**，须传 **`--invoked-by-autorun`**，且 **`docs/config.dev.json.pipeline.autorun.allow_destructive_deploy === true`**，否则 **退出码 1**（`publish3.md` §5.1.1）。
- **本 skill 不接受 `--confirm-deploy`**（该开关仅 **ai-publish-release3**）。

## CLI

```bash
node scripts/run.cjs --project=/abs/path/to/repo \
  [--from-stage=deploy|smoke] [--force-rerun] [--dry-run] [--session-id=...] \
  [--require-deploy] [--require-smoke] [--invoked-by-autorun] [--explicit-confirm]
```

| 子脚本 / 库 | 职责 |
| --- | --- |
| `preflight.cjs` | `config.dev.json`、`config.env` 可解析、forbidden 键扫描、`merge_push`/`build` 门闸、`artifact_ref` 优先的一对一产物映射、非 manual 的 provider 预检拒绝（`publish3.md` §7.1） |
| `deploy.cjs` | `deploy-dev` PID 锁；**`provider=manual`** 时写回 `stages.deploy`（无云 API）；其它 provider **退出 1**（待扩展 `lib/providers/*`） |
| `smoke.cjs` | `smoke` PID 锁；`smoke.checks[]` 的 **GET/HEAD** HTTP（`lib/http-smoke.cjs`）；未通过 **退出码 4**；写回 `stages.smoke`；**契约 x-smoke 合并未实现**（见下节「已知缺口」） |
| `lib/stages-io.cjs` | 原子写回 `stages.json` |
| `lib/summary-hash.cjs` | `inputs.summary_hash`（`publish3.md` §6.3 子集） |
| `lib/artifacts.cjs` | `artifact_ref` 与 `(client_target, sub_platform)` 映射 |
| `lib/config-env.cjs` | 解析 `docs/config.env`（占位校验入口） |
| `lib/forbidden-scan.cjs` | `security.forbidden_json_key_patterns`；**`security.*` 模板键名不参与子串匹配**以免误报 `secret_env_path` |

`--invoked-by-autorun`：在即将执行 **deploy** 前校验 **`pipeline.autorun.allow_destructive_deploy`**。

`--force-rerun`：忽略 **`publish3.md` §6.2** 的「已完成且 `summary_hash` 一致则跳过」。

## 与上下游

- **上游**：`ai-code3` 已完成 **`merge_push`** 与（按端）**`build`**；产物与 `deploy.services[]` 一一映射（`publish3.md` §7.1，含 **`artifact_ref`**）。
- **下游**：完成后进入人工验收或 **ai-auto3** 默认序列后续（不含 release skill）。

## 退出码与 `failed_step`

与 `publish3.md` §9 一致；串联失败 stderr 输出 **`failed_step=deploy|smoke`**。完整表见 [reference.md](reference.md)。

## 已知缺口（与 `publish3.md` / `input-spec.md` 对齐路线）

| 项 | 状态 |
| --- | --- |
| `lib/run-with-timeout.cjs`、超时 **退出 3**、`timed_out`/`timeout_reason`/`duration_ms` | 未实现 |
| 云 provider、`deploy` 失败 **退出 8**（API/401/403） | 未实现（当前非 manual → **1**） |
| 从 `stages.contract` / `api.yaml` 解析 **x-smoke** 与 checks 合并 | 未实现（`smoke.cjs` 仅 `smoke.checks[]`） |
| `.agent-sessions` 日志、`alive:` 心跳 | 未实现 |
| `init.cjs`（可选） | 未实现 |

自测：`scripts/selftest.sh`（需网络访问 **example.com** 以验证 HTTP smoke）。

## 模板真源

配置与 `stages.json` 字段形状以业务仓 **`docs/templates/*.template`** 为准。本 skill **`templates/`** 含 deploy/smoke/stages 子集，见 [templates/README.md](templates/README.md)。
