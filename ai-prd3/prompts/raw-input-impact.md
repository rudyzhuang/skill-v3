# 原始需求变更影响分析（raw-input → prd-spec / 派生稿）

上游（如 **ai-soak3**）在业务仓提供原始需求 Markdown，**路径不写死**：默认 `inputs/req.md`，可由 `stages.pipeline.raw_input.path` 或环境变量 `AI_PRD3_RAW_INPUT` 覆盖。

## 你的工作流

1. 在项目根执行 **`detect-raw-input`**，阅读 **`.pipeline/reports/raw-input-drift.json`** 中的 `impact_hints`。
2. 按 `category` 处理：
   - **`domain`**：更新 `docs/prd-spec.md` 中云平台/主域名/各端 URL；勿改密钥。然后执行 **`apply-raw-input-config`** 同步 `config.dev.json` / `config.release.json` 的 `deploy.services`（须含 website、admin、backend）与 `smoke`。
   - **`client_targets`**：改 prd-spec「端」列表与各端 `### <slug>` 小节，必要时 `bootstrap --force` 重派生 feature_list。
   - **`features`**：改 prd-spec §6 核心功能表，再派生各端 `prd.md` / `feature_list.md`。
3. 完成后：`validate-prd` → `write-prd`（若 prd 已完成则加 `--force`）；prd-review 若受影响则重做 `finalize-prd-review`。

## 禁止

- 不得把真实密钥写入 `config.*.json`。
- 不得仅在 `config` 改域名而不同步 prd-spec（双真源漂移）。
