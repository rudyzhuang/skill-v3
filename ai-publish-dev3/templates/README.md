# templates（deploy / smoke / stages 子集）

业务项目中的 **`docs/templates/*.template`** 仍为 **SSOT**。本目录为 skill-v3 仓内与 **`docs/templates/`** 对齐的**离线子集**，模板 breaking 变更时请在同一维护周期内同步更新此处与 **`docs/spec/publish3.md`**。

## 本目录文件

| 文件 | 用途 |
| --- | --- |
| `stages.json.template` | `deploy` / `smoke` 阶段键与字段形状 |
| `config.dev.json.template` | dev 下 `deploy`、`smoke`、`pipeline.autorun.allow_destructive_deploy` 等 |
| `deploy-services.catalog.json` | deploy provider / 服务候选集（与 `publish3.md` §0 交叉索引） |

未包含：`config.env.template`（密钥占位）、`config.release.json`（由 **ai-publish-release3** 子集携带）等。

## Cloudflare 全自动部署（`deploy.provider: "cloudflare"`）

与 **ai-deploy2** `scripts/cloudflare/deploy.sh` 对齐的 Node 实现见 **`scripts/lib/providers/cloudflare.cjs`**。

| 项 | 说明 |
| --- | --- |
| **凭证** | `docs/config.env`：`CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`（须非空） |
| **Pages** | `resource_type` 为 `pages_project` / `static_site` / `web_app` 等（且目录下无 `wrangler.toml` 或显式非 worker）→ 按 **`service_name`**（或 `resource_config.project_name`）作为 **Pages 项目名**：API 预创建项目 + `npx wrangler pages deploy` |
| **Workers** | `resource_type` 含 worker / edge，或产物目录含 **`wrangler.toml`** → `npx wrangler deploy`；**自定义域名**时 **`service_name` 须与 `wrangler.toml` 的 `name`（脚本名）一致** |
| **域名 / HTTPS** | `deploy.services[].domain` 填 apex 或主机名（可带 `https://`）；在 Zone 托管于 Cloudflare 时：**Pages/Workers Domains API** + **DNS CNAME**（`proxied=true`，边缘证书自动） |
