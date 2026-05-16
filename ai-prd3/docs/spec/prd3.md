# ai-prd3 规范（SSOT）

版本：0.2.5（与 `SKILL.md` frontmatter 对齐）

## 1. 原始需求输入（raw input）

- **不写死文件名**：默认路径 `inputs/req.md`（ai-soak3 约定），真源为 `stages.pipeline.raw_input.path` 或环境变量 `AI_PRD3_RAW_INPUT` / CLI `--raw-input=`。
- **缓存**：`stages.prd.inputs.raw_input_hash`（全文 SHA-256）、`raw_input_functional_hash`（「功能需求」节）。
- **探测**：子命令 `detect-raw-input` → `.pipeline/reports/raw-input-drift.json`（含 `impact_hints` 供 Agent）。
- **配置同步**：`apply-raw-input-config` 将域名与各端 URL 写入 `config.dev.json` / `config.release.json` 的 `deploy.services`（website、admin、backend）及 `smoke`；**功能变更**须由 Agent 改 `prd-spec.md` 后走 `validate-prd` / `write-prd`。
- **校验**：`validate-prd` 首步调用 `detect-raw-input`；`prd-validate-config` 要求 `deploy.services` 覆盖 prd-spec 中声明的 website/admin/backend。

## 2. 子命令（节选）

| 子命令 | 说明 |
| --- | --- |
| `detect-raw-input` | 比对哈希；`--fail-on-change` → 退出码 2 |
| `apply-raw-input-config` | 同步 config；更新 raw_input 缓存 |
| `validate-prd` | detect → spec → derived → config |
| 其余 | 见 `SKILL.md` |

## 3. Agent 提示词

| 文件 | 用途 |
| --- | --- |
| `prompts/raw-input-impact.md` | 原始需求变更后的 prd-spec / 派生稿更新 |
| `prompts/prd-spec-author.md` | 补全 prd-spec |
| `prompts/prd-review.md` | prd-review JSON |

## 4. 退出码

| 码 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 校验/前置失败 |
| 2 | `detect-raw-input --fail-on-change` 且内容已变更 |
| 3 | 超时 |

其余章节与历史 `prd3.md` 行为一致；实现以 `scripts/` 为准。
