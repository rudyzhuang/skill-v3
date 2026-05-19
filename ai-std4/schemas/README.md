# ai-std4 JSON Schema

供脚本通过 **Ajv**（draft-07）校验 Agent 产出与 `stages.json` 增量写入。`prd-*.json.schema.json` 通过 `allOf` 引用 [prd-client.base.schema.json](prd-client.base.schema.json)。

| Schema | 校验目标 |
| --- | --- |
| [stop.signal.schema.json](stop.signal.schema.json) | `.pipeline/stop.signal` |
| [stages.json.schema.json](stages.json.schema.json) | `output-stages/stages.json` |
| [config.json.schema.json](config.json.schema.json) | `docs/config.dev.json` / `config.release.json` |
| [prd-web.json.schema.json](prd-web.json.schema.json) | `output-stages/prd/prd-web.json` |
| [prd-backend.json.schema.json](prd-backend.json.schema.json) | `output-stages/prd/prd-backend.json` |
| [prd-mobile.json.schema.json](prd-mobile.json.schema.json) | `output-stages/prd/prd-mobile.json` |
| [prd-admin.json.schema.json](prd-admin.json.schema.json) | `output-stages/prd/prd-admin.json` |
| [prd-default.json.schema.json](prd-default.json.schema.json) | 未知端 `output-stages/prd/prd-*.json` |
| [prd-review-client-output.schema.json](prd-review-client-output.schema.json) | `.pipeline/prd-review-<client_target>.json` |
| [prd-review-output.schema.json](prd-review-output.schema.json) | `.pipeline/prd-review-output.json` |
| [design.json.schema.json](design.json.schema.json) | `output-stages/design/<feature_id>.design.json` |
| [design-review-feature-output.schema.json](design-review-feature-output.schema.json) | `.pipeline/design-review-<feature_id>.json` |
| [deploy-triage-output.schema.json](deploy-triage-output.schema.json) | `.pipeline/deploy-triage.json` |
| [merge-push-triage-output.schema.json](merge-push-triage-output.schema.json) | `.pipeline/merge-push-triage.json` |
| [merge-push-push-triage-output.schema.json](merge-push-push-triage-output.schema.json) | `.pipeline/merge-push-push-triage.json` |
| [ui-e2e-triage-output.schema.json](ui-e2e-triage-output.schema.json) | `.pipeline/ui-e2e-triage-<feature_id>.json` |

← [返回规范索引](../std4.md#9-附录json-schema-文件)
