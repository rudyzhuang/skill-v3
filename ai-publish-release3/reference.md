# ai-publish-release3 — 参考与验收

## 退出码

与 `publish3.md` §9 一致；release 串联须标注 **`failed_step=deploy|smoke|release`**。

## `release_meta`（建议字段）

成功路径向 **`stages.deploy.outputs.release_meta`** additive 写入时，建议至少包含：`version`、`tag_name`、`changelog_path`、`gh_release_url`（可空）、`notes`、`released_at`、`error`（可空）（见 `publish3.md` §5.3）。

## 验收勾选项（摘自 `publish3.md` §11，release 相关）

- [ ] 独立目录 **`ai-publish-release3`**，无单一 `ai-publish3` 兼管 dev/release。
- [ ] 仅读 **`config.release.json`**；密钥只来自 **`docs/config.env`**。
- [ ] 未满足 **§5.2**（含 **`approval_required` + `--confirm-deploy`** 及 **`approval_required===false` 时仍须显式确认**）即尝试改 release 资源 → **1**。
- [ ] **`release_meta`** 成功路径写回（本仓库骨架为占位说明，实现待补）。
