# code-review 相 — 外部 Agent 约定

由 **`code-review.cjs`** 在未设置 **`AI_CODE3_CODE_REVIEW_JSON`** 时调用 **`AI_CODE3_AGENT_BIN`**（或 **`AI_CODEGEN_AGENT_BIN`**），子进程环境包含：

- **`AI_CODE3_PHASE=code_review`**
- **`AI_CODE3_WORKTREE`** / **`AI_CODE3_PROJECT`**：默认均为业务项目根（主仓）
- **`AI_CODE3_FEATURE_ID`**：来自 **`--feature=`**（多 id 逗号拼接），可空
- **`AI_CODE3_CODE_REVIEW_OUTPUT`**：Agent **必须**将符合 Schema 的 JSON 写入该**绝对路径**文件（UTF-8）

Schema 真源：**`templates/schemas/code-review-output.v3.schema.json`**（与 **`docs/templates/schemas/`** 对档）。脚本用 **Ajv** 校验通过后才写 **`stages.code_review`**。

失败时 stderr 含 **`failed_stage=code_review`**（及可选 **`feature_id=`**）。
