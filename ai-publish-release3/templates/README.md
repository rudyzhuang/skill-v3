# templates（deploy / smoke / stages 子集）

业务项目 **`docs/templates/*.template`** 为 **SSOT**；本目录为与 **`docs/templates/`** 对齐的离线拷贝子集。

## 本目录文件

| 文件 | 用途 |
| --- | --- |
| `stages.json.template` | `deploy` / `smoke` 及 `release_meta` 写回相关形状 |
| `config.release.json.template` | release 下 `deploy`（含 `approval_required`）、`smoke`、`release` 内部子步骤配置 |
| `deploy-services.catalog.json` | deploy 服务/provider 候选集 |

未包含：`config.dev.json.template`（见 **ai-publish-dev3** 子集）、`config.env.template` 等。
