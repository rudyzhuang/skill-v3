---
name: ai-publish-release3
description: 在业务项目执行 release 环境 deploy、smoke 及 release 内部子步骤（版本、changelog、打标、托管资产等），读写 `.pipeline/stages.json` 与 `docs/config.release.json`。在用户提及「ai-publish-release3」「正式发布」「release 部署」时使用；默认不由 ai-auto3 调用。
disable-model-invocation: true
---

# ai-publish-release3（第三代 release 发布）

## 规范真源

实现与验收以 **`docs/spec/publish3.md`** 为准；全流水线语义见 **`docs/input-spec.md`**。

## 触发词

「ai-publish-release3」「正式发布」「release 部署」「release 冒烟」。

## 必读 / 必写路径

| 用途 | 路径 |
| --- | --- |
| release 部署配置 | `docs/config.release.json`（只读） |
| 密钥 | `docs/config.env`（只注入子进程，禁止写回 JSON/日志正文） |
| 流水线状态 | `.pipeline/stages.json`（含 `stages.deploy.outputs.release_meta` additive 写回，见 §5.3） |

## 与 dev skill 的差异（定稿）

- **仅**读取 **`config.release.json`** 做部署决策；**不**读取 `config.dev.json`。
- **`run.cjs` / `preflight`**：对 **`deploy.enabled===true`** 的 **release** 改线资源前，必须取得 **`--confirm-deploy`**（显式确认）。**`deploy.approval_required===true`** 时缺少该开关 → **1**；**`approval_required===false`** 时仍**不得**零确认部署，**同一 `--confirm-deploy` 门闸**（见 `publish3.md` §5.2）。
- 额外脚本 **`release.cjs`**：由 `config.release.json.release` 驱动版本/changelog/tag/gh release 等；顺序见 `publish3.md` §5.3.1。
- **PID 锁**：**`deploy-release`**（与 dev 的 `deploy-dev` 区分）。
- 串联失败时 stderr 输出 **`failed_step=deploy|smoke|release`**。

## destructive 与误发风险

- **release deploy** 为 destructive；**ai-auto3 默认不调用本 skill**（`input-spec.md` §4.3）。
- **不得**暗示与 dev 共用同一入口即可上 release（文案与 CLI 均须独立）。

## CLI

```bash
node scripts/run.cjs --project=/abs/path/to/repo [--confirm-deploy] [--from-stage=deploy|smoke] [--force-rerun] [--dry-run] [--session-id=...] [--require-deploy] [--require-smoke]
```

当 **`deploy.enabled===true`** 且非 **`--dry-run`** 时，**必须**传入 **`--confirm-deploy`**，否则 **1**、`failed_step=deploy`。

## 退出码与清单

见 [reference.md](reference.md)。

## 模板真源

配置形状以业务仓 **`docs/templates/*.template`** 为准。本 skill **`templates/`** 含 **deploy / smoke / stages** 子集（`stages.json.template`、`config.release.json.template`、`deploy-services.catalog.json`）；与 **`docs/templates/`** 同期维护，说明见 [templates/README.md](templates/README.md)。
