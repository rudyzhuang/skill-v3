# ai-design3 内置调用提示词（默认编排）

> **用途**：用户触发 **ai-design3**（设计 / 契约 / design-review）时，编排 Agent **须先按本节执行**，再展开 `SKILL.md` 与子命令表。  
> **规范**：门闸与脚本行为见 `SKILL.md`、`docs/spec/design3.md`。

---

## 1. 项目路径（PROJECT_ROOT）

| 规则 | 说明 |
| --- | --- |
| **默认** | 当前 Cursor **业务项目**工作区根（含 `.pipeline/stages.json` 或 `docs/prd-spec.md`） |
| **禁止** | 不得把 `~/.cursor/skills` 或 skill 安装目录当作 `PROJECT_ROOT` |
| **CLI** | 所有命令：`node <skill_dir>/scripts/run.cjs <子命令> --project=<PROJECT_ROOT>` |

---

## 2. 环境变量（执行 design-review 链前必须导出）

在**本 Agent 会话**内，执行 **`validate-design-review`** / **`finalize-design-review`**（及前后 contract 链）之前，**先**导出：

```bash
export AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1
```

| 变量 | 要求 |
| --- | --- |
| `AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1` | **必须**（默认编排）：`validate-design-review` 对每个 feature 调外部 Agent 做语义对齐，并维护 `stages.design_review.features[]` |
| `AI_CODEGEN_AGENT_BIN` | 与 codegen 共用；未设置时脚本尝试 `cursor-agent` / `cursor agent` |
| `AI_DESIGN_DESIGN_REVIEW_SKIP_AGENT=1` | **仅 CI/smoke** 使用；与上项互斥 |
| `AI_DESIGN_DESIGN_REVIEW_USE_STUB=1` | smoke：不调 Agent，写 stub JSON |
| `AI_DESIGN_LIB_RESEARCH_USE_STUB=1` | smoke：lib-research 不调 Agent |

**CI / `node ai-design3/scripts/smoke.cjs`**：不得 export `AI_DESIGN_DESIGN_REVIEW_USE_AGENT`；改用 `AI_DESIGN_DESIGN_REVIEW_USE_STUB=1` 或依赖确定性校验 alone。

---

## 3. design-review 推荐顺序（不可跳步）

前置：`stages.contract` 已完成、`validation.passed=true`、`human_approval` 为 `approved` 或 `not_required`。

```bash
export AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1

node <skill_dir>/scripts/run.cjs validate-design-review --project=<PROJECT_ROOT>
node <skill_dir>/scripts/run.cjs write-design-review --project=<PROJECT_ROOT>
node <skill_dir>/scripts/run.cjs hash-design-review-inputs --project=<PROJECT_ROOT>
```

**或**（编排 Agent 已产出 JSON）：

```bash
node <skill_dir>/scripts/run.cjs finalize-design-review \
  --project=<PROJECT_ROOT> --json=<path/to/design-review-output.json>
```

（`finalize` 仍须在会话内已 `export AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1`，以便 `validate-design-review` 内逐 feature 调 Agent 与 `features[]` 状态一致；若仅合并 JSON、不调 Agent，可改用手动 `merge-design-review` + `validate` 且 **不** export 上项。）

语义评审细则见 [`design-review.md`](design-review.md)。

---

## 4. 完整三阶段（自 prd_review 通过后）

```bash
export AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1

# design
node <skill_dir>/scripts/run.cjs validate-design --project=<PROJECT_ROOT>
node <skill_dir>/scripts/run.cjs write-design --project=<PROJECT_ROOT>
# contract（含 approve / validate）
# design-review（§3）
```

---

## 5. 用户极简触发

用户只说「跑 ai-design3 / design-review」时，等价于确认本节 **`export AI_DESIGN_DESIGN_REVIEW_USE_AGENT=1`** 与 `PROJECT_ROOT` 规则，无需重复手写。
