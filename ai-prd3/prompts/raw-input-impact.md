# 原始需求变更影响分析（raw-input → prd-spec / 派生稿）

上游需求可以是 **Markdown 文件**（默认 `inputs/req.md`，路径可配置）或 **用户对话中粘贴的一段 Markdown**。

## 内联文字（用户直接输入）

当用户在对话中给出需求片段、尚未写入 `inputs/req.md` 时，Agent 应：

```bash
node ai-prd3/scripts/run.cjs detect-raw-input \
  --project=<业务项目根绝对路径> \
  --raw-input-text='## 功能需求
...完整 Markdown...'
```

或使用 heredoc / `--raw-input-text-file=path/to/draft.md`（读入后仍按**内联**处理并写入 `.pipeline/cache/raw-input.snapshot.md`）。

## 文件

```bash
node ai-prd3/scripts/run.cjs detect-raw-input --project=<root> --raw-input=inputs/req.md
```

## 工作流

1. 执行 **`detect-raw-input`**，阅读 **`.pipeline/reports/raw-input-drift.json`** 的 `impact_hints` 与 `raw_input.source`。
2. 按 `category` 处理：
   - **`domain`**：更新 `docs/prd-spec.md` 域名与各端 URL → **`apply-raw-input-config`**
   - **`client_targets`**：改 prd-spec 端列表 → 必要时 `bootstrap --force`
   - **`features`**：改 prd-spec §6 核心功能表 → 派生各端文档
3. `validate-prd` → `write-prd`（已完成则 `--force`）。

## 禁止

- 不得把真实密钥写入 `config.*.json`。
- 不得仅在 config 改域名而不同步 prd-spec。
