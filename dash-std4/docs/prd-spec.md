# PRD 规格说明

<!-- 由 Agent-A 根据 inputs/req.md 增量补全，人工可直接编辑 -->

## 项目概述

**DashStd4** 是面向 ai-std4 流水线开发与验收的轻量示例项目。通过管理后台与 REST API，为业务项目提供项目登记、流水线状态只读看板，以及供 ai-std4 集成方使用的项目查询与流水线上报能力，便于在本地或 Cloudflare 环境调试 std4 全链路。

**目标用户**：使用 ai-std4 的开发者与流水线集成方；系统管理员负责账号与项目建档。

**核心价值**：集中查看各业务项目 `.pipeline/stages.json` 中的阶段状态、阻塞项与最近日志摘要，并支持按 `inputs/req.md` 规范创建新项目以启动 std4 流水线。

## 客户端目标

- admin
- backend

## 核心功能

| feature_id | 功能名称 | 优先级 | 阶段 | 涉及端 |
| --- | --- | --- | --- | --- |
| AUTH-LOGIN-001 | 管理员登录与会话 | P0 | mvp | admin, backend |
| AUTH-USER-001 | 用户管理（管理员创建账号） | P0 | mvp | admin, backend |
| PROJECT-LIST-001 | 项目列表与状态 | P0 | mvp | admin, backend |
| PROJECT-DASH-001 | 项目流水线看板 | P0 | mvp | admin, backend |
| PROJECT-CREATE-001 | 新建项目（req 表单字段） | P0 | mvp | admin, backend |
| BACKEND-API-QUERY-001 | 项目查询 Open API | P0 | mvp | backend |
| BACKEND-API-PIPELINE-001 | 流水线运行数据上报 API | P0 | mvp | backend |

### 功能说明（摘录）

- **AUTH-LOGIN-001**：管理端需登录后访问；支持默认管理员账号（凭据仅配置于 `inputs/config.env` / `docs/config.env`，禁止写入本文档）及管理员创建的其他用户。
- **PROJECT-LIST-001**：列表展示项目名称、状态；点击在新标签页打开该项目看板。
- **PROJECT-DASH-001**：看板展示阶段表、feature 流水线、当前 stage、阻塞摘要、日志 tail（数据来源于项目 `.pipeline/stages.json` 及关联日志）。
- **PROJECT-CREATE-001**：表单字段对齐 ai-std4 `inputs/req.md` 用户填写项（项目名称中/英、项目简介、客户端目标多选等），并包含标识「新增」状态的字段。
- **BACKEND-API-QUERY-001**：供 ai-std4 或调用方查询已登记项目，支撑基于 std4 的项目开发。
- **BACKEND-API-PIPELINE-001**：供集成方新建项目并上报流水线运行数据。

## 鉴权方案

| 场景 | 方案 | 说明 |
| --- | --- | --- |
| 管理端（admin） | Session / Cookie | 登录成功后颁发会话；未登录访问受保护页面时跳转登录 |
| 集成 Open API（backend） | Bearer Token 或 API Key | 由环境或管理员配置；禁止在 PRD 与仓库中写入真实密钥 |
| 默认管理员 | 环境变量引导 | 首次部署从 `config.env` 读取引导账号，不落库明文到文档 |

> `inputs/req.md` 曾标注「none（本地只读）」；当前核心功能已包含登录、项目创建与写 API，以本表 **Session + API Key** 为准。

## 部署架构

| 项 | 内容 |
| --- | --- |
| 云平台 | Cloudflare |
| 主域名 | `dash.ai-ww.com`（`DOMAIN`） |
| 环境 | `dev`、`release`（各端子域规则一致） |

| 端 | dev URL | release URL |
| --- | --- | --- |
| admin | `https://admin.dash.ai-ww.com` | `https://admin.dash.ai-ww.com` |
| backend（api） | `https://api.dash.ai-ww.com` | `https://api.dash.ai-ww.com` |

部署凭证与 API Token 仅存放于 `inputs/config.env` / `docs/config.env`。

## 非功能需求

- **可用性**：看板与列表以只读展示为主，接口应容忍 `.pipeline/stages.json` 暂缺或字段不完整并给出明确空态。
- **性能**：项目列表与看板首屏在常规数据量下可接受（本地调试场景，无硬性 SLA）。
- **安全**：管理端与写接口必须鉴权；日志与响应中不得泄露 `config.env` 中的密钥与默认密码。

## 技术约束

- 须兼容 ai-std4 流水线目录约定（`inputs/req.md`、`.pipeline/stages.json`）。
- 客户端目标仅 **admin**、**backend**，不纳入 website / mobile 除非后续 req 变更。

## 分期计划

| 阶段 | 范围 |
| --- | --- |
| **mvp** | 登录与用户管理、项目列表、看板只读展示、新建项目表单、项目查询与流水线上报 API |
| **standard** | （待 prd-review 补全） |
| **complete** | （待 prd-review 补全） |
| **future** | （待 prd-review 补全） |
