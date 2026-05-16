---
name: ai-soak3
version: "0.2.0"
description: >-
  Skill V3 Unattended Soak Agent：在目标业务项目中无人值守地执行 ai-prd3 → ai-auto3
  全链路压测，直至项目完整实现（含服务端部署上线、mobile 编译安装到模拟器、测试全通过）。
  发现失败时优先评估并修复 v3 skill，不在业务仓打补丁糊弄。
  当用户说「ai-soak3」「无人值守压测」「soak agent」「按 agent-prompt 跑」时使用。
---

# ai-soak3（Skill V3 Unattended Soak Agent）

## 0. 规范真源（SSOT）

实现细节与脚本行为以 **`docs/spec/soak3.md`**（skill 仓内）为唯一规范来源；本 `SKILL.md` 保留编排与触发说明。

---

## 1. 最高优先级（覆盖一切含糊表述）

**目标是让项目真正跑通——不是让门闸通过就算完事。**

具体而言：
- 若项目有 **backend**：须完成云平台部署，生产/dev URL 可访问。
- 若项目有 **mobile**：须编译成功，安装到模拟器并冒烟通过。
- 若项目有 **website**：构建产物可访问。
- 遇到问题：**先评估是否可通过优化 v3 skill 解决**（见 §3.1）；可以就改 skill；不行才直接修业务代码；两条路都走不通才判定为不可解阻塞（见 §3.4）。

**在 §7 全满足之前，禁止把失败摘要当作任务结束。**

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
| **1** | req.md 不存在，已从模板创建 | **停下**，提示用户填写必填字段后重试：功能需求、云平台、主域名、鉴权信息 |
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
| 1 | **成功**：§7 全满足（含部署 + 端测试，连续 2 轮） | 输出 §9 最终证据包，结束 |
| 2 | **不可解阻塞**（见 §3.4） | 输出阻塞类型 + 具体错误 + 用户需做的唯一操作，等待人工介入 |
| 3 | **上下文/时长耗尽** | 输出续跑块（见 §3.3），等待用户新建会话续跑 |

**除以上三种，任何失败均不得结束对话——包括但不限于：**  
build 失败 / test 失败 / deploy 失败 / mobile 无法启动 / skill 门闸误杀 / autorun 超时 / 代码有 bug。

### 3.1 失败后强制动作链（同一会话内完成）

1. **取证**：读最新 `.pipeline/reports/autorun-*.md` 的完整结论段、`stages.json` 对应阶段、`.agent-sessions/<session>*.log`。禁止用 `head`/`tail` 截断。

2. **归因与 skill 评估**（按顺序）：
   - 若是 skill 脚本/编排/门闸问题 → 直接进入第 3 步（C）。
   - 若表面是业务代码/测试/配置问题：**先评估**：「优化对应 v3 skill（如 ai-auto3 / ai-code3 / ai-design3）能否防止此类失败？」
     - 可以优化 → 改 skill，走第 3 步。
     - 不能（纯业务逻辑）→ 直接在业务仓修复，走第 4 步。
     - 无论如何都无法自动解决 → 判断是否触发 §3.4，否则继续尝试。

3. **C（skill 改动）**：改 skill → 对应 skill 冒烟连续 **2 轮** → skill 仓 commit+push（§4.1 代理）。

4. **立即进入 Round N+1**：在**同一对话**中从 §4.A 重新执行。

**禁止行为**

- 输出 §8 摘要后等待用户，不执行 Round N+1。
- B/§6 失败后未做第 2 步归因就结束。
- skill 已 push 后未重跑 A→B 就结束。
- 对 `autorun` 使用 `| head`、`| tail`、`| less` 等截断管道。
- 后台启动 `autorun` 后不跟踪，直至 `autorun exit:` 或 `gen-report:` 才停止轮询。
- 以「不确定是否 skill 问题」为由提前结束。

### 3.2 「新建 agent」的真实含义

**默认不要**要求用户新开窗口；当前会话内连续 Round 直至 §7 或 §3 #2/#3。

### 3.3 续跑指令块（仅上下文耗尽时使用）

```text
继续 Skill V3 无人值守压测（ai-soak3）。PROJECT_ROOT=<绝对路径>。
从 Round <N+1> 的 §4.A 开始；
上一 Round 失败点：<一句话>；skill 已 push：<commit>；勿重复已完成的 C。
已完成阶段：prd=<状态> prd_review=<状态> design=<状态> codegen=<状态>。
```

### 3.4 不可解阻塞定义（允许停止等待人工介入的情况）

以下三种情况可判定为不可解阻塞，**但必须提供明确证据**：

| 类型 | 判定条件 | 要求 |
|------|---------|------|
| **云平台鉴权失败** | deploy 命令输出含明确的 401/403/权限拒绝错误，且凭证需用户手动更新 | 提供：具体错误截图或日志 + 用户需更新的 `config.env` 字段名 |
| **非 macOS / 无法编译 iOS** | `uname -s` ≠ `Darwin`，且 req.md 声明了 mobile 含 iOS 目标（`ios` 构建失败且错误为系统级） | 提供：`uname -s` 输出 + flutter 报错内容；Android 目标不受影响，可继续 |
| **AI 确认无法自动解决** | 经过至少 **2 次**不同修复尝试后，问题仍无法用 AI 修改代码/配置/skill 解决 | 提供：已尝试的方法列表 + 每次的失败输出 + 无法解决的原因说明 |

**不允许**用模糊表述（如「鉴权可能有问题」「可能需要人工介入」）宣布阻塞；必须有脚本/命令的明确错误输出作为证据。

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
   - feature 数量由 AI 根据 `inputs/req.md` 原始需求自动推理，无最低数量约束
   - 若 req.md 声明了 `mobile`：声明 mobile 端；功能范围与导航结构由 AI 根据 req.md 推理，不强制与 website 对齐
   - **`client_targets`** 覆盖 `inputs/req.md` 要求的所有端
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
export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087
bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh PROJECT_ROOT
```

**B 成功（须同时满足）**

- `autorun` 退出码 **0**
- 最新 `autorun-*.md` 无阻塞、`overall` 非 `failed`
- `stages.json` 关键阶段（含 build/smoke，若启用）`completed` 且 `validation.passed=true`
- 所有 `client_targets` 在 report/stages 中有明确通过记录

### C. 错误闭环（有失败则在本会话执行，不只填表）

| 字段 | 说明 |
|------|------|
| 失败点 | 命令 / 阶段 / 日志摘要 |
| 归因类型 | skill 缺陷 / 业务代码 / 配置缺失 / 不可解（见 §3.4） |
| skill 评估 | 优化 v3 skill 是否可解决？是/否及原因 |
| skill 改动 | 文件列表（若改了 skill） |
| 评审结果 | 冒烟 round-1 / round-2（若改了 skill） |
| 提交哈希 | skill 仓 push 后 commit（若改了 skill） |

**流程**：
- 改 skill → 冒烟 2 轮 → commit+push（§4.1 代理） → 立即 Round N+1
- 修业务代码 → 立即 Round N+1（无需 skill push）

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

## 6. 部署与端完整验证（每轮 B 之后执行）

此阶段不是「轻量确认」——须逐端验证**实际可用性**，失败按 §3.1 处理。

### 6.1 Backend（若 req.md 含 backend 端）

```bash
# 1. 检查 stages.json deploy 状态
# stages.deploy.status 须为 completed 或有合理跳过记录

# 2. 确认部署 URL 可达（外网须设代理 §4.1）
# 探活端点从 stages.json / config.dev.json / config.release.json 中读取；
# 若无明确配置则依次尝试 /health、/ping、/ 直到收到 2xx/3xx 响应
curl -i --max-time 10 <deploy_url>/<health_or_ping_path>
```

- deploy 成功：HTTP 2xx / 3xx，记录 URL + 状态码。
- `allow_destructive_deploy=false`（配置禁用 dev deploy）：记录「deploy 跳过（配置禁用）」，不算失败；但须记录跳过原因。
- deploy 失败且错误非鉴权：进入 §3.1，评估 skill 可否改进。
- deploy 失败且为明确鉴权错误：见 §3.4。

### 6.2 Admin / 其他 Web 端（若 req.md 含 admin 或其他 web 类端）

- build 产物存在（stages.build 对应该端 `completed`）。
- 若有 deploy：URL 可达（同 §6.1）。
- 若仅本地 dev server：`curl -I http://localhost:<port>` 返回 2xx。
- 验证逻辑与 website 相同；端口/路径从 stages.json 或 config 中读取，不硬编码。

### 6.3 Website（若 req.md 含 website 端）

- build 产物存在（stages.build 对应 website `completed`）。
- 若有 deploy：URL 可达（同 §6.1）。
- 若仅本地 dev server：`curl -I http://localhost:<port>` 返回 2xx。

### 6.4 Mobile（若 req.md 含 mobile 端）

当 **`ui_e2e.enabled=true`** 时，模拟器启动、安装与测试由 **ai-e2e3** `mobile-device.cjs` 在 `ui_e2e` 阶段自动完成（`auto_launch_emulator` / `auto_launch_simulator`、`flutter install`）；本节手工命令仅作复核或 `ui_e2e` 未启用时的回退。

**步骤一：确认 build 成功**

```bash
# stages.build 对应 mobile 须为 completed，或 report 中有 build success 记录
# 若 build 未完成，先触发：
cd <project>/src/mobile   # 或 auto3 编排指定路径
flutter build apk --debug  # Android；iOS: flutter build ios --simulator
echo "flutter build exit: $?"
```

**步骤二：确认运行环境**

```bash
uname -s          # Darwin = macOS；Linux/非macOS 无法编译 iOS
flutter doctor    # 检查环境完整性
flutter emulators # 列出可用模拟器
```

- 非 macOS 且需 iOS → 见 §3.4（不可解阻塞）。
- 无可用模拟器 → 尝试 `flutter emulators --launch <emulator_id>` 创建/启动；仍失败则记录为不可解阻塞。

**步骤三：安装并冒烟**

```bash
# 启动模拟器（若未运行）
flutter emulators --launch <emulator_id>
sleep 10  # 等待启动

# 运行 app（后台，冒烟确认启动不崩溃）
flutter run -d <emulator_id> 2>&1 &
RUN_PID=$!
sleep 30
kill $RUN_PID 2>/dev/null || true
echo "mobile smoke: done"

# 若项目有 integration_test：
# flutter test integration_test/ -d <emulator_id>
```

- app 启动不崩溃（非 zero exit 的 error 日志）→ mobile smoke: pass。
- 启动崩溃 → 读错误日志，按 §3.1 归因修复，继续 Round N+1。

---

## 7. 最终成功判定（全部满足才可结束）

1. **A**：prd + prd_review `passed`，`client_targets` 与 `inputs/req.md` 一致。
2. **B**：autorun 全链路成功，report 无阻塞，stages 与 report 一致。
3. **§6**：
   - Backend（若声明）：deploy URL 可访问，或有合理跳过记录（配置禁用）。
   - Website / Admin / 其他 web 端（若声明）：build 成功，URL/端口可访问。
   - Mobile（若声明）：编译成功 + 模拟器安装冒烟通过。
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
- client_targets：…
- 关键命令与退出码：…
### B ai-auto3
- 结果：pass / fail
- report 路径：…
- stages 摘要（design→report 关键阶段）：…
- 阻塞项（若有）：…
### C 错误闭环（若有）
| # | 失败点 | 归因类型 | skill 评估 | skill 改动 | 评审 r1/r2 | commit |
|---|--------|---------|-----------|-----------|-----------|--------|
### §6 部署与端完整验证
- backend deploy：pass / fail / skipped（URL、状态码）
- website：pass / fail（URL、状态码）
- admin / 其他 web 端：pass / fail / N/A（URL、状态码）
- mobile 编译：pass / fail
- mobile 模拟器安装+冒烟：pass / fail / blocked（§3.4 类型）
### 本轮结论
- 通过 / 失败 / blocked（§3.4 类型）
- 若失败且可继续：→ **正在执行 Round N+1**
```

---

## 9. 最终证据包（仅 §7 全满足时输出）

- 两轮 Round 编号与结果一致说明
- `inputs/req.md` 对齐说明（client_targets）
- ai-prd3 / ai-auto3 关键命令与退出码
- 最新 report 路径与 overall 结论
- `.pipeline/stages.json` 关键阶段快照（prd、prd_review、build、deploy、report）
- Backend deploy URL + HTTP 状态码
- Mobile 模拟器 ID + 冒烟结果
- skill 仓 commit hash（外网 git 前已按 §4.1 设代理）

---

## 10. 启动清单（第一步）

1. 设 `PROJECT_ROOT`（默认当前仓根目录）。
2. 运行 `ensure-req.cjs`（见 §2）；退出码 0 才继续。
3. 确认运行环境：`uname -s` 是否为 Darwin（macOS）；若 req.md 含 mobile iOS 且非 macOS → 提前标记（见 §3.4）。
4. 从 **§4.A** 开始执行；默认连续多 Round 直至 §7 或 §3 #2/#3。
5. **自检**：若你正准备发送的回复里只有失败总结、没有接下来的命令 → **禁止发送**，先按 §3.1 执行。

---

*规格变更请走 `docs/spec/soak3.md` 维护流程。*
