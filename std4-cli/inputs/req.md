# 项目需求说明

## 项目名称 *

Std4Cli

## 项目简介 *

面向桌面端的 **headless CLI**，封装 **ai-std4** 全量自动编排生产能力：在 macOS / Windows 上通过命令行无人值守拉取 [DashStd4](dash-std4) 服务端项目或本地新建项目，调用**项目内打包的** `ai-std4` 脚本完成 setup → report 全链路；并通过 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw.git) 与飞书机器人双向通信，实现远程观测与指令控制。

目标用户：在本地工作站长期运行 std4 生产流水线的开发者或集成方。

## 客户端目标 *

- **无** website / admin / mobile / 自建 backend 交付物。
- 交付物为 **跨平台桌面 CLI**（headless，无 GUI）：macOS（Apple Silicon / Intel）、Windows（x64）。
- **内置 ai-std4**：构建/发布时从 **GitHub 远程仓库**拉取 `ai-std4/` 目录（见下节「skill 来源与 vendor 拉取」），解压到 `vendor/ai-std4/` 并打入安装包；**不依赖**本机 `~/.cursor/skills`、本地 monorepo 路径或开发机上的 `CURSOR_SKILLS_ROOT` 外部安装。
- **内置流水线配置**：将本仓已填好的 **`inputs/config.env`**（Cursor、云平台、模型等）作为 CLI 内置资源（建议 `bundled/std4-config.env`），在调用 std4 前同步到业务项目的 `docs/config.env`（及必要时 `inputs/config.env`），供 `run-pipeline.cjs` 与各 stage 的 `loadProjectEnv` 使用。
- CLI 作为进程常驻运行（query 模式），通过子进程**直接调用项目内脚本**，例如：`node <cliRoot>/vendor/ai-std4/scripts/run-pipeline.cjs --project=<业务项目根>`；`CURSOR_SKILLS_ROOT` 在 spawn 时指向 `<cliRoot>`（使 skill 内相对路径解析到打包后的 `vendor/ai-std4`）。

## 核心功能 *

### 1. 运行环境与形态

1. 在**桌面端**运行，**headless**（无图形界面），支持 **macOS** 与 **Windows**。
2. 以单一可执行入口（如 `std4-cli` 或 `npx std4-cli`）提供子命令；Dash / 飞书等 **CLI 自有** 配置可放在 `~/.std4-cli/config.env`；**std4 流水线凭据**以内置 `bundled/std4-config.env` 为准（可由用户覆盖路径，但默认使用内置副本）。
3. 依赖本机已安装 **Node.js 18+**、**git**（构建阶段拉取 skill 仓库）及 `vendor/ai-std4` 内 **`npm install` 产物**；飞书集成时另需 feishu-cursor-claw 桥接能力。**不要求**用户机器预装 ai-std4 skill 或本地 skills 仓。

### 2. 命令行与两种工作模式

通过 CLI 子命令或 `--mode` 指定模式（默认 **query**）：

| 模式 | 说明 |
| --- | --- |
| **query** | 从 **DashStd4** 服务端 Open API（`GET /api/v1/projects` 等，见 dash-std4 需求）拉取**服务端新建、尚未被本机消费**的项目；对每个待处理项目在本地初始化业务仓目录并执行 **ai-std4 全量流水线**（`run-pipeline.cjs`）。 |
| **create** | 在本地按交互或参数收集 `inputs/req.md` 所需字段，创建新业务项目目录；对该新项目本地执行 **ai-std4 全量流水线**；可选将项目元数据通过 Open API 注册到 DashStd4（`POST /api/v1/projects`）。 |

**query 模式细则：**

- 轮询/拉取 DashStd4 上状态为「待开发 / 新增」的项目列表；拉取成功后在本机 `projects/`（或可配置根目录）下 materialize 项目（含 `inputs/req.md`、`.pipeline` 占位等），再 `run-pipeline`。
- **当没有待处理项目时**：以可配置间隔（心跳，默认可与 Dash 侧协商，如 30s～5min）定期请求服务端，直至有新项目；心跳期间仍保持进程存活，并继续飞书状态上报（见 §4）。
- 同一时刻默认**串行**处理一个项目流水线，避免多项目争抢本机 Cursor/API 配额；队列中的下一项目在当前项目 terminal stage（完成或失败退出）后再启动。

**create 模式细则：**

- 支持从模板生成 `inputs/req.md`（对齐打包内 `vendor/ai-std4/templates/req-template.md`）；流水线启动前由 CLI 将内置 `std4-config.env` 注入业务项目 `docs/config.env`。
- 本地流水线**正常结束**（report 阶段 completed）或**失败退出**后，CLI **自动切换并进入 query 模式**（无需人工重启进程），继续监听 DashStd4 新项目。

### 3. 与 ai-std4 的集成（内置 skill + 内置 config.env）

#### 3.1 skill 来源与 vendor 拉取（GitHub，非本机同步）

| 项 | 说明 |
| --- | --- |
| **当前源仓库** | [https://github.com/rudyzhuang/skill-v3.git](https://github.com/rudyzhuang/skill-v3.git)（与 ai-prd3、ai-auto3 等 **共用** 的 skill 合集仓） |
| **子目录** | 仅取用仓库内 **`ai-std4/`**（含 `scripts/`、`prompts/`、`schemas/`、`templates/`、`package.json` 等） |
| **落盘路径** | `vendor/ai-std4/`（构建产物，可不进 std4-cli 业务 git） |
| **版本钉扎** | 构建参数 `STD4_SKILL_REPO`、`STD4_SKILL_REF`（branch / tag / commit SHA，默认 `main` 或发版 tag） |

**构建步骤（`scripts/vendor-fetch` 或 CI，示意）：**

1. `git clone --depth 1 --branch <REF> <REPO> .vendor-src`（或对私有仓使用 token）。
2. 将 `.vendor-src/ai-std4/` 复制到 `vendor/ai-std4/`（或 `git sparse-checkout` 只拉 `ai-std4/`）。
3. 在 `vendor/ai-std4` 执行 `npm ci` / `npm install`。
4. 将 `inputs/config.env` 生成 `bundled/std4-config.env` 一并打入安装包。

**演进（后续拆仓）：** skill-v3 将拆出独立 **std4 专用仓库**，内含 **`ai-std4`**（流水线 skill）与 **`std4`**（本 CLI 或同级 CLI 包）。实现时通过环境变量切换拉取地址，例如 `STD4_SKILL_REPO` 从 `skill-v3.git` 改为新仓 URL，子路径仍为 `ai-std4/`（或新仓根目录即 ai-std4，以拆仓后布局为准）。req 与构建脚本须**集中配置仓库 URL**，避免硬编码多处。

#### 3.2 运行时调用与配置

1. **脚本路径（固定为项目内打包）**：`node <cliRoot>/vendor/ai-std4/scripts/run-pipeline.cjs --project=<本地项目根>`；同理调用 `run-dash.cjs`、`stop-pipeline.cjs`、各 `stages/*.cjs`。spawn 时注入 `CURSOR_SKILLS_ROOT=<cliRoot>`，确保 skill 解析到 `vendor/ai-std4`。
2. **配置注入**：每次启动流水线前，将内置 `bundled/std4-config.env`（源：`inputs/config.env`，含 `CURSOR_API_KEY`、`PIPELINE_MODEL`、`CLOUD_PROVIDER`、Cloudflare 等）**复制或合并**到目标业务项目的 `docs/config.env`（若不存在则创建；与 ai-std4 setup 同步规则一致），使各 stage 的 `loadProjectEnv` 无需用户手工配置即可运行。
3. 监听各 stage 状态（读取业务项目 `.pipeline/stages.json` 或解析 stage 日志），将阶段名、status（started/completed/failed/skipped）、阻塞摘要、最近错误同步到 DashStd4（`PUT /api/v1/projects/:id/pipeline`，见 dash-std4 `BACKEND-API-PIPELINE-001`）。
4. **CLI 侧环境变量**：Dash 相关 `DASH_STD4_API_BASE_URL`、`DASH_STD4_API_KEY`（Bearer / API Key）由 CLI 进程持有；**std4 侧** `CURSOR_API_KEY`、`PIPELINE_MODEL`、云平台 token 等来自内置 `std4-config.env`，经复制注入业务项目后由 ai-std4 读取。

### 4. 飞书双向通信（feishu-cursor-claw）

CLI 启动后集成 **[feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw.git)**（可 vendoring 子模块、sidecar 进程或库级调用，以实现为准），实现与飞书机器人的**双向**通信：

**CLI → 飞书（上报）：**

- 执行 std4 时，按 stage 推送**阶段完成 / 失败**卡片或文本（含项目 id、stage 名、耗时、错误摘要）。
- **定时心跳**上报运行状态：当前模式（query/create）、是否在跑流水线、当前项目、最近心跳时间、Dash 拉取结果摘要等。
- 支持 `/status` 类查询时返回 CLI 聚合状态（可与 feishu-cursor-claw 现有指令扩展共存）。

**飞书 → CLI（遥控）：**

- 飞书机器人可向 CLI 下发指令，由 CLI 解析并执行，例如：`/std4 status`、`/std4 stop`（停止当前流水线）、`/std4 mode query|create`、`/std4 run <projectId>`（对指定项目触发或续跑）、`/std4 logs`（最近日志 tail）等；具体指令表在实现阶段与 feishu-cursor-claw 的 bridge 协议对齐。
- 敏感操作（更换 API Key、强制删除项目目录）仅允许私聊或白名单用户。

### 5. 配置与可观测性

1. **CLI 配置**（如 `~/.std4-cli/config.env`）：`DASH_STD4_API_BASE_URL`、`DASH_STD4_API_KEY`、`PROJECTS_ROOT`、`QUERY_POLL_INTERVAL_SEC`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET` 等。
2. **构建期 vendor 配置**（CI / `scripts/vendor-fetch`）：`STD4_SKILL_REPO`（默认 `https://github.com/rudyzhuang/skill-v3.git`）、`STD4_SKILL_REF`（branch/tag/commit）、`STD4_SKILL_SUBDIR`（默认 `ai-std4`）；拆仓后改为新 std4 仓库 URL。
3. **内置 std4 配置**（`bundled/std4-config.env`，构建自 `inputs/config.env`）：`CURSOR_API_KEY`、`PIPELINE_MODEL`、`CLOUD_PROVIDER`、各云平台 token 等；由 CLI 在跑流水线时写入业务项目 `docs/config.env`，**不**要求业务项目自带完整 config.env。
4. 本地结构化日志（stdout + 滚动文件）；退出码约定：0 正常、非 0 可区分配置错误 / API 错误 / 流水线失败。
5. CLI 版本号与 `--help` 文档；`create` 模式支持 `--non-interactive` 传入 req 字段 JSON/YAML 路径。

## 非功能需求

- **可靠性**：Dash API 或网络短暂失败时指数退避重试；飞书发送失败不阻塞流水线主路径（异步队列 + 重试）。
- **安全**：API Key、飞书 Secret、Cursor Key 不得写入日志或上报载荷；含密钥的 `inputs/config.env` / `bundled/std4-config.env` **不进 git**（构建时由 CI 或本地加密注入）；分发安装包时对内置 config 做权限限制（仅当前用户可读）。
- **资源**：单项目流水线占用符合 ai-std4 既有约束；query 空闲心跳时 CPU/内存占用可忽略级。
- **可移植性**：macOS / Windows 路径、换行、子进程 spawn 行为一致；不依赖 macOS 专属 launchd（Windows 可用任务计划或前台常驻）。

## 部署与域名要求 *

### 主域名 *

不适用（桌面 CLI，无公网托管域名）。

### 各端域名 *

- **DashStd4 服务端**（只读/读写 API）：由 dash-std4 项目部署，例如 `https://api.dash.ai-ww.com`（dev/release 以 dash-std4 `inputs/req.md` 为准）。
- **CLI 分发**：GitHub Releases 或 npm 包；无独立 DOMAIN。

## 鉴权方案 *

- **DashStd4 Open API**：`Authorization: Bearer <DASH_STD4_API_KEY>`（与 dash-std4 `BACKEND-API-QUERY-001` / `BACKEND-API-PIPELINE-001` 一致）。
- **ai-std4**：`CURSOR_API_KEY`（Cursor Agent）。
- **飞书**：企业自建应用 App ID + App Secret（feishu-cursor-claw WebSocket 长连接模式，无需公网回调 URL）。

## 技术约束

- 实现语言建议：**TypeScript**（Node.js 18+），便于编排子进程与 feishu-cursor-claw 生态。
- **ai-std4 以 vendor 方式内置**：构建时从 **GitHub `rudyzhuang/skill-v3`**（路径 `ai-std4/`）拉取，**禁止**依赖本机 `~/.cursor/skills` 或相对路径 `../ai-std4` 同步；须调用其 `scripts/*.cjs`，不 fork 流水线逻辑。拆仓后仅改 `STD4_SKILL_REPO` 等配置指向新 std4 仓库。
- **内置 config**：`inputs/config.env` 为运维源文件；发布前生成 `bundled/std4-config.env` 并打入安装包。
- feishu-cursor-claw 以**依赖或子进程**方式集成，避免重复实现飞书 WebSocket 协议；扩展点集中在「将 std4 事件映射为飞书消息」与「将飞书指令路由到 CLI 命令处理器」。
- 打包：macOS / Windows 安装包须包含 `vendor/ai-std4/`（含 node_modules）与 `bundled/std4-config.env`；可选用预编译 CLI 外壳 + 资源目录布局。

## 其他说明

- **MVP 范围**：query + create 双模式、Dash API 拉取/上报、单项目串行 `run-pipeline`、飞书阶段上报与基础遥控指令；高级能力（多机协调、项目优先级队列）可后续迭代。
- **关联项目**：业务编排服务端 dash-std4；流水线 skill **远程源** [skill-v3](https://github.com/rudyzhuang/skill-v3.git) 内 `ai-std4/`（构建写入 `vendor/ai-std4`）；飞书桥 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw.git)。
- **仓库演进**：当前 skill 与 V3 其他 skill 同仓；计划独立 **std4 仓库**（含 `ai-std4` + `std4` CLI），本需求中的 vendor 拉取 URL 可切换，CLI 包名/目录与拆仓后的 `std4` 对齐。
- 本仓（std4-cli）实现阶段可用本地 ai-std4 调试，但**发布物**必须以 GitHub vendor 拉取结果为准；完成后可 dogfood 跑自身流水线。
