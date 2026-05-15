# ai-publish-dev3 — 参考与验收

## 退出码（publish 族常用）

| 码 | 场景 |
| --- | --- |
| 0 | 成功（含允许的 **skipped**；`--dry-run` 下 deploy/smoke 不触网） |
| 1 | 缺文件/配置/门闸/映射/forbidden/未授权 autorun deploy/不支持的 **provider**（非 manual / **registry 已注册云** / 自测 **exit8-test**）/手工 deploy 缺 **`--explicit-confirm`** 等 |
| 2 | 用户取消（预留） |
| 3 | **超时**（`run-with-timeout.cjs`）：smoke HTTP 整包超时写回 `timed_out`/`timeout_reason`/`duration_ms`；`manual` deploy 同步体见 SKILL「已知限制」 |
| 4 | **smoke** HTTP 检查未通过（质量门） |
| 8 | **deploy** 云/托管 API 或 CLI（**`wrangler` / `vercel` / `aws` / `aliyun` / `firebase-tools` / `az` 等**）失败：**已注册云 provider** 与自测 **`exit8-test`**（`AI_PUBLISH_DEV3_SELFTEST=1`） |

## `stages.json` 写回（摘要）

- `stages.deploy.environment`：**`dev`**。
- `stages.deploy.inputs.config`：**`docs/config.dev.json`**；**`inputs.summary_hash`** additive（§6.3）。
- `stages.smoke.inputs.summary_hash`：含 **`config.smoke.checks`** 与 **`x-smoke`** 合并后的规范化输入（§6.3）。
- **跳过**：`deploy.enabled=false` / `smoke.enabled=false` / 无检查项等路径写 **`skip_reason`**（§5.1、§7.2）。
- 密钥**不得**写入 `stages.json`。

## PID 锁（`publish3.md` §10.2）

| Scope | 说明 |
| --- | --- |
| `deploy-dev` | deploy 子过程持有，结束释放 |
| `smoke` | smoke 子过程持有，结束释放；与 release skill 共用 **scope 名** |

## `publish3.md` 全量核对（**仅 ai-publish-dev3 / dev**）

以下对照 **`docs/spec/publish3.md`**；**§4.4 / §5.2 / §5.3** 等属 **`ai-publish-release3`**，不在本 skill 实现范围内。

| 章节 | 要求摘要 | 本 skill 状态 |
| --- | --- | --- |
| §3 | 脚本驻留 skill、`--project`、确定性进脚本、CJS、不隐式 build | **已满足** |
| §4.1 目录 | `config-load.cjs`/`secret-env.cjs` 命名与现网 **`config-env.cjs`** 不一致 | **功能等价**（命名未对齐文档，以 SKILL 表为准） |
| §4.1 | `prompts/` 可选 | **未建**（可选） |
| §4.3 `run.cjs` | 参数、`--confirm-deploy` 拒绝、退出码、`failed_step` | **已满足** |
| §4.3 `preflight` | config、env、stages 门闸、forbidden | **已满足**；**自动化 provider** 追加 **`docs/config.env`** 键校验（见 `lib/providers/registry.cjs`） |
| §4.3 `deploy` | `deploy-dev` 锁、provider、写回、云失败 **8**、缺凭证 **1** | **已满足**（**manual** / **registry 内云** / **exit8-test**） |
| §4.3 `smoke` | `smoke` 锁、串行于 deploy 后、失败 **4** | **已满足** |
| §4.3 `init.cjs` | 可选占位 | **已满足**（占位） |
| §5.1 | deploy/smoke skip + `skip_reason`；`--require-deploy` | **已满足** |
| §5.1.1 | `allow_destructive_deploy` + autorun | **已满足**（`run.cjs`） |
| §6.x | `summary_hash`、artifacts 写回、§6.2 跳过 | **已满足**；deploy 哈希未含可选 **api.yaml** 列表（SKILL 已声明子集） |
| §7.x | deploy/smoke 前置、GET/HEAD、safe POST、不写敏感体 | **已满足** |
| §8 | `x-smoke` 与 checks 合并 | **已满足**（`js-yaml` + `collect-x-smoke.cjs`） |
| §9 | 退出码表、`failed_step` | **已满足** |
| §10.1 | `.agent-sessions`、**`alive:`**、长日志目录 | **部分**：会话日志 + 心跳 **已**；**`.agent-sessions/logs/*.log`** 未单独落长日志文件 |
| §10.2 | PID 锁体 JSON | **已满足** |
| §11 | 双 skill 目录存在 | **仓库级**（`ai-publish-release3` 在仓内另目录；非本 skill 代码职责） |

## 评审对照 `publish3.md` §11（dev 相关）

- [x] 仅读 **`config.dev.json`**；密钥只来自 **`docs/config.env`**（解析占位，值不写回 stages）。
- [x] **`--project`** 非法 → **1**。
- [x] forbidden 扫描；**`security.*` 键名豁免**避免模板误报。
- [x] **artifact 一对一**；**`artifact_ref`** 优先（`lib/artifacts.cjs`）。
- [x] **manual** / **registry 内各云** `deploy` 成功路径写回 **`stages.deploy.outputs.*`**（含 **url**、**status**、**log_path** 字段位；`log_path` 常为空字符串）。
- [x] **smoke**：默认 **GET/HEAD**；**`x-smoke` safe/safe_post** 允许 **safe POST**。
- [x] **§6.2**：`summary_hash` 一致且 **`status=completed`** 且 **`validation.passed`** 时跳过；**`--force-rerun`** 可重跑。
- [x] **§5.1.1**：`--invoked-by-autorun` + `allow_destructive_deploy` 门闸。
- [x] **超时** smoke → **退出 3**，写 **`timed_out`/`timeout_reason`/`duration_ms`**（HTTP 路径）。
- [x] **x-smoke** 与 **`smoke.checks[]`** 合并（`stages.contract.outputs.artifacts[].api` 与约定 **`docs/api.yaml`**）。
- [x] **`.agent-sessions/<session_id>.log`** + **`alive:`**（经 `run-with-timeout` 心跳回调）。
- [x] **`init.cjs`** 占位入口。
- [x] **多平台自动化**：`lib/providers/registry.cjs` 调度 **cloudflare** / **vercel** / **aws** / **alibaba_cloud** / **tencent_cloud** / **huawei_cloud** / **google_cloud** / **azure**（静态/OSS/Firebase/Blob 等 **CLI 薄封装**；非 FC/SAE/GKE 等全量 PaaS）。
- [ ] **catalog 中其余资源型**（如 FC、GKE、RDS）仍不在本 skill 自动化范围内。

## 评审轮次记录（实现收口）

| 轮次 | 日期 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 2026-05-15 | **通过** | `bash scripts/selftest.sh` 全绿（含 `npm ci`、`exit8-test`、smoke 4） |
| 2 | 2026-05-15 | **通过** | 连续第二次执行 `bash scripts/selftest.sh` 全绿 |
| 3 | 2026-05-16 | **通过** | 全量对照 `publish3.md`（dev）+ `bash scripts/selftest.sh` |
| 4 | 2026-05-16 | **通过** | 连续第二次 `bash scripts/selftest.sh` 全绿（与轮次 3 构成「连续两轮」） |
