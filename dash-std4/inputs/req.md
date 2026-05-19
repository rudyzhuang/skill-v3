# 项目需求说明

## 项目名称 *

DashStd4

## 项目简介 *

面向 ai-std4 流水线开发与验收的轻量示例：提供只读 Web 看板，展示业务项目 `.pipeline/stages.json` 各 stage 状态、阻塞项与最近日志摘要，便于本地调试 std4 全链路。

## 客户端目标 *
- admin
- backend

## 核心功能 *

1. 需要登录, 默认管理员账号： admin@std4 密码：#$FDs9ddek23$#@cdfue. 其他用户由管理员在后台创建后使用。
2. 项目列表：显示项目名称，状态， 点击打开新标签页显示看板， 看版显示每个项目当前的ai-std4 流水线开发详情
3. 看板展示：（阶段表、feature流水线、当前 stage、阻塞摘要、日志 tail）
4. 项目列表 可以创建新项目，点击后，打开表单页面，该表单的输入项目，对应 ai-std4 在inputs 中 要求的‘req.md’中的用户填写内容： 如 项目名称：中文/英文； 项目简介；等。“客户端目标” 做成多选项，内容参考模板中的注释。要有字段标识是新增状态。
5. 提供api，可以查询项目，如果是服务端新增的项目，调用者可以基于ai-std4进行项目开发。
6. 集成ai-std4的调用者，通过api可以新建项目，上报项目流水线运行数据


## 非功能需求


## 部署与域名要求 *

- 云平台：Cloudflare
- 主域名见下节；dev / release 各端子域一致（admin、api）
- 环境：dev、release

## 主域名 *

DOMAIN= dash.ai-ww.com

### 各端域名 *
#### dev 环境
<!-- 示例：
- website dev-www.<DOMAIN>
- admin dev-admin.<DOMAIN>
- backend 域名：dev-api.<DOMAIN>
-->
- admin  url = https://admin.<DOMAIN>
- backend  url = https://api.<DOMAIN>

#### release 环境
同dev环境

## 鉴权方案 *

none（本地只读看板，不暴露写接口）

## 技术约束


## 其他说明

