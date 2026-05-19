# ai-std4 模板文件

脚本在业务项目目标文件**不存在**时，从本目录拷贝模板后再由脚本或 Agent 填入。

| 模板 | 拷贝目标 |
| --- | --- |
| [req-template.md](req-template.md) | `<项目>/inputs/req.md` |
| [config.env.template](config.env.template) | `<项目>/inputs/config.env`（含 `CURSOR_API_KEY`、`PIPELINE_MODEL`、云凭证） |
| [config.json.template](config.json.template) | `<项目>/docs/config.dev.json`、`config.release.json` |
| [stages.json.template](stages.json.template) | `<项目>/.pipeline/stages.json` |
| [prd-spec.md.template](prd-spec.md.template) | `<项目>/docs/prd-spec.md` |
| [prd-web.json.template](prd-web.json.template) | `<项目>/docs/prd-web.json` |
| [prd-backend.json.template](prd-backend.json.template) | `<项目>/docs/prd-backend.json` |
| [prd-mobile.json.template](prd-mobile.json.template) | `<项目>/docs/prd-mobile.json` |
| [prd-admin.json.template](prd-admin.json.template) | `<项目>/docs/prd-admin.json` |
| [prd-default.json.template](prd-default.json.template) | 未知端 `<项目>/docs/prd-<client_target>.json` |

← [返回规范索引](../std4.md#6-附录模板文件)
