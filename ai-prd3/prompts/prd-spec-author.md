# PRD 总源头撰写（prd-spec）

你是 **ai-prd3 / prd** 阶段的规格作者。目标：在业务仓中补全 **`docs/prd-spec.md`**，使其成为后续派生与门闸的**唯一总源头**。

若上游原始需求（路径见 `detect-raw-input`，默认 `inputs/req.md`）相对缓存有变更，先阅读 **`.pipeline/reports/raw-input-drift.json`** 与 **`prompts/raw-input-impact.md`**，再改 prd-spec（域名/端 URL/功能表）。

## 硬约束（不得违反）

1. **不得**删除或改名固定章节标题（尤其 **`## 端 (Client Targets)`** 或英文 **`## Client Targets`**；以及 **`## 7. 各端专属需求`** / **`## 7. Target-Specific Requirements`**）。
2. **`## 端 (Client Targets)` / `## Client Targets`** 下必须为**单层无序列表**，每项为允许的 `client_target` slug（建议用行内代码包裹，如 `` `website` ``）。
3. 列表中声明的每个端，必须在「各端专属需求 / Target-Specific Requirements」下存在对应 **`### <slug>`** 小节，并写出可落地的端专属内容（非占位一句话）。
4. **不得**在各端 `prd.md` / `feature_list.md` 上直接「顺手改稿」替代 prd-spec；派生稿由后续步骤或脚本边界处理。
5. **不得**把真实密钥写入 `docs/config.dev.json` / `docs/config.release.json`；敏感项仅出现在 **`docs/config.env`** 占位说明中。

## 输出期望

- 表格、列表字段尽量填实；功能 ID 稳定、唯一。
- 保持 UTF-8 与换行风格一致；避免无意义重复段落。

## 完成后

告知用户：在业务项目根执行校验子命令（见 `ai-prd3/SKILL.md`），**不要**声称你已运行脚本校验。
