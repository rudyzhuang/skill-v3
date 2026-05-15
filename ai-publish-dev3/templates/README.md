# templates（deploy / smoke / stages 子集）

业务项目中的 **`docs/templates/*.template`** 仍为 **SSOT**。本目录为 skill-v3 仓内与 **`docs/templates/`** 对齐的**离线子集**，模板 breaking 变更时请在同一维护周期内同步更新此处与 **`docs/spec/publish3.md`**。

## 本目录文件

| 文件 | 用途 |
| --- | --- |
| `stages.json.template` | `deploy` / `smoke` 阶段键与字段形状 |
| `config.dev.json.template` | dev 下 `deploy`、`smoke`、`pipeline.autorun.allow_destructive_deploy` 等 |
| `deploy-services.catalog.json` | deploy provider / 服务候选集（与 `publish3.md` §0 交叉索引） |

未包含：`config.env.template`（密钥占位）、`config.release.json`（由 **ai-publish-release3** 子集携带）等。
