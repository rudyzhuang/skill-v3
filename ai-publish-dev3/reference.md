# ai-publish-dev3 — 参考与验收

## 退出码（publish 族常用）

| 码 | 场景 |
| --- | --- |
| 0 | 成功（含允许的 **skipped**；`--dry-run` 下 deploy/smoke 不触网） |
| 1 | 缺文件/配置/门闸/映射/forbidden/未授权 autorun deploy/非 manual（且非自测 exit8-test）provider/手工 deploy 缺 **`--explicit-confirm`** 等 |
| 2 | 用户取消（预留） |
| 3 | **超时**（`run-with-timeout.cjs`）：smoke HTTP 整包超时写回 `timed_out`/`timeout_reason`/`duration_ms`；`manual` deploy 同步体见 SKILL「已知限制」 |
| 4 | **smoke** HTTP 检查未通过（质量门） |
| 8 | **deploy** 云/托管 API 类失败（真实 provider 待实现）；自测 **`exit8-test`** + **`AI_PUBLISH_DEV3_SELFTEST=1`** 可验证本退出码 |

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

## 评审对照 `publish3.md` §11（dev 相关）

- [x] 仅读 **`config.dev.json`**；密钥只来自 **`docs/config.env`**（解析占位，值不写回 stages）。
- [x] **`--project`** 非法 → **1**。
- [x] forbidden 扫描；**`security.*` 键名豁免**避免模板误报。
- [x] **artifact 一对一**；**`artifact_ref`** 优先（`lib/artifacts.cjs`）。
- [x] **manual** `deploy` 成功路径写回 **`stages.deploy.outputs.*`**。
- [x] **smoke**：默认 **GET/HEAD**；**`x-smoke` safe/safe_post** 允许 **safe POST**。
- [x] **§6.2**：`summary_hash` 一致且 **`status=completed`** 且 **`validation.passed`** 时跳过；**`--force-rerun`** 可重跑。
- [x] **§5.1.1**：`--invoked-by-autorun` + `allow_destructive_deploy` 门闸。
- [x] **超时** smoke → **退出 3**，写 **`timed_out`/`timeout_reason`/`duration_ms`**（HTTP 路径）。
- [x] **x-smoke** 与 **`smoke.checks[]`** 合并（`stages.contract.outputs.artifacts[].api` 与约定 **`docs/api.yaml`**）。
- [x] **`.agent-sessions/<session_id>.log`** + **`alive:`**（经 `run-with-timeout` 心跳回调）。
- [x] **`init.cjs`** 占位入口。
- [ ] 生产级 **云 provider** 与 **退出 8** 真实语义（非自测 `exit8-test`）。

## 评审轮次记录（实现收口）

| 轮次 | 日期 | 结果 | 说明 |
| --- | --- | --- | --- |
| 1 | 2026-05-15 | **通过** | `bash scripts/selftest.sh` 全绿（含 `npm ci`、`exit8-test`、smoke 4） |
| 2 | 2026-05-15 | **通过** | 连续第二次执行 `bash scripts/selftest.sh` 全绿 |
