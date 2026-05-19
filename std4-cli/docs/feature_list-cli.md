# Std4Cli 特性表（cli）

| feature_id | 名称 | 优先级 | 阶段 |
| --- | --- | --- | --- |
| CLI-MODE-QUERY-001 | Query 模式：轮询 Dash 待开发项目并串行执行全量流水线 | P0 | mvp |
| CLI-MODE-CREATE-001 | Create 模式：生成业务项目并可注册 Dash，完成后切入 Query | P0 | mvp |
| CLI-VENDOR-STD4-001 | 构建内置 vendor/ai-std4 与运行时 CURSOR_SKILLS_ROOT 编排 | P0 | mvp |
| CLI-CONFIG-INJECT-001 | 将 bundled/std4-config.env 同步注入业务项目 | P0 | mvp |
| CLI-DASH-PIPELINE-001 | 监听流水线阶段并向 Dash 上报状态 | P0 | mvp |
| FEISHU-BIDIR-001 | 集成 feishu-cursor-claw：安装、启动、上报与指令解析 | P0 | mvp |
| CLI-OBS-LOG-001 | 本地可观测性：结构化日志、退出码与 CLI 基础信息 | P1 | mvp |
| CLI-RETRY-NFR-001 | Dash 指数退避与飞书异步发送队列 | P1 | standard |

---

与 `docs/prd-spec.md` 核心功能表中的 feature_id 一致，便于跨端（dash / feishu）对齐。
