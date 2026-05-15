# prompts（可选）

`code-review`、测试 **fix-loop**、**`codegen-impl.md`** / **`code-review-agent.md`**（实现相 / code_review 相骨架）等由 LLM 完成的步骤，可将系统/用户提示词放在此目录，由 `SKILL.md` 或编排引用。

确定性校验、`.pipeline/stages.json` 读写、子进程与退出码须在 `scripts/**/*.cjs` 中实现，不得由 LLM「假装执行」。
