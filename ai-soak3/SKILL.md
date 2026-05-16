---
name: ai-soak3
version: "0.1.0"
description: >-
  Skill V3 Unattended Soak Agent：在目标业务项目中无人值守地执行 ai-prd3 → ai-auto3
  全链路压测，发现失败时优先归因并修复 skill，持续迭代直至门闸全绿（连续 2 轮）。
  当用户说「ai-soak3」「无人值守压测」「soak agent」「按 agent-prompt 跑」时使用。
---

# ai-soak3（Skill V3 Unattended Soak Agent）

## 0. 规范真源（SSOT）

实现细节与脚本行为以 **`docs/spec/soak3.md`**（skill 仓内）为唯一规范来源；本 `SKILL.md` 保留编排与触发说明。

---

## 1. 最高优先级（覆盖一切含糊表述）

**在 §7 全部满足之前，禁止把「本轮失败摘要」当作任务结束。**  
你必须**继续执行**（修 skill → 重跑），不得只写报告、给「下一步建议」、或要求用户「新建 agent」后结束当前对话。

---

## 2. 前置：inputs/req.md 校验（每轮第一步）

**在执行任何 ai-prd3 命令之前**，先运行：

```bash
node ~/.cursor/skills/ai-soak3/scripts/ensure-req.cjs --project=<PROJECT_ROOT>
echo "ensure-req exit: $?"
```

| 退出码 | 含义 | 动作 |
|--------|------|------|
| **0** | req.md 存在且必填字段完整 | 继续 §4.A |
| **1** | req.md 不存在，已从模板创建 | **停下**，提示用户填写以下必填字段后重试：功能需求、云平台、主域名、鉴权信息 |
| **2** | req.md 存在但必填字段空缺 | **停下**，显示缺失字段列表，等用户补全后重试 |

**仅当退出码 0 时**，才允许继续。

**req.md 必填字段**（见模板 `docs/templates/req-template.md`）：

| 字段 | H2 标题 | 说明 |
|------|---------|------|
| 功能需求 | `## 功能需求` | 至少一条非空、非 TODO 描述 |
| 云平台 | `## 云平台` | 如 `Cloudflare`、`AWS` |
| 主域名 | `## 主域名` | 如 `notes.yunapp.com` |
| 鉴权信息 | `## 鉴权信息` | 凭证位置描述（**禁止**写真实密钥） |

---

## 3. 何时可以停下（仅三种情况）

| # | 条件 | 动作 |
|---|------|------|
| 1 | **§7 全满足**（含连续 2 轮 A→B→§6 全绿） | 输出 §9 最终证据包，结束 |
| 2 | **硬性人工阻塞**（缺凭证、无 `cursor-agent`、用户明确拒绝） | 输出阻塞清单 + 用户需做的唯一操作 |
| 3 | **上下文/时长耗尽** | 输出未完成项 + 可粘贴的续跑指令块（见 §3.3） |

**除以上三种外，任何 B/A/§6 失败均不得结束对话。**

### 3.1 失败后强制动作链（同一会话内完成）

1. **取证**：读最新 `.pipeline/reports/autorun-*.md`、`stages.json` 对应阶段、`.agent-sessions/<session>*.log`。禁止用 `head`/`tail` 截断报告结论段。
2. **归因**：优先 `~/.cursor/skills/` 中的 skill 缺陷，禁止在业务仓凑过关。
3. **C（错误闭环）**：改 skill → 该 skill 冒烟连续 **2 轮** → skill 仓 commit+push（§4.1 代理）。
4. **立即进入 Round N+1**：在**同一对话**中从 §4.A 重新执行（不是只写「请新建 agent」）。

**禁止行为（含历史教训）**

- 输出 §8 摘要后等待用户，不执行 Round N+1 命令。
- B 失败后未做 C 就结束。
- skill 已 push 后未重跑 A→B 就结束。
- 对 `autorun` 使用 `| head`、`| tail`、`| less` 或任何截断管道。
- 后台启动 `autorun` 后不轮询，直至 `autorun exit:` 或 `gen-report:` 出现就放任不管。

### 3.2 「新建 agent」的真实含义

**默认不要**要求用户新开窗口；当前会话内连续 Round 直至 §7 或 §3 #2/#3。

### 3.3 续跑指令块（仅上下文耗尽时使用）

```text
继续 Skill V3 无人值守压测（ai-soak3）。PROJECT_ROOT=<绝对路径>。
从 Round <N+1> 的 §4.A 开始；
上一 Round 失败点：<一句话>；skill 已 push：<commit>；勿重复已完成的 C。
```

---

## 4. 每轮流程

### 4.1 Shell 网络代理（外网命令前必做）

```bash
export http_proxy=http://127.0.0.1:1087; export https_proxy=http://127.0.0.1:1087;
```

凡访问外网（git、npm install、curl 非本机、deploy）均须先设置。本机 `127.0.0.1`/`localhost` 可不设。

### A. ai-prd3

1. 运行 `ensure-req.cjs`（见 §2），退出码 0 才继续。
2. 读 `~/.cursor/skills/ai-prd3/SKILL.md`；规范 SSOT：`ai-prd3/docs/spec/prd3.md`。
3. 维护 `docs/prd-spec.md`，满足：
   - **≥ 20 个** `feature`（在 prd-spec 与各端 `feature_list.md` 中一致）
   - 声明 **`mobile`**，与 **`website`** 对齐（同 `feature_id`、同导航）
   - **`client_targets`** 覆盖 `inputs/req.md` 要求的端
4. 顺序执行（`--project=PROJECT_ROOT`）：

```bash
export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087
node ~/.cursor/skills/ai-prd3/scripts/run.cjs bootstrap --project=PROJECT_ROOT [--force]
node ~/.cursor/skills/ai-prd3/scripts/run.cjs validate-prd --project=PROJECT_ROOT
node ~/.cursor/skills/ai-prd3/scripts/run.cjs write-prd --project=PROJECT_ROOT
node ~/.cursor/skills/ai-prd3/scripts/run.cjs finalize-prd-review --project=PROJECT_ROOT --json=<path> [--force]
```

**A 成功**：`stages.prd` + `stages.prd_review` 均 `completed`，`decision=passed`。

**Round N+1 时**：至少执行 `validate-prd`；按门闸状态决定是否 `--force`。

### B. ai-auto3

1. 读 `~/.cursor/skills/ai-auto3/SKILL.md`。
2. 以下命令**完整运行**，禁止管道截断（见 §3.1）：

```bash
export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087
node ~/.cursor/skills/ai-auto3/scripts/autorun.cjs --project=PROJECT_ROOT
echo "autorun exit: $?"
```

若需监控卡住风险，可用辅助脚本代替（见 §5）：

```bash
bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh PROJECT_ROOT
```

**B 成功（须同时满足）**

- `autorun` 退出码 **0**
- 最新 `autorun-*.md` 无阻塞、`overall` 非 `failed`
- `stages.json` 关键阶段（含 build/smoke，若启用）`completed` 且 `validation.passed=true`
- **website + mobile** 在 report/stages 中有明确通过记录

### C. 错误闭环（有失败则在本会话执行，不只填表）

| 字段 | 说明 |
|------|------|
| 失败点 | 命令 / 阶段 / 日志摘要 |
| 是否 skill 问题 | 门闸误杀、编排缺陷、脚本 bug → 是 |
| skill 改动 | 文件列表 |
| 评审结果 | 冒烟 round-1 / round-2 |
| 提交哈希 | skill 仓 push 后 commit |

**流程**：改 skill → 冒烟 2 轮 → commit+push（§4.1 代理）→ **立即**在同一对话从 §4.A 开始 Round N+1。

---

## 5. 辅助脚本

| 脚本 | 用途 | 命令 |
|------|------|------|
| `ensure-req.cjs` | 校验/生成 `inputs/req.md` | `node ~/.cursor/skills/ai-soak3/scripts/ensure-req.cjs --project=<P>` |
| `check-session-health.cjs` | 检测 codegen 会话是否卡住 | `node ~/.cursor/skills/ai-soak3/scripts/check-session-health.cjs --project=<P>` |
| `diagnose-run.cjs` | 全面诊断运行状态 | `node ~/.cursor/skills/ai-soak3/scripts/diagnose-run.cjs --project=<P>` |
| `start-and-monitor.sh` | 启动 autorun + 自动健康监控 | `bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh <P>` |

所有脚本通过 `--project=<业务项目根目录>` 接收业务项目路径，**不依赖 cwd**。

---

## 6. 本地可运行性（轻量确认）

auto3 已覆盖端到端时，仅做最小存活检查：

- 若 report 标明本地 URL/端口：对 **backend** / **website** 各做一次 HTTP 可达（`curl`）；公网 URL 前按 §4.1 设代理，本机可不设。
- 若 report 标明 mobile 构建成功：确认 `src/mobile`（或 stages/report 指定路径）存在且最近一次 build 无阻塞。
- 失败 → 记入 C，按 §3.1 处理（不得只记 fail 就结束）。

---

## 7. 最终成功判定（全部满足才可结束）

1. **A**：prd + prd_review `passed`，≥20 feature，含 mobile 派生，与 `inputs/req.md` 一致。
2. **B**：autorun 全链路成功，report 无阻塞，stages 与 report 一致。
3. **§6** 轻量确认通过（或与 report 结论一致）。
4. 以上**连续 2 轮**（A→B→§6，非只重跑 B）结果一致全绿。
5. 输出 **§9 最终证据包**。

**未满足任一条** → 按 §3.1 处理，不要结束对话。

---

## 8. 每轮输出模板（checkpoint，不是收工信号）

> 每完成一轮后**先**输出，然后：
> - §7 未满足且非 §3 #2/#3 → **同一回复内继续执行 Round N+1**，不要停住等用户。
> - §7 全满足 → 输出 §9 证据包。

```markdown
## Round N
### §2 req.md 校验
- 结果：pass / blocked（原因）
### A ai-prd3
- 结果：pass / fail
- feature 数 / client_targets：…
- 关键命令与退出码：…
### B ai-auto3
- 结果：pass / fail
- report 路径：…
- stages 摘要（design→report 关键阶段）：…
- 阻塞项（若有）：…
### C 错误闭环（若有）
| # | 失败点 | skill? | skill 改动 | 评审 r1/r2 | skill commit |
|---|--------|--------|------------|------------|--------------|
### §6 轻量确认
- backend/website 可达：pass / fail（URL、状态码）
- mobile 构建/路径：pass / fail
### 本轮结论
- 通过 / 失败
- 若失败且可继续：→ **正在执行 Round N+1**
```

---

## 9. 最终证据包（仅 §7 全满足时输出）

- 两轮 Round 摘要（编号、结果一致说明）
- `inputs/req.md` 对齐说明（feature 数、client_targets）
- ai-prd3 / ai-auto3 关键命令与退出码
- 最新 report 路径与 overall 结论
- `.pipeline/stages.json` 关键阶段快照（prd、prd_review、report）
- skill 仓 commit hash（外网 git 前已按 §4.1 设代理）

---

## 10. 启动清单（第一步）

1. 设 `PROJECT_ROOT`（默认当前仓根目录）。
2. 运行 `ensure-req.cjs`（见 §2）；退出码 0 才继续。
3. 从 **§4.A** 开始执行；默认连续多 Round 直至 §7 或 §3 #2/#3。
4. **自检**：若你正准备发送的回复里只有失败总结、没有接下来的命令 → **禁止发送**，先按 §3.1 执行。

---

*规格变更请走 `docs/spec/soak3.md` 维护流程。*
