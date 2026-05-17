# Skill 目录运行时状态（runtime.json）

## 0. 文档角色（SSOT）

| 约定 | 说明 |
| --- | --- |
| **唯一实现参考源** | 编写 **`runtime.json` 读写**、**ai-dash3 多项目列表**、**ai-auto3 / ai-soak3 / ai-code3 后台进程登记** 时，**以本文为规范来源**。 |
| **与 `docs/input-spec.md` 的关系** | §3.2 总纲已改为 **runtime.json** 为本机多项目运行态真源；本文展开字段、路径、读写边界与迁移。 |
| **与业务仓 `.pipeline/` 的关系** | **业务项目**内 **`<project_root>/.pipeline/stages.json`** 仍是编排门闸真源；**业务项目运行态**在 **`<skills_root>/_projects/<project.name>/runtime.json`**（**`project.name`** 来自 **`docs/config.dev.json`**）；**skill 级**元数据（如 dash serve）在 **`<skills_root>/_runtime/`**。 |

**维护流程**：先改 **`docs/templates/runtime.json.template`**（即 `docs/templates/runtime.json`）→ 本文 → **`input-spec.md` / `dash3.md` / `auto3.md`** → 各 skill 实现。

---

## 1. 路径与命名

| 项 | 约定 |
| --- | --- |
| **`<skills_root>`** | skill 安装根，例如 **`~/.cursor/skills`**（与 `input-spec.md` §3 一致）。 |
| **业务项目目录** | **`<skills_root>/_projects/<project.name>/`** — **`<project.name>`** 取自业务仓 **`docs/config.dev.json` → `project.name`**（目录名仅去掉 `/\` 等非法字符，可保留中文） |
| **业务项目文件** | **`<skills_root>/_projects/<project.name>/runtime.json`** |
| **skill 级目录** | **`<skills_root>/_runtime/`** — 仅 **ai-dash3 serve** 等 skill 元数据（如 **`dash-serve.json`**），**不**放业务项目编排态 |
| **禁止** | 把 runtime 写入 skill 仓 **`.pipeline/`** 或业务仓；**ai-dash3 列表/看板仅读 `_projects/`** |
| **git** | **`_projects/`** 与 **`_runtime/`** 均 **`.gitignore`**，不入仓 |

**`project_name` 口语**：文档与 UI 中的「项目名」默认指 **`project_id`**；可选 **`project.display_name`** 仅用于展示，**不**参与目录名。

---

## 2. 读写职责矩阵

| 组件 | 读 | 写 | 说明 |
| --- | --- | --- | --- |
| **ai-auto3** | ✓ | ✓ | **autorun** 开跑/阶段推进/结束：更新 **`orchestration.*`**、**`recent_runs[]`**、**`processes[]`**（autorun 主进程）；结束或 **stop-pipeline** 时清理 **`active`**。 |
| **ai-soak3** | ✓ | ✓ | **start-and-monitor**、Round 监控：登记 soak/autorun 子进程；与 auto3 共用同一 **`project_id`** 文件（**`updated_by`** 区分）。 |
| **ai-code3** | ✓ | ✓ | 长时 **codegen agent** / 并行子进程：向 **`processes[]`** **additive** 登记 **`kind: code3-*`**；阶段结束移除或标 **`exited`**。 |
| **ai-dash3** | ✓ | △ | **只读**聚合为主；**`serve`** 启动时可写 **`services.dash_serve`**（本实例 host/port/pid）；**禁止**写 **`orchestration`** / **`stages`**。 |
| **ai-prd3 / ai-design3 / ai-publish-*** | — | — | **不**写 runtime；门闸仍只写业务仓 **`stages.json`**。 |

**写盘规则**：

1. **原子写**：先写 **`runtime.json.tmp`**，再 **`rename`** 为 **`runtime.json`**（与 `stages.json` 写回同模式）。
2. **`updated_at`**：每次写必为 ISO 8601 UTC。
3. **`processes[]`**：后台进程 **启动时 append**；退出时更新 **`status: exited`**、**`exit_code`**、**`ended_at`**，**不**无限增长（保留最近 **32** 条，超出删最旧）。
4. **`recent_runs[]`**：保留最近 **20** 条；字段对齐原 **`registry.sqlite` → `pipeline_runs`**。

---

## 3. 字段说明（与模板对齐）

### 3.1 根级

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| **`_schema`** | object | **`name: skill-v3-runtime`**，**`version`** 整数；breaking 变更须升 version。 |
| **`project`** | object | **`project_id`**、**`root_path`**（绝对路径）、可选 **`display_name`**。 |
| **`updated_at`** | string \| null | 最后写入时间。 |
| **`updated_by`** | string \| null | 最后写入方，如 **`ai-auto3`**、**`ai-soak3`**、**`ai-code3`**、**`ai-dash3`**。 |

### 3.2 `orchestration`

| 字段 | 说明 |
| --- | --- |
| **`active`** | 是否有进行中的编排（与 **`active_run_id`** 一致）。 |
| **`active_run_id`** | 本次 run UUID。 |
| **`session_id`** | 对齐 **`.agent-sessions/<session_id>.log`**。 |
| **`orchestrator`** | **`ai-auto3`** \| **`ai-soak3`** \| null。 |
| **`current_phase` / `current_stage`** | 与 registry 原 **`project_runtime_state`** 同义。 |
| **`pending_features`** | **string[]**（原 **`pending_features_json`** 解析结果；写盘用数组，**禁止**再嵌 JSON 字符串）。 |
| **`started_at`** | 本次编排开始时间。 |
| **`pid_lock`** | 只读镜像业务仓 **`pipeline.pid`** 探测结果（**dash** 亦可从项目读，此处为缓存加速）。 |

### 3.3 `processes[]`

每项至少：

| 字段 | 说明 |
| --- | --- |
| **`id`** | 稳定条目 id（uuid 或 **`kind-pid`**）。 |
| **`kind`** | 枚举示例：**`autorun`**、**`soak-monitor`**、**`codegen-agent`**、**`cursor-agent`**、**`flutter-run`**、**`dash-serve`**。 |
| **`pid`** | 正整数。 |
| **`command`** | 截断至 **512** 字符的可读命令行。 |
| **`started_at` / `ended_at`** | ISO 8601。 |
| **`cwd`** | 绝对路径。 |
| **`log_path`** | 相对 **`project.root_path`** 或绝对路径。 |
| **`status`** | **`running`** \| **`exited`**。 |
| **`exit_code`** | 退出后填写。 |

### 3.4 `recent_runs[]`

| 字段 | 说明 |
| --- | --- |
| **`run_id`** | PK。 |
| **`orchestrator`** | **`ai-auto3`** 等。 |
| **`session_id`** | 会话 id。 |
| **`started_at` / `ended_at`** | |
| **`exit_code`** | 数字或 null（未结束）。 |
| **`stopped_at_stage`** | 失败停留阶段键名（下划线）。 |

### 3.5 `services.dash_serve`

**ai-dash3** **`serve`** 实例元数据：**`{ pid, host, port, started_at, url }`**；**stop-serve** 时置 **`null`**。

---

## 4. ai-dash3 数据流（只读 + 项目深读）

1. **枚举项目（ai-dash3）**：**仅**扫描 **`<skills_root>/_projects/*/runtime.json`**；下拉展示 **`project_name`**（来自 runtime 内字段，写入时取自 **`config.dev.json`**）。
2. **选中项目**：读取对应 **`runtime.json`** → 得到 **`root_path`**。
3. **深读业务仓**（与现实现一致，路径相对 **`root_path`**）：
   - **`.pipeline/stages.json`** — 阶段表、Feature 板、阻塞；
   - **`.pipeline/reports/`** — 报告列表；
   - **`.agent-sessions/locks/pipeline.pid`** — PID 存活（可与 runtime 中 **`pid_lock`** 交叉校验）。
4. **合并展示**：Web **`GET /api/registry`** 改为 **`GET /api/projects`**（或保留路径、改语义为 runtime 列表）；**`GET /api/dashboard?project=<abs>`** 的 **`runtime`** 块来自 **runtime.json** + 现场 PID 探测，**不再**调用 **`registry-export.cjs`** / **SQLite**。

---

## 5. 路径与旧数据清理

| 项 | 说明 |
| --- | --- |
| **当前路径** | **`<skills_root>/_runtime/<project_id>/runtime.json`** — skill 仓**禁止**再写 **`.pipeline/`** |
| **旧路径迁移** | **`<skills_root>/.pipeline/<id>/`** → `runtime-io.cjs` 首次访问时自动迁到 **`_runtime/`** |
| **`registry.sqlite`** | **已移除**；`registry-db.cjs` 仅 re-export **`runtime-io.cjs`** |
| **`_registry/`** | 可整目录删除，脚本不再创建 |

**可重建性**：删除 **`<skills_root>/_runtime/`** 后，下次 **autorun** / **soak** 从业务仓 **`stages.json`** 重建 **`project`** 与空 **`orchestration`**。

---

## 6. 共享库（实现指引）

建议在 **`<skills_root>/ai-auto3/scripts/lib/runtime-io.cjs`**（或 **`docs` 同级 **`scripts/lib`** 若抽公共包）提供：

- **`resolveRuntimePath(skillsRoot, projectId)`**
- **`readRuntime(projectId)` / `writeRuntime(projectId, patch)`**（merge patch，保留未提及键）
- **`registerProcess(projectId, entry)` / `markProcessExited(projectId, pid, exitCode)`**
- **`listProjectsFromRuntime(skillsRoot)`**

**ai-soak3**、**ai-code3** **require** 该模块，避免三份实现分叉。

---

## 7. 验收清单

- [ ] 模板 **`docs/templates/runtime.json`** 与本文 §3 一致。
- [ ] **autorun** 开跑后存在 **`<skills_root>/_runtime/<project_id>/runtime.json`**，且 **`orchestration.active === true`**。
- [ ] **stop-pipeline** 后 **`active === false`**，相关 **`processes`** 标 **`exited`**。
- [ ] **ai-dash3 serve** 项目下拉来自 **runtime 扫描**，无 **SQLite** 依赖。
- [ ] 选中项目后阶段表来自业务 **`stages.json`**，运行态来自 **runtime.json**。
- [ ] **ai-soak3** 后台 **autorun** 在 **runtime.processes** 可见。
- [ ] **`.gitignore`** 忽略 **`.pipeline/`**（skills 仓根），模板仍提交。

---

## 8. 交叉索引

| 主题 | 文档 |
| --- | --- |
| 总纲 §3.2 | **`docs/input-spec.md`** |
| 看板 API | **`docs/spec/dash3.md` §7.1** |
| autorun / 停跑 | **`docs/spec/auto3.md` §8–§9** |
| soak 监控 | **`ai-soak3/docs/spec/soak3.md` §辅助脚本** |
| codegen 长进程 | **`docs/spec/code3.md` §可观测性** |
