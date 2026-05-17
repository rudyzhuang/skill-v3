# ai-std3 内置调用提示词（/ai-std3）

> 用户输入 `/ai-std3` 或「标准流水线」「ai-std3」时，**先完整阅读并执行本文件**，再展开 `SKILL.md`。

---

## 1. PROJECT_ROOT

| 规则 | 说明 |
| --- | --- |
| **默认** | 当前 Cursor 工作区根目录的绝对路径 |
| **禁止** | 不得把 `~/.cursor/skills` 当作 PROJECT_ROOT |
| **校验** | 执行脚本前确认该目录已存在或将被创建（会生成 `inputs/`） |

---

## 2. 代理设置（访问外网前必做）

```bash
export http_proxy=http://127.0.0.1:1087
export https_proxy=http://127.0.0.1:1087
```

凡访问外网（git、npm、curl 非本机、deploy）均须先设置。

---

## 3. 本轮顺序

### 步骤一：初始化 inputs/

```bash
node ~/.cursor/skills/ai-std3/scripts/setup-inputs.cjs --project=<PROJECT_ROOT>
```

| 退出码 | 含义 | 动作 |
| --- | --- | --- |
| **0** | 模板已存在或已复制 | 继续步骤二 |
| **1** | 脚本错误 | 检查 skill 安装 |

### 步骤二：校验 inputs/req.md 与 inputs/config.env

```bash
node ~/.cursor/skills/ai-std3/scripts/verify-req.cjs --project=<PROJECT_ROOT>
```

| 退出码 | 含义 | 动作 |
| --- | --- | --- |
| **0** | 校验通过 | 继续步骤三 |
| **2** | 字段缺失 | **停下**，提示用户填写必填字段后重试 |

**req.md 必填字段**（带 `*` 的 H2 节）：

| 字段 | H2 标题 |
| --- | --- |
| 项目中文名称 | `## 项目中文名称 *` |
| 项目英文名称 | `## 项目英文名称 *` |
| 功能需求 | `## 功能需求 *` |
| App 要求 | `## App 要求 *` |
| 部署要求 | `## 部署要求 *` |
| 主域名 | `## 主域名 *` |
| 云平台 | `## 云平台 *` |

**config.env 必填**：`CLOUD_PROVIDER` 非空，且对应云平台的认证密钥非空。

**仅当退出码 0 时**，才允许继续。

### 步骤三：运行完整流水线

```bash
node ~/.cursor/skills/ai-std3/scripts/run-pipeline.cjs --project=<PROJECT_ROOT>
```

---

## 4. 流水线 Agent 卡点处理

流水线遇到退出码 **4** 时，说明某个 AI-driven stage 需要 Agent 产出内容：

| stage | Agent 需产出 | 产出后重跑 |
| --- | --- | --- |
| `prd` | `docs/prd-spec.md` + 各端 `prd.md`、`feature_list.md`、`docs/config.dev.json` | `--from-stage=prd` |
| `prd-review` | `prd-review-auto.json`（项目根） | `--from-stage=prd-review` |
| `design` | 每个 feature 的 `docs/designs/<feature_id>.design.json` | `--from-stage=design` |
| `design-review` | `design-review-auto.json`（项目根） | `--from-stage=design-review` |
| `create-ui-scenarios` | 各 feature 的 `docs/ui-scenarios/<feature_id>.scenarios.yaml` | `--from-stage=create-ui-scenarios` |
| `codegen` | worktree 内代码（由 Agent + cursor-agent 完成） | `--from-stage=codegen` |
| `code-review` | `code-review-auto.json`（项目根） | `--from-stage=code-review` |

---

## 5. 成功判定

流水线退出码 **0** 且最新 `.pipeline/reports/autorun-*.md` 显示 `overall: success`。

---

## 6. 启动清单（第一步）

1. 读本文件（已完成）。
2. 读 `~/.cursor/skills/ai-std3/SKILL.md`（如需了解目录结构）。
3. 设置代理（步骤二）。
4. 执行步骤一 → 步骤二 → 步骤三。
5. 遇到退出码 4 → 按第 4 节处理，产出后续跑。
