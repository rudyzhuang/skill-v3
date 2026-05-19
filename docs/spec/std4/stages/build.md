# build 阶段

[← 规范索引](../std4.md) · [门闸链](../std4.md#2-门闸链汇总) · [编排映射](../std4.md#3-run-pipelinecjs-编排映射) · [卡点速查](../std4.md#4-agent-卡点速查)

> 在 **merge_push** 将 feature 合入主干后，按 **`client_target` × `sub_platform`** 矩阵对各端执行构建，产出可供 **deploy** 消费的 artifact。
>
> **参考 v3（ai-code3 `build.cjs`）**：矩阵化构建、`sub_platforms[]`、`artifacts[]` 字段与 deploy 映射；本 stage **增强**为：按 `src/<client_target>/` **自动探测**语言/框架与默认命令、**各端并行**构建、**分端独立日志**、构建结束后输出 **`.pipeline/reports/build-summary.md`**。
>
> **不**调用云 API、**不**部署；失败阻断 `deploy`。

## 脚本

| 脚本 | 职责 |
| --- | --- |
| `stages/build.cjs` | 编排入口：门闸 → bootstrap → 并行构建 → validate；写 `stages.build` |
| `libs/build-probe.cjs` | 只读探测：按端目录识别框架、推导默认 `command` / `cwd` / `artifact_globs`（可被 config 覆盖） |
| `libs/build-runner.cjs` | 单条 `(client_target, sub_platform)` 构建：子进程、超时、stdout/stderr 落盘、产物存在性校验 |

> 实现目录前缀：`ai-std4/scripts/`（`stages/` 为主脚本，`libs/` 为子脚本；与 [§3 编排映射](../std4.md#3-run-pipelinecjs-编排映射) 一致）。

```bash
node ai-std4/scripts/stages/build.cjs --project=<业务项目根绝对路径>
```

## 上游门闸

| 粒度 | 条件 |
| --- | --- |
| **stage 启动** | `stages.merge_push.status=completed` 且 `outputs.final_commit` 非空 |
| **工作区** | 业务项目根 `git rev-parse HEAD` **等于** `final_commit`（不等 → 退出码 **1**，提示 `git checkout <final_commit>` 后重跑） |
| **停止信号** | 启动时若存在 `stop.signal` → 退出码 **5**（与其它 stage 一致） |

## 并发配置（按端并行）

构建粒度为 **`(client_target, sub_platform)`** 单元（下称 **build unit**），与 feature 级并发无关。并行度取自 **`docs/config.dev.json`**：

```
effective_parallel = min(
  pipeline.stages.build.client_max_parallel,
  pipeline.autorun.build_max_parallel ?? pipeline.autorun.feature_max_parallel
)
```

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pipeline.stages.build.client_max_parallel` | `4` | 本 stage 同时执行的 build unit 上限 |
| `pipeline.autorun.build_max_parallel` | 同 `feature_max_parallel` | 全局构建并发天花板（未配置时回退 `feature_max_parallel`） |
| `timeouts.stages.build_s` | `300` | **单个 build unit** 挂钟超时（秒）；超时 → 该 unit `failed`、`exit_code: 3` |
| `build.artifacts_dir` | `dist` | 产物根目录（相对项目根）；探测/回写 `artifact_path` 的默认父路径 |
| `build.install_before_build` | `true` | 是否在构建前执行 install（见 [安装步骤](#安装步骤可选)） |
| `build.fail_fast` | `false` | `true` 时任一 unit 失败立即取消在途与其余排队 unit；`false` 时跑完全部再汇总 |

> 实现要求：固定大小任务池（`Promise` 池或等价），**禁止**对 build unit 无限制 `spawn`。池内每个 unit 独占一条子进程 + 独立日志文件。

## 输入

| 来源 | 要求 |
| --- | --- |
| `stages.merge_push.outputs.final_commit` | 本次构建应对齐的 git HEAD |
| `stages.merge_push.outputs.target_branch` | 日志与报告展示用 |
| `stages.prd.outputs.client_targets[]` | 当 `build.client_targets` 未配置时的 **fallback** 端列表 |
| `docs/config.dev.json` | `build.*`、`deploy.services[]`（用于推断「须构建」的端）、`timeouts.stages.build_s` |
| 业务仓 `src/<client_target>/` | 各端源码与工程清单（探测依据） |

**构建目标集合 `target_set[]` 解析顺序**（去重、保序）：

1. `config.build.client_targets` 若为 **对象**（v3 矩阵形态，`{ "<target>": { ... } }`）→ 取其键集；
2. 否则若 `config.build.client_targets` 为 **字符串数组** → 直接用；
3. 否则若 `config.build.commands` 为对象 → 取其键集（排除保留键 `build`、`install`）；
4. 否则 → `stages.prd.outputs.client_targets[]`；
5. 仍为空 → 扫描 `src/` 下存在且含可识别工程文件的子目录名。

**须构建 / 可跳过**：对 `target_set` 中每一端，若 `deploy.enabled=false` 且该端未出现在 `deploy.services[].client_target`，仍执行构建（便于本地验证）；若 `build.client_targets.<t>.skip=true` 或探测为 **纯源码后端** 且 `build.force_backend_build≠true` → 记 `status=not_applicable`（见下表）。

## 处理逻辑

### 1. `build-bootstrap`（门闸 + 哈希 + 工作区）

1. **门闸检查**：校验 `merge_push` 门闸与 `final_commit`（`git rev-parse HEAD` 等于 `final_commit`）；不满足 → 退出码 1。`git checkout` / `git pull` **不在**本 stage 执行（由 merge_push 保证远端一致；本 stage 只**校验** HEAD）。
2. **PID 锁**：路径 `.pipeline/locks/build.pid`；检查现有锁文件中的 PID 是否存活——若不存活则视为过期锁，清除并继续；若存活则退出码 1 + 原因说明（防并发构建）。
3. **解析构建目标**：解析 `target_set[]`，展开为 `build_units[]`：每个 `client_target` × `sub_platforms[]`（未声明子平台时视为 `[{ "id": "default" }]`，与 v3 一致）。
4. **先读旧值**：读取 `stages.build.inputs.summary_hash`（骨架不存在则为 `null`）。
5. **计算新值**：`summary_hash_new` = SHA-256(规范化 JSON 包含 `final_commit`、`build` 相关 config 子树（`client_targets`、`commands`、`artifacts_dir`、`install_before_build`）、`build_units` 键列表）。
6. **hash 门控（全段跳过）**：若 `summary_hash_new == 旧值` **且** `stages.build.status=completed` **且** 全部须构建 unit 上次 `status ∈ {completed, not_applicable, skipped}` **且**各 unit 的 `artifact_path` 对应路径实际存在（`fs.existsSync`）→ **整段跳过**（写 `stage_skipped`，退出码 0）。
7. **骨架处理 + 写入新值**（非跳过路径）：
   - 若骨架**不存在**：初始化 `stages.build`，含 `inputs.summary_hash = summary_hash_new`、`status=running`、`outputs.build_units_total`、`outputs.artifacts=[]`、`validation.passed=false`；对每个 unit 预写 `artifacts[]` 行，`status=pending`。
   - 若骨架**已存在**：写入 `inputs.summary_hash = summary_hash_new`；若 hash 发生变化（代码或配置变更）则**重置全部 unit** 为 `pending`；否则保留 `completed`/`not_applicable`/`skipped` unit 状态，将 `failed`/`pending` unit 重置为 `pending`（增量重跑）。
8. 写 `stages.build.status=running`；打 `stage_start`；写入 PID 锁。

### 2. 框架探测（`lib/build-probe.cjs`）

对每个 build unit，在解析 **最终命令** 之前执行探测（结果写入日志 `build_probe` 与 artifact 行的 `framework` / `build_type`）：

**探测根目录 `probe_root`**（优先级）：

1. `build.client_targets.<target>.cwd`（相对项目根）；
2. `src/<client_target>/`（存在 `package.json` / `pubspec.yaml` / `Cargo.toml` / `go.mod` 等之一）；
3. 项目根（单仓多包时的兜底）。

**标记 → 框架 → 默认命令 → 默认产物 glob**（config 未覆盖时启用）：

| 标记文件（在 `probe_root`） | `framework` | 默认 `command` | 默认 `artifact_globs[]` |
| --- | --- | --- | --- |
| `pubspec.yaml` | `flutter` | `flutter build apk --release`（`sub_platform=ios` → `flutter build ios --release --no-codesign`） | `build/app/outputs/**/*.apk`、`build/ios/iphoneos/*.app` |
| `package.json` + `next.config.*` | `next` | `npm run build` | `.next/**`、`out/**` |
| `package.json` + `vite.config.*` | `vite` | `npm run build` | `dist/**` |
| `package.json` + `angular.json` | `angular` | `npm run build` | `dist/**` |
| `package.json`（`scripts.build` 存在） | `npm` | `npm run build` | `dist/**`、`build/**` |
| `package.json`（无 `scripts.build`） | `npm` | `npm run build --if-present` | `dist/**` |
| `Cargo.toml` | `rust` | `cargo build --release` | `target/release/**` |
| `go.mod` | `go` | `go build -o bin/ ./...` | `bin/**` |
| `pyproject.toml` / `setup.py` | `python` | `python -m build`（缺工具则 `skipped` + WARN） | `dist/*.whl` |
| `project.config.json` + `app.json`（Taro） | `taro` | `npm run build:weapp`（按 `sub_platform` 映射脚本名） | `dist/**` |
| `manifest.json` + `pages/`（小程序） | `miniapp-native` | 配置项 `build` 或 `skipped` | `miniprogram/**` |
| **无构建清单** 且 `client_target=backend` | `backend-source` | （无） | — |
| **无构建清单** 且非 backend | `unknown` | （无） | — |

**命令优先级**（从高到低，与 v3 / `input-spec` 一致）：

1. `build.client_targets.<target>.sub_platforms[].build`（匹配 `sub_platform.id`）；
2. `build.client_targets.<target>.build`；
3. `build.commands.<target>`（扁平表，如模板中的 `"website": "npm run build"`）；
4. 探测得到的默认 `command`；
5. 全局 `build.commands.build`（仅当无 per-target 且探测失败时回退）；
6. 仍无命令：`backend` → `not_applicable`；其它端 → `failed`（`build_type=not_configured`）。

**`build_type` 枚举**：`configured` | `detected` | `not_configured` | `not_applicable` | `skipped`。

#### 安装步骤（可选）

当 `build.install_before_build=true` 且 `build_type` 为 `configured` / `detected`：

| 框架 | 默认 install 命令 |
| --- | --- |
| `npm` / `vite` / `next` / `angular` | `npm ci`（无 lock 则 `npm install`） |
| `flutter` | `flutter pub get` |
| `rust` | （跳过，cargo build 自带） |
| `go` | `go mod download` |

install 超时计入同一 `build_s` 或单独 `build.install_timeout_s`（默认 `min(120, build_s/3)`）。install 失败 → 该 unit `failed`，不执行 build。

### 3. 并行构建（`lib/build-runner.cjs`）

1. 将全部 `pending` 的 build unit 放入队列；以 `effective_parallel` 并发 dequeue。
2. 每个 unit 启动前再次检查 `stop.signal`：存在则不再启动新 unit，在途 unit **等待自然结束**后 `status=stopped`，退出码 **5**。
3. 对单个 unit：
   - 打 `build_unit_start`（INFO），`meta` 含 `client_target`、`sub_platform`、`command`、`cwd`、`framework`、`build_type`；
   - 将 stdout/stderr **tee** 到  
     `<项目根>/logs/stages/build/<datetime>-<client_target>-<sub_platform>.log`  
     并在 stage 总日志中每 **≥5s** 或每 **≥200 行** 打一条 `build_unit_progress`（INFO），`meta` 含 `lines_stdout`、`lines_stderr`、`elapsed_ms`（避免刷屏）；
   - `cwd = probe_root`；`env` 注入 `AI_STD4_PROJECT_ROOT`、`AI_STD4_CLIENT_TARGET`、`AI_STD4_SUB_PLATFORM`；
   - 执行 `sh -c '<command>'`（Windows 不在 scope；与 v3 一致用 `sh -c`）；
   - 命令结束 → **产物校验**（见下）；写 `artifact_path`、`log_path`、`duration_ms`、`exit_code`；
   - 打 `build_unit_complete` 或 `build_unit_failed`。
4. 全部 unit 终态后打 `build_batch_complete`（`agent_batch_complete` 可复用，见日志表）。

**产物校验**（命令 exit=0 仍可能失败）：

- 对 `artifact_globs[]`（config `artifact_globs` > 探测默认 > `dist/<target>/<sub>/`）做 `glob`；至少匹配 **1** 个文件；
- `not_applicable` / `skipped` 跳过 glob；
- 失败 → unit `status=failed`，`artifact_check.passed=false`，`artifact_check.missing_globs[]`。

**`artifact_path` 写入规则**：

- 优先：config `artifact_path` 显式路径；
- 否则：glob 命中文件的**共同父目录**（取最短合理公共路径）；
- 否则：`path.join(artifacts_dir, client_target, sub_platform)`（即使为空目录也写入，便于 deploy 报错可读）。

### 4. `build-validate`（汇总 + 报告）

1. 汇总 `outputs.artifacts[]`；统计 `completed` / `failed` / `not_applicable` / `skipped` / `timed_out`。
2. **stage 门闸**：
   - 凡在 `deploy.services[]` 中出现且 `deploy.enabled=true` 的 `(client_target, sub_platform)`，必须存在**恰好一条**可部署 artifact：`status=completed` 且 `artifact_path` 非空且 `artifact_check.passed=true`（与 **ai-publish-dev3** `isDeployableArtifact` 对齐，`completed` 等同 v3 的 `success`）；
   - 任一其它「须构建」unit `failed` → `validation.passed=false`；
   - `backend` 的 `not_applicable` **不**计入失败。
3. 写 `stages.build`：`status`、`validation.passed`、`outputs.duration_ms`、`outputs.timed_out`、`outputs.failed_units[]`。
4. 生成 **`.pipeline/reports/build-summary.md`**（人话 + 表格式，见 [构建报告](#构建报告)）。
5. 释放 PID 锁；`stage_complete` 或 `stage_failed`。

**退出码**：

| 码 | 含义 | stages.build.status |
| ---: | --- | --- |
| 0 | 全部须构建 unit 通过 | `completed` |
| 0 | hash 命中整段跳过 | `completed`（不变） |
| 1 | 门闸/HEAD 不一致/配置无法解析/无 target/PID 锁占用 | `failed` |
| 3 | 至少一个 unit **超时**（且无其它失败时可单独 3；与 failed 并存时优先 **4**） | `failed` |
| 4 | 至少一个 unit **构建或产物校验失败** | `failed` |
| 5 | stop.signal | `stopped` |

## 构建报告

路径：**`<项目根>/.pipeline/reports/build-summary.md`**

必含章节：

1. **摘要**：`final_commit`（短 sha）、`target_branch`、总耗时、并行度、`validation.passed`。
2. **结果表**（每 build unit 一行）：

   | client_target | sub_platform | framework | status | duration | artifact_path | log |
   | --- | --- | --- | --- | --- | --- | --- |
   | website | default | vite | completed | 42s | dist/website/default | [log](相对路径) |

3. **失败详情**（若有）：命令、exit code、stderr 末 80 行、缺失的 `artifact_globs`。
4. **探测记录**（折叠或附录）：每端探测到的标记文件与最终采用的命令优先级来源。

报告路径写入 `stages.build.outputs.report_path`。

## 日志事件

> 除 [通用事件](../std4.md#标准事件类型所有-stage-通用) 外，本 stage 扩展如下（`meta` 无额外说明时写 `{}`）。

| event | LEVEL | 触发时机 | meta 必填字段 |
| --- | --- | --- | --- |
| `build_probe` | INFO | 单端探测完成 | `client_target`, `sub_platform`, `probe_root`, `framework`, `markers[]`, `command_resolved`, `source`（`config\|detected\|fallback`） |
| `build_batch_start` | INFO | 并行池启动前 | `batch_id`, `units_total`, `effective_parallel`, `unit_keys[]`（`ct:sub`） |
| `build_unit_start` | INFO | 单 unit 开建 | `client_target`, `sub_platform`, `command`, `cwd`, `framework`, `build_type`, `log_path` |
| `build_unit_progress` | INFO | 长构建心跳 | `client_target`, `sub_platform`, `elapsed_ms`, `lines_stdout`, `lines_stderr` |
| `build_unit_complete` | INFO | 单 unit 成功 | `client_target`, `sub_platform`, `duration_ms`, `artifact_path`, `artifact_check` |
| `build_unit_failed` | ERROR | 单 unit 失败 | `client_target`, `sub_platform`, `duration_ms`, `exit_code`, `timed_out`, `reason`, `log_path` |
| `build_batch_complete` | INFO | 全部 unit 结束 | `batch_id`, `succeeded[]`, `failed[]`, `skipped[]`, `not_applicable[]`, `duration_ms` |
| `artifact_check` | INFO / ERROR | 产物 glob 校验 | `client_target`, `sub_platform`, `passed`, `missing_globs[]` |

**人类可读日志要求**（stage 总日志 + 分 unit 日志）：

- 开建/结束必须有**中文或英文**单行摘要（例如：`[build] website/default 开始：vite，cmd=npm run build，cwd=src/website`）；
- 失败时**必须**包含：端名、命令、退出码、日志文件相对路径；
- 禁止仅输出 exit code 而无 `client_target` 上下文。

## 输出

| 路径 | 说明 |
| --- | --- |
| `<项目根>/<artifacts_dir>/...` | 各端构建产物 |
| `<项目根>/logs/stages/build/<datetime>-<ct>-<sub>.log` | 分 unit 完整 stdout/stderr |
| `<项目根>/logs/stages/build/<datetime>.log` | stage 级总日志（与其它 stage 一致） |
| `.pipeline/reports/build-summary.md` | 构建报告 |
| `output-stages/stages.json` | `stages.build`（见下） |

**`stages.build.outputs.artifacts[]` 单行字段**（deploy 消费，与 v3 / publish3 对齐）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `client_target` | string | 端标识 |
| `sub_platform` | string | 默认 `default` |
| `framework` | string | 探测或配置标注 |
| `build_type` | string | 见上文枚举 |
| `command` | string | 实际执行的命令 |
| `cwd` | string | 工作目录（相对或绝对路径） |
| `artifact_path` | string | 产物目录或文件 |
| `log_path` | string | 本分 unit 日志路径 |
| `status` | string | `completed` \| `failed` \| `skipped` \| `not_applicable` |
| `duration_ms` | number | 挂钟耗时 |
| `artifact_check` | object | `{ "passed": bool, "missing_globs": string[] }` |
| `timed_out` | boolean | 是否超时 |
| `exit_code` | number | 子进程退出码（超时可为 null） |

**`stages.build.outputs` 其它字段**：`report_path`、`build_units_total`、`failed_units[]`、`duration_ms`、`timed_out`。

## 解锁

| 条件 | 效果 |
| --- | --- |
| `stages.build.status=completed` 且 `validation.passed=true` | 可运行 `deploy` |
| `status=failed` | 阻断 `deploy`；修复后 `--from-stage=build` |
| `status=skipped` | 仅当 hash 门控命中；deploy 仍消费已有 `artifacts[]` |

## 配置示例

```json
{
  "build": {
    "artifacts_dir": "dist",
    "install_before_build": true,
    "fail_fast": false,
    "client_targets": {
      "website": {
        "sub_platforms": [{ "id": "default", "build": "npm run build" }]
      },
      "mobile": {
        "sub_platforms": [
          { "id": "android", "build": "flutter build apk --release" },
          { "id": "ios", "build": "flutter build ios --release --no-codesign" }
        ]
      },
      "backend": { "skip": true }
    },
    "commands": {
      "website": "npm run build",
      "admin": "npm run build"
    }
  },
  "pipeline": {
    "stages": {
      "build": { "client_max_parallel": 4 }
    }
  },
  "timeouts": {
    "stages": { "build_s": 600 }
  }
}
```

---
