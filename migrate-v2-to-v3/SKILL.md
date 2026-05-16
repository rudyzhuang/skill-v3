---
name: migrate-v2-to-v3
description: >-
  Skill V3 配套：将业务项目从第二代（ai-*2）流水线产物与 SQLite 状态，一次性迁移到第三代契约（docs/config.*、.pipeline/stages.json 等）。
  默认 dry-run，需 --commit 才写盘；依赖 docs/input-spec.md §9.3 与 skill-v3 的 docs/templates。
  在用户提到 migrate-v2-to-v3、V2 迁 V3、老项目迁移、deployment_plan 或 pipeline.db 迁移时使用。
disable-model-invocation: true
---

# migrate-v2-to-v3（V2 → V3 一次性迁移）

## 规范真源

迁移字段、顺序与红线以 **`docs/input-spec.md` §9.3、§9.3.4** 为准；本 skill **不**替代各 **ai-*3** 的日常阶段脚本。

## 与其它目录的关系

| 路径 | 说明 |
| --- | --- |
| **`migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs`** | 唯一可执行入口（Node 内置模块 + `sqlite3` CLI，**无需** `npm install`）。 |
| **skill-v3 仓库根** | 默认 **`--templates-root`** 解析为含 **`docs/templates/`** 的 skill-v3 根；若你只拷贝了本 skill 子目录，必须显式传入 **`--templates-root=/path/to/skill-v3`**。 |

本 skill 与 **`ai-*3`** 平级放在 skill-v3 仓库根下；安装到 Cursor 时同样可链到 **`~/.cursor/skills/migrate-v2-to-v3/`**（与 README 中其它 skill 相同做法）。

## 触发词

「**migrate-v2-to-v3**」「**V2 迁 V3**」「**老项目迁移**」「**pipeline.db / deployment_plan 迁到 v3**」。

## CLI（在 skill-v3 仓库根示例）

```bash
node migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs --project=<业务项目根绝对路径>
node migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs --project=<业务项目根绝对路径> --commit
```

全局安装后（`~/.cursor/skills/migrate-v2-to-v3/` 为指向本仓的符号链接）：

```bash
node ~/.cursor/skills/migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs --project=<业务项目根绝对路径>
```

常用选项（完整列表见脚本文件头注释）：

| 选项 | 含义 |
| --- | --- |
| **`--project=`** | 业务仓库根（必填）。 |
| **`--commit`** | 落盘；省略则 **dry-run**。 |
| **`--templates-root=`** | skill-v3 根（含 `docs/templates`）；默认由脚本位置自动推断。 |
| **`--db=`** | v2 SQLite（如 `pipeline.db`）路径。 |
| **`--non-interactive`** + **`--answers-json=`** | CI / 无人值守时的结构化答案。 |

## 前置条件

- **Node.js** 可执行（与 skill-v3 其它脚本同阶，建议 ≥ 18）。
- 读取 v2 **SQLite** 状态表时，需本机可调用 **`sqlite3`** 命令行（见脚本内 `spawnSync` / `execFileSync` 逻辑）。
- 模板与 v0 契约文件来自 **skill-v3** 的 **`docs/templates/`**。

## 覆盖范围与限制

以 **`migrate-v2-to-v3.cjs` 文件头「当前脚本覆盖范围」** 为准；**未**覆盖的表或字段须按 **`input-spec.md` §9.3.2** 手工或扩展脚本处理。

迁移后仍建议用 **ai-prd3** 等对 **`prd-spec` / `stages.json`** 做校验与补全业务内容。

## 参考

- **[SPEC.md](SPEC.md)** → `docs/input-spec.md` §9.3
