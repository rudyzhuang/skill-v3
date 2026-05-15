# prompts（可选）

`code-review`、测试 **fix-loop** 等由 LLM 完成的步骤，可将系统/用户提示词放在此目录（如 `code-review.md`），由 `SKILL.md` 引用。

确定性校验、`.pipeline/stages.json` 读写、子进程与退出码须在 `scripts/**/*.cjs` 中实现，不得由 LLM「假装执行」。
