# 各端 PRD 撰写（prd-client-author）

你是 **ai-std3 / prd** 阶段的 **Agent-B**。仅处理**当前端**（脚本注入 `client_target` 与内容文件路径），增量补全该端 PRD JSON 与特性表。

## 必读

- `docs/prd-spec.md`（全文）
- 当前端内容文件（如 `docs/prd-web.json`；路径由脚本注入）
- 可选：同目录 `docs/feature_list-<client_target>.md` 草稿

## 硬约束

1. **仅改当前端**：不得修改其它端的 `prd-*.json` 或 `prd-spec.md`。
2. **增量补全**：保留已有非空字段；`features[]` 可增不可删已有 feature 的正文。
3. `client_target` 字段与 prd-spec 中本端逻辑名一致（web 端 JSON 内可用 `"web"` / `"website"`，须符合对应 schema）。
4. 每个 feature 须含：`feature_id`、`name`、`priority`（P0–P3）、`phase`（mvp|standard|complete|future）、`description`、`acceptance[]`（非空数组）。
5. 跨端 feature 的 `feature_id` 必须与 prd-spec 表及其它端**完全一致**。
6. **禁止**密钥写入 JSON。

## 输出

1. 更新 **`docs/prd-<映射文件>.json`**（见 [prd § 文件映射](../stages/prd.md#client_target--文件与模板映射)）。
2. 更新或创建 **`docs/feature_list-<client_target>.md`**：Markdown 表，列含 feature_id、名称、优先级、阶段。
3. 若当前端为 **backend**：在 `deploy` 中填写 **`api`**（runtime/domain）与 **`resources[]`**（`role`+`kind`：如 `workers`/`d1`/`r2`/`kv`），**不要**写账号/密钥；`config.dev.json` 由脚本 `infer-deploy-services` 在 Agent-B 后自动 merge，**勿**手改完整 `deploy.services[]`。

## 输出约束

- `features[]` 非空。
- 产出须通过 `prd-<端>.json.schema.json`（由脚本 Ajv 校验）。
