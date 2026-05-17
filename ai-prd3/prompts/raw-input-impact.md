# 原始需求变更影响分析（raw-input → prd-spec / config / 分流重跑）

上游需求可以是 **Markdown 文件**（默认 `inputs/req.md`）或 **用户对话中粘贴的一段 Markdown**。

## 0. 四类分流（必须先做）

阅读 **`.pipeline/reports/raw-input-drift.json`** 后，将每条变更归入一类（详见 **`docs/spec/rfc-soak3-req-fidelity.md` §2.5**）：

| 代号 | 含义 | 你要做什么 |
| --- | --- | --- |
| **C** | 仅配置（域名、URL、smoke 路径等） | `apply-raw-input-config`；prd-spec 部署节同步；**不改**无关 feature 的 design/代码 |
| **O** | 正交新 feature（与既有实现无交叉） | prd-spec §6 **新增** feature 行 + 派生**新 id** 的 prd/feature_list；**不要**动无关 feature 的文件与 stages |
| **I** | 受影响既有 feature（须改旧 feature） | 更新该 **feature_id** 的 prd-spec 行与设计/契约；后续 **incremental** codegen + **双次增量评审 + 全量 feature 评审** |
| **N** | 全新 feature（须完整阶段链） | 同 **O** 的 prd 落盘；对该 id 从 **design** 起完整跑 pipeline |

**落盘铁律**

1. **业务能力** → **`docs/prd-spec.md` §6**（feature 表）+ 各端派生稿。  
2. **部署/环境配置** → **`docs/config.dev.json` / `config.release.json`** 对应区（`deploy` / `smoke` / `ui_e2e` 等）。  
3. **禁止**只改 config 不在 prd-spec 留 feature/约束说明。

在回复或 checkpoint 中输出表格：

```text
| req 条目 | 类型 C/O/I/N | feature_id(s) | 受影响既有 id | 仅 config 键 |
```

## 1. 探测命令

### 内联文字

```bash
node ai-prd3/scripts/run.cjs detect-raw-input \
  --project=<业务项目根绝对路径> \
  --raw-input-text='## 功能需求
...完整 Markdown...'
```

### 文件

```bash
node ai-prd3/scripts/run.cjs detect-raw-input --project=<root> --raw-input=inputs/req.md
```

## 2. 按 impact_hints category 处理

1. 执行 **`detect-raw-input`**，阅读 **`impact_hints`** 与 **`requires_agent` / `functional_requirements_changed`**。
2. 按 **§0 四类** 决定范围，再按 category 细化的动作：
   - **`domain`**：prd-spec 部署 URL + **`apply-raw-input-config`**（**C**）
   - **`client_targets`**：改 prd-spec 端列表；**仅**为新端 bootstrap 派生（**O/N**），**禁止** `--force` 覆盖无关端 `feature_list`（**O** 时）
   - **`features`**：改 prd-spec §6；**I** 只改命中 id；**O/N** 只增新行（**§1.5**）
3. `validate-prd` → `write-prd`（已完成则 `--force`）。
4. **`requires_agent: true`** 时 **禁止** 在未改 prd-spec 前 `finalize-prd-review`。

## 3. 与 ai-auto3 / ai-code3 的衔接

| 类型 | ai-auto3 | ai-code3 |
| --- | --- | --- |
| **O / N**（新 id） | `--feature=<新 id 列表>` 仅跑新 id | 新 id 可 greenfield |
| **I**（旧 id） | `--force-rerun-features=<I 列表>`，**不**含无关 id | **`incremental`**：在旧代码上改，**禁止**整包推翻 |
| **C** | 按需 `deploy,smoke`，**不**默认重跑 codegen | 不跑 codegen |

**I 类评审顺序**（规范，实现 backlog）：增量评审 ×2（仅 req 切片）→ 该 feature **全量 code-review** ×1。

## 4. 禁止

- 不得把真实密钥写入 `config.*.json`。
- 不得仅在 config 改域名而不同步 prd-spec。
- 不得因 req 新增而对**无关** `feature_id` 执行 `bootstrap --force` 或清空其 `stages.*.completed`。
- 不得对 **I** 类 feature 使用「删除 `src/` 后全量重生」式 codegen，除非全量评审记录不可增量原因。
