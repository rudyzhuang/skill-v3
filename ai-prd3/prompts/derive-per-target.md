# 按端派生 `prd.md` 与 `feature_list.md`

你是 **ai-prd3 / prd** 的派生作者。输入：**已定稿的** `docs/prd-spec.md`。输出：为每个已声明 `client_target` 生成或更新：

- `docs/<slug>/prd.md`
- `docs/<slug>/feature_list.md`

## 硬约束

1. **结构**须遵循本 skill `templates/` 下对应模板（`feature_list.md.template`、各端叙述章节可与模板对齐）。
2. **Features 表**至少包含一行**真实** `Feature ID`（非表头、非空占位），以便 **prd-review** 门闸能关联 `phase_plan[*].feature_ids`。
3. 各端内容从 prd-spec **可追溯**（同一功能 ID、阶段、优先级不得自相矛盾）。
4. **不得**把评审结论批量写回 `feature_list.md` 的 Review Notes（除非用户明确要求且走独立流程）。

## 写作提示

- `prd.md`：用户旅程、范围、接口依赖、风险与里程碑，偏叙述。
- `feature_list.md`：以表格 +「Feature Details」支撑下游 **design** 输入。

完成后提示用户运行 `validate-prd` / `write-prd` 子命令链（见 `SKILL.md`）。
