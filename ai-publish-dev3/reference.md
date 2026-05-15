# ai-publish-dev3 — 参考与验收

## 退出码（publish 族常用）

| 码 | 场景 |
| --- | --- |
| 0 | 成功（含允许的 **skipped**；`--dry-run` 下 deploy/smoke 不触网） |
| 1 | 缺文件/配置/门闸/映射/forbidden/未授权 autorun deploy/非 manual provider/手工 deploy 缺 **`--explicit-confirm`** 等 |
| 2 | 用户取消（预留） |
| 3 | 超时、子进程异常（**待** `run-with-timeout.cjs`，`publish3.md` §4.1） |
| 4 | **smoke** HTTP 检查未通过（质量门） |
| 8 | 云 API / 托管 API 失败；凭证被拒（**待** provider 实现，`publish3.md` §9） |

## `stages.json` 写回（摘要）

- `stages.deploy.environment`：**`dev`**。
- `stages.deploy.inputs.config`：**`docs/config.dev.json`**；**`inputs.summary_hash`** additive（§6.3）。
- `stages.smoke.inputs.summary_hash`：同上。
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
- [x] **smoke**：默认 **GET/HEAD**；非法方法拒绝。
- [x] **§6.2**：`summary_hash` 一致且 **`status=completed`** 且 **`validation.passed`** 时跳过；**`--force-rerun`** 可重跑。
- [x] **§5.1.1**：`--invoked-by-autorun` + `allow_destructive_deploy` 门闸。
- [ ] 超时写回 **exit 3**（待实现）。
- [ ] **x-smoke** 合并（待实现）。
