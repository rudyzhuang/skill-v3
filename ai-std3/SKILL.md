---
name: ai-std3
version: "0.1.0"
description: >-
  Skill V3 独立全量流水线：自包含实现 setup → prd → prd-review → design →
  design-review → create-ui-scenarios → codegen → code-review → merge_push →
  build → deploy → ui_e2e → report。
  不依赖 ai-prd3 / ai-auto3 / ai-design3 / ai-code3 / ai-publish-dev3 脚本。
  在用户提到 ai-std3、/ai-std3、标准流水线、std3 或 run-pipeline 时使用。
---

# ai-std3（Skill V3 独立全量流水线）

## 0. 规范真源（SSOT）

实现细节与脚本行为以 **`docs/spec/std3.md`**（skill 仓内）为唯一规范来源；本 `SKILL.md` 保留编排与触发说明。

### 0.1 内置调用提示词（`/ai-std3` 必读）

用户输入 **`/ai-std3`** 或等价触发时，**第一步完整阅读并执行**：

**`ai-std3/prompts/invoke-std3.md`**

---

## 1. 架构定位

ai-std3 是一个**独立的全量流水线 Skill**，自行实现所有 stage 脚本，不 spawn 其它 skill 的 `run.cjs`。

**阶段链（固定顺序）**：

```
setup → prd → prd-review → design → design-review → create-ui-scenarios
  → codegen → code-review → merge_push → build → deploy → ui_e2e → report
```

**与 ai-soak3 的差异**：

| 维度 | ai-soak3 | ai-std3 |
| --- | --- | --- |
| 依赖 | 调用 ai-prd3、ai-auto3 等 | 自包含，不依赖其它 skill 脚本 |
| 目的 | 压测 V3 skill 链路 | 独立完整流水线实现 |
| contract 五件套 | 要 | 不要（设计文件直接派生） |
| typecheck / test 独立 stage | 要 | 不要（合并入 codegen Agent） |

---

## 2. 目录结构

```
ai-std3/
├── SKILL.md                         本文件
├── prompts/
│   ├── invoke-std3.md               /ai-std3 触发时必读
│   ├── prd-spec-author.md           prd stage Agent 提示
│   ├── prd-review.md                prd-review stage Agent 提示
│   ├── design-spec.md               design stage Agent 提示
│   ├── design-review.md             design-review stage Agent 提示
│   ├── create-ui-scenarios.md       create-ui-scenarios Agent 提示
│   ├── codegen-impl.md              codegen Agent 提示
│   ├── code-review-agent.md         code-review Agent 提示
│   ├── ui-e2e-agent.md              ui_e2e MCP 执行 Agent 提示
│   └── ui-e2e-analyze.md            ui_e2e 失败 triage Agent 提示
├── docs/
│   └── templates/
│       ├── req-template.md          inputs/req.md 模板
│       └── config.env.template      inputs/config.env 模板
└── scripts/
    ├── setup-inputs.cjs             初始化 inputs/
    ├── verify-req.cjs               校验 inputs/req.md + config.env
    ├── sync-config-env.cjs          同步 inputs/config.env → docs/config.env
    ├── run-pipeline.cjs             主编排入口
    └── lib/
        ├── stages-io.cjs            stages.json 读写工具
        ├── prd.cjs                  prd stage
        ├── prd-review.cjs           prd-review stage
        ├── design.cjs               design stage
        ├── design-review.cjs        design-review stage
        ├── create-ui-scenarios.cjs  UI 场景生成 stage
        ├── codegen.cjs              codegen stage
        ├── code-review.cjs          code-review stage
        ├── merge-push.cjs           merge_push stage
        ├── build.cjs                build stage
        ├── deploy.cjs               deploy stage
        ├── run-http-smoke.cjs       各 stage 末尾 HTTP smoke 子步骤
        ├── ui-e2e.cjs               ui_e2e stage
        └── report.cjs               report stage
```

---

## 3. 快速启动

```bash
# 1. 初始化业务项目 inputs/
node ~/.cursor/skills/ai-std3/scripts/setup-inputs.cjs --project=<业务项目根>

# 2. 校验填写结果
node ~/.cursor/skills/ai-std3/scripts/verify-req.cjs --project=<业务项目根>

# 3. 运行完整流水线
node ~/.cursor/skills/ai-std3/scripts/run-pipeline.cjs --project=<业务项目根>

# 4. 从某个 stage 续跑
node ~/.cursor/skills/ai-std3/scripts/run-pipeline.cjs --project=<业务项目根> --from-stage=design

# 5. 强制重跑某个 stage
node ~/.cursor/skills/ai-std3/scripts/run-pipeline.cjs --project=<业务项目根> --force-rerun=codegen
```

---

## 4. 退出码约定

| 退出码 | 含义 |
| ---: | --- |
| **0** | 成功 |
| **1** | 前置/参数/脚本错误 |
| **2** | 用户中断或门闸需人工填写 |
| **3** | 超时 |
| **4** | 需 Agent 介入（缺少 JSON / prd-spec / design.json 等）|
| **7** | git push 失败（merge_push 专用） |

---

*规格变更请走 `docs/spec/std3.md` 维护流程。*
