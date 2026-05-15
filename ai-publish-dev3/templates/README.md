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

## 其它云自动化（`deploy.provider`）

统一注册表：**`scripts/lib/providers/registry.cjs`**（`preflight` / `deploy` 仅允许 **manual**、表内 provider、自测 **exit8-test**）。各实现为 **CLI 薄封装**：运行环境需已安装对应 CLI（`aws` / `aliyun` / `az` 等），产物目录与 **`resource_config`** 见各 `*.cjs` 文件头注释。

| `provider` | 主要依赖（`docs/config.env`） | 典型 `resource_config` |
| --- | --- | --- |
| **vercel** | `VERCEL_TOKEN`；可选 `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` | `vercel_team_slug`、`vercel_project_id`、`public_url`（解析不到 deploy URL 时必填） |
| **aws** | `AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`；可选 `AWS_SESSION_TOKEN` | `s3_bucket`、可选 `s3_prefix`、`aws_region`、`cloudfront_distribution_id`、`public_url` / `s3_website_endpoint` 等 |
| **alibaba_cloud** | `ALIBABA_CLOUD_ACCESS_KEY_ID` / `SECRET` 或 `ALICLOUD_ACCESS_KEY` / `SECRET` | `oss_bucket`、`oss_prefix`、`oss_region` / `oss_endpoint` |
| **tencent_cloud** | `TENCENTCLOUD_SECRETID`/`KEY` 或 `COS_SECRET_ID`/`KEY` | `cos_bucket`、`cos_endpoint_url`（S3 兼容）、`cos_prefix`、`public_url` |
| **huawei_cloud** | `HUAWEI_ACCESS_KEY_ID`/`SECRET` 或 `OBS_ACCESS_KEY_ID`/`SECRET` | `obs_bucket`、`obs_endpoint_url`、`obs_prefix`、`public_url` |
| **google_cloud** | `FIREBASE_TOKEN` | `firebase_project`、`firebase_hosting_site`、`public_url`；默认将产物 **cp** 到 `firebase.json` 的 **hosting.public**（可 `skip_sync_artifact_to_hosting`） |
| **azure** | `AZURE_STORAGE_CONNECTION_STRING` | `storage_container`、`blob_prefix`、`public_url` |
