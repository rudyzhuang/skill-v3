# PRD 规格说明

<!-- 由 Agent-A 根据 inputs/req.md 增量补全，人工可直接编辑 -->

## 项目概述

**Std4Cli** 是面向桌面端的 **headless CLI**，封装 **ai-std4** 全量自动编排生产能力：在 macOS / Windows 上通过命令行无人值守拉取 [DashStd4](dash-std4) 服务端项目或本地新建项目，调用**项目内打包的** `ai-std4` 脚本完成 setup → report 全链路；并通过 [feishu-cursor-claw](https://github.com/nongjun/feishu-cursor-claw.git) 与飞书机器人双向通信，实现远程观测与指令控制。  
目标用户：在本地工作站长期运行 std4 生产流水线的开发者或集成方。核心价值是将 ai-std4、流水线配置与飞书桥统一打包为可分发 CLI，**不依赖**本机 `~/.cursor/skills` 或开发机上的外部 skill 安装路径。

## 客户端目标

- `cli` — 跨平台桌面 headless CLI（macOS / Windows，单一可执行入口与子命令）
- `dash` — DashStd4 Open API 对接（query/create 项目拉取与流水线状态上报）
- `feishu` — feishu-cursor-claw 桥接集成（sidecar 安装、启动与双向指令）

## 核心功能

| feature_id | 功能名称 | 优先级 | 阶段 | 涉及端 |
| --- | --- | --- | --- | --- |
| CLI-MODE-QUERY-001 | Query 模式：轮询 DashStd4 待开发项目、本地 materialize 并串行执行 ai-std4 全量流水线；空闲心跳保活 | P0 | mvp | cli, dash |
| CLI-MODE-CREATE-001 | Create 模式：交互或参数生成业务项目（含 req），可选 POST 注册 Dash；完成后自动切入 Query | P0 | mvp | cli, dash |
| CLI-VENDOR-STD4-001 | 构建期从 GitHub 拉取 `ai-std4/` 至 `vendor/ai-std4/`、`npm install` 并入包；运行时 `CURSOR_SKILLS_ROOT` 指向 CLI 根并 spawn `run-pipeline.cjs` 等 | P0 | mvp | cli |
| CLI-CONFIG-INJECT-001 | 将内置 `bundled/std4-config.env` 同步至业务项目 `docs/config.env`（及必要时 `inputs/config.env`），供各 stage `loadProjectEnv` | P0 | mvp | cli |
| CLI-DASH-PIPELINE-001 | 监听 `.pipeline/stages.json` 或日志，向 Dash 上报 stage 状态（与 dash-std4 流水线 API 对齐） | P0 | mvp | cli, dash |
| FEISHU-BIDIR-001 | 集成 feishu-cursor-claw：安装向导/setup、拉起 `bun run server.ts`；流水线阶段与心跳上报飞书，解析飞书遥控指令（status/stop/mode 等） | P0 | mvp | cli, feishu |
| CLI-OBS-LOG-001 | 本地结构化日志（stdout + 滚动文件）、退出码约定、`--help` 与版本信息；`create` 支持 `--non-interactive` | P1 | mvp | cli |
| CLI-RETRY-NFR-001 | Dash API 指数退避重试；飞书发送异步队列不阻塞主路径 | P1 | standard | cli, dash, feishu |

## 鉴权方案

- **DashStd4 Open API**：`Authorization: Bearer <DASH_STD4_API_KEY>`（与 dash-std4 查询/流水线接口约定一致）；密钥由 CLI 进程持有（如 `~/.std4-cli/config.env`），**禁止**写入日志或上报明文。
- **ai-std4 / Cursor**：业务侧读取注入后的 `docs/config.env` 中的 `CURSOR_API_KEY` 等；内置副本来自构建期 `inputs/config.env` 生成的 `bundled/std4-config.env`。
- **飞书**：企业自建应用 App ID + App Secret，经 feishu-cursor-claw WebSocket 长连接；安装时将模板复制为 `<installRoot>/feishu-cursor-claw/.env`，**勿提交仓库**。

## 部署架构

- **本交付物**：桌面 CLI，无独立公网托管主域名；分发渠道为 **GitHub Releases** 或 **npm** 包。
- **DashStd4**：服务端由 dash-std4 项目部署（API Base URL 以该项目配置为准，例如 dev/release 环境下的 `https://api…`）。
- **飞书桥**：`<installRoot>/feishu-cursor-claw` + 同级 `projects.json`；可由 CLI 守护或用户自带进程管理。
- **内置资源**：安装包含 `vendor/ai-std4/`（含依赖产物）、`bundled/std4-config.env`；可选预编译外壳 + 资源目录布局。

## 非功能需求

- **可靠性**：Dash API 或网络短暂失败时指数退避重试；飞书发送失败不阻塞流水线主路径（异步队列 + 重试）。
- **安全**：API Key、飞书 Secret、Cursor Key 不得写入日志或上报载荷；`inputs/config.env`、`inputs/.env`、`bundled/std4-config.env` **不进 git**（仅 `.env.example` 或安装复制）；安装包对内置 config 做权限限制（仅当前用户可读）。
- **资源**：单项目流水线占用遵循 ai-std4 既有约束；Query 空闲心跳时 CPU/内存可忽略级。
- **可移植性**：macOS / Windows 路径、换行、子进程 spawn 行为一致；不依赖 macOS 专属 launchd（Windows 可用任务计划或前台常驻）。

## 技术约束

- 实现语言建议：**TypeScript**（**Node.js 18+**），便于编排子进程与 feishu-cursor-claw 生态。
- **ai-std4 以 vendor 内置**：构建从 GitHub（默认 `rudyzhuang/skill-v3` 子路径 `ai-std4/`）拉取，**禁止**依赖本机 `~/.cursor/skills` 或相对路径同步；拆仓后通过 `STD4_SKILL_REPO` / `STD4_SKILL_REF` / `STD4_SKILL_SUBDIR` 切换。
- **内置 config**：`inputs/config.env` 为运维源；发布生成 `bundled/std4-config.env` 打入安装包。
- feishu-cursor-claw 以 **sidecar 子进程** 集成，避免重复实现飞书 WebSocket。
- **Cursor Agent CLI**：安装流程须按 OS/架构选择对应构建（与 Cursor 官方下载页一致）。
- 依赖本机：**git**、**Bun**（飞书桥）、**Cursor Agent CLI**（`agent`）；不要求用户预装 ai-std4 skill。

## 分期计划

- **mvp**：Query + Create 双模式；Dash API 拉取/上报；单项目串行 `run-pipeline`；vendor 内置 ai-std4 与 config 注入；飞书阶段上报与基础遥控指令；本地日志与退出码。
- **standard**：setup-feishu 向导深化；Retry/NFR 强化；生产环境守护（launchd / Windows 任务计划等）与 claw `service.sh` 协同文档化。
- **future**：多机协调、项目优先级队列等高级能力（req 所述后续迭代）。
