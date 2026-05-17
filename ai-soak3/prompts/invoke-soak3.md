# ai-soak3 内置调用提示词（/ai-soak3）

> **用途**：用户输入 `/ai-soak3` 或等价触发（「无人值守压测」「soak agent」）时，Agent **必须先按本节执行**，再展开 `SKILL.md` 全文。  
> **规范**：编排细节见 `SKILL.md`；脚本行为见 `docs/spec/soak3.md`。

---

## 1. 项目路径（PROJECT_ROOT）

| 规则 | 说明 |
| --- | --- |
| **默认** | 使用**当前调用本 skill 时 Cursor 工作区根目录**的绝对路径作为 `PROJECT_ROOT`（即打开的业务项目仓，含 `inputs/req.md` 或 `.pipeline/` 的那一层） |
| **禁止** | 不得把 `~/.cursor/skills` 或任一 skill 安装目录当作 `PROJECT_ROOT` |
| **用户显式指定** | 若用户在消息中给出绝对/相对路径，以用户为准；相对路径相对于工作区根解析为绝对路径 |
| **校验** | 执行任何 `--project=` 脚本前，确认该目录下存在 `inputs/req.md` 或 `.pipeline/stages.json`；否则停下说明路径错误 |

后续所有命令中的 `<PROJECT_ROOT>` 均替换为上述绝对路径。

---

## 2. 环境（每轮 Round 开始前必须导出）

在**本 Agent 会话内**执行任何 soak 子步骤（ensure-req、prd3、autorun）之前，**先**探测 Agent 并写入 skill 目录 `config.env`，再加载到当前 shell：

```bash
# ① 探测 cursor-agent → ~/.cursor/skills/ai-soak3/config.env
node ~/.cursor/skills/ai-soak3/scripts/ensure-agent-env.cjs \
  --project=<PROJECT_ROOT>
echo "ensure-agent-env exit: $?"

# ② 加载（任选其一）
source ~/.cursor/skills/ai-soak3/scripts/load-soak-env.sh <PROJECT_ROOT>
# 或：eval "$(node ~/.cursor/skills/ai-soak3/scripts/ensure-agent-env.cjs --print-shell --project=<PROJECT_ROOT>)"
```

| 变量 | 要求 |
| --- | --- |
| `AI_SOAK3_STRICT=1` | **必须**（由 `ensure-agent-env` 写入）；禁止用「阶段已完成 + hash 未变」跳过 codegen / build / deploy / smoke / ui_e2e |
| `AI_CODE3_SKIP_AGENT` | **禁止设置**；`load-soak-env.sh` 会自动 `unset` |
| `AI_CODE3_AGENT_BIN` | **自动探测** `cursor-agent`（`~/.local/bin` 或 `command -v`）；写入 `config.env` 并 export |
| `AI_E2E3_AGENT_BIN` | 默认与 codegen 相同；`ui_e2e.enabled=true` 时须非空 |

`ensure-agent-env` 退出码 **3** = 未找到 Agent，须安装 Cursor Agent CLI 或手工编辑 skill 目录 `config.env` 后重试。

代理（外网命令前，已写入 `config.env`，见 `SKILL.md` §4.1）：`http_proxy` / `https_proxy` 默认 `http://127.0.0.1:1087`。

---

## 3. 本轮执行范围（固定顺序）

**禁止**在未完成上一步门闸时跳步；**禁止**只输出摘要而不跑命令。

```
Round N:
  ① ensure-agent-env.cjs + load-soak-env.sh  → 退出码须为 0
  ② ensure-req.cjs          → 退出码须为 0
  ③ ai-prd3 全链            → bootstrap → validate-prd →（若 requires_agent：raw-input-impact + 更新 prd-spec）→ apply-raw-input-config → write-prd → finalize-prd-review
  ④ ai-auto3 autorun        → design … → deploy_smoke → ui_e2e → report（须等 autorun 结束并读 exit code）
  ⑤ §6 部署与端验证 + §7   → 见 SKILL.md；未满足不得宣布 success
  ⑥ 失败 → §3.1 闭环 → Round N+1（同一会话）
```

**autorun 最低命令形态**（`AI_SOAK3_STRICT` 已由 autorun 读取；仍须在本 shell 已 `export`）：

```bash
node ~/.cursor/skills/ai-auto3/scripts/autorun.cjs \
  --project=<PROJECT_ROOT> \
  --from-stage=design \
  --to-stage=report
echo "autorun exit: $?"
```

---

## 4. 成功与停止（人话）

| 结果 | 条件 |
| --- | --- |
| **可宣布本轮成功** | `autorun` 退出码 **0**；最新 `autorun-*.md` 非 failed；`stages.codegen.outputs.agent.skipped` 不为 true；线上/本地抽检与 req、prd-spec 一致（含 App 名、smoke body 指纹等，见 `rfc-soak3-req-fidelity.md`） |
| **须继续 Round** | 任一门闸失败、strict 下 agent 被跳过、或 §7 未满足 |
| **可停等人工** | 仅 §3.4 不可解阻塞（须有命令输出证据） |

---

## 5. 用户极简触发语（可复制）

用户只发 `/ai-soak3` 时，等价于确认本节全部约束，**无需**再手写 `export` 或项目路径。

若用户附加说明，与本节冲突时以**更严格**者为准。
