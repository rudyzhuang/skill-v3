# codegen 实现相（impl）— Agent 提示骨架

供 **`invoke-codegen-agent`** 或人工在 **`.pipeline/worktrees/v3-fc-<feature_id>/`** 内驱动实现时使用。确定性门闸、**`stages.json`** 写入与 **diff-guard** 必须由 **`codegen.cjs`** 完成，不得由本提示替代。

## 上下文（由脚本注入）

- **`AI_CODE3_WORKTREE`**：当前 worktree 绝对路径（工作目录应设为此路径）。
- **`AI_CODE3_PROJECT`**：业务项目主仓绝对路径。
- **`AI_CODE3_PHASE`**：实现阶段标识（如 **`impl`**）。

## 任务

1. 阅读 **`stages.contract.outputs`** 与 **`stages.design.outputs.design_snapshot`**（或等价字段）中与当前 **`feature_id`** 相关的契约与 **`file_plan`**。  
2. 仅在 worktree 内修改/新增文件；**不要**改动主仓未通过 merge 的路径（除非脚本已明确允许）。  
3. 满足契约中的接口与行为约束；保持与仓库既有风格一致。  
4. 完成后确保 **`npm test` / `pnpm test`** 等（若项目约定）在 worktree 视角可执行的路径一致。

## 禁止

- 伪造 **`stages.json`** 或门闸字段。  
- 在日志中输出密钥或 **`config.env`** 全文。
