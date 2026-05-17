# Skill V3（第三代 Cursor Agent Skills）

本仓库是 **Skill V3** 的实现与规格配套：与上一代（目录名多为 `ai-*2`、分散在 [skills](https://github.com/rudyzhuang/skills.git) 等仓）**不向后兼容**，字段与路径以本仓 `docs/input-spec.md` 与 `docs/templates/` 为准。

---

## 前置条件

- **Cursor**（支持 Agent Skills 的版本）。
- **Node.js ≥ 18**（建议 LTS；`ai-publish-dev3` 等脚本在 `package.json` 中声明了 `engines.node`）。
- 本机可执行 **`node`**、**`npm`**，且能访问 npm registry（安装各 skill 子目录依赖时用到）。

---

## 按操作系统安装与使用

Cursor 读取用户级 skill 的默认目录为：

| 系统 | 默认路径 |
| --- | --- |
| **macOS / Linux** | `~/.cursor/skills/` |
| **Windows** | `%USERPROFILE%\.cursor\skills\`（例如 `C:\Users\<用户名>\.cursor\skills\`） |

### 1. 取得本仓库

```bash
git clone git@github.com:rudyzhuang/skill-v3.git
cd skill-v3
```

（若使用 HTTPS：`https://github.com/rudyzhuang/skill-v3.git`。）

### 2. 将各 skill 安装到 Cursor skills 目录

本仓根目录下需安装的 **流水线 skill**（`ai-*3`）与 **可选的迁移 skill** 如下：

- `ai-prd3`
- `ai-design3`
- `ai-code3`
- `ai-dash3`
- `ai-auto3`
- `ai-publish-dev3`
- `ai-e2e3`
- `ai-publish-release3`
- `migrate-v2-to-v3`（仅在有 **V2 → V3 老仓迁移**需求时链接；无 `package.json`，**不必** `npm install`）

**做法 A（推荐）：符号链接** — 本仓更新后全局目录即跟随更新。

**macOS / Linux**（将 `<REPO>` 换成本仓绝对路径）：

```bash
SKILLS_ROOT="$HOME/.cursor/skills"
mkdir -p "$SKILLS_ROOT"
for d in ai-prd3 ai-design3 ai-code3 ai-dash3 ai-auto3 ai-publish-dev3 ai-e2e3 ai-publish-release3 migrate-v2-to-v3; do
  ln -sfn "<REPO>/$d" "$SKILLS_ROOT/$d"
done
```

**Windows（PowerShell，管理员或已允许创建符号链接时）**：

```powershell
$Repo = "C:\path\to\skill-v3"
$Skills = Join-Path $env:USERPROFILE ".cursor\skills"
New-Item -ItemType Directory -Force -Path $Skills | Out-Null
foreach ($d in "ai-prd3","ai-design3","ai-code3","ai-dash3","ai-auto3","ai-publish-dev3","ai-publish-release3","migrate-v2-to-v3") {
  $target = Join-Path $Skills $d
  if (Test-Path $target) { Remove-Item $target -Force }
  New-Item -ItemType SymbolicLink -Path $target -Target (Join-Path $Repo $d) | Out-Null
}
```

若环境**不允许符号链接**，改用 **做法 B：复制目录**（`cp -R` 或资源管理器复制整文件夹到 `%USERPROFILE%\.cursor\skills\`），以后升级需手动再复制覆盖。

### 3. 安装各 skill 的 Node 依赖

在**每个带有 npm 依赖的 skill 子目录**内执行一次依赖安装（本仓当前为：`ai-prd3`、`ai-design3`、`ai-code3`、`ai-publish-dev3`；**`ai-auto3` / `ai-dash3` 无 npm 依赖，可跳过**）：

```bash
for d in ai-prd3 ai-design3 ai-code3 ai-publish-dev3; do
  (cd "<REPO>/$d" && npm install)
done
```

若 skill 已通过符号链接装到 `~/.cursor/skills/`，也可在对应全局路径下执行同样的 `npm install`。

### 4. 各操作系统注意点

**macOS / Linux**

- 编排脚本示例（在**业务项目根**执行）：

  ```bash
  node ~/.cursor/skills/ai-auto3/scripts/autorun.cjs --project="$(pwd)"
  ```

**Windows**

- 路径分隔符为 `\`；上述 `node` 命令示例可写为：

  ```powershell
  node $env:USERPROFILE\.cursor\skills\ai-auto3\scripts\autorun.cjs --project=(Get-Location).Path
  ```

### 5. 在 Cursor 里怎么用

- 在 **Cursor Settings → Rules / Skills**（或当前产品中的 Agent Skills 配置）中，确保已启用来自 `~/.cursor/skills/`（Windows 为 `%USERPROFILE%\.cursor\skills\`）的 skill。
- 在对话里用各 `SKILL.md` 中写的**触发词**（例如「ai-auto3」「ai-dash3」「第三代看板」「第三代自动编排」等）唤起对应 skill；业务侧状态真源为业务仓的 **`.pipeline/stages.json`** 与 **`docs/config.*.json`**，详见 `docs/input-spec.md`。

---

## 从 V2 切换到本版（建议移除 V2，避免混用）

上一代 skill 通常也放在 **`~/.cursor/skills/`**（Windows 同上），目录名多为 **`ai-*2`** 或与旧流水线相关的名称。**不要与 V3 并存**：两套命名与 `stages.json` 等契约不一致，并存时 Agent 容易选错 skill。

### 建议步骤

1. **完全退出 Cursor**（避免占用 skill 目录下的文件）。
2. **删除或移走所有第二代 skill 目录**（示例，按你本机实际存在为准）：
   - `ai-prd2`、`ai-prd-review2`
   - `ai-design2`、`ai-contract2`
   - `ai-codegen2`、`ai-typecheck2`、`ai-test2`、`ai-code-review2`、`ai-git2`、`ai-build2`
   - `ai-deploy2`、`ai-smoke2`、`ai-dash2`
   - 以及 **`auto-build-pro`**、**`auto-build-project-with-prd`** 等旧编排/并行 skill（若曾安装）。
3. **（可选）** 若希望清零本机运行态：删除 **`~/.cursor/skills/_runtime/`**（各项目 **`runtime.json`**）；业务仓 **`stages.json`** 不受影响。旧目录 **`_registry/`**、skill 仓根下误写的 **`.pipeline/`** 亦可删除（见 **`docs/spec/runtime-pipeline.md` §5**）。
4. 按上文 **「按操作系统安装与使用」** 安装本仓的 **`ai-*3`**；若有老仓迁移需求，一并链接 **`migrate-v2-to-v3`**。
5. **业务项目**：V3 **不会**读取旧版 `stages.json`、各端 `deployment_plan.json`、业务仓内旧 `scripts/config.env` 等；老项目需按 `docs/input-spec.md` 第九节做一次迁移或重建配置，再跑 V3。

**命名对照（便于你对照删哪些旧目录）**：见 `docs/input-spec.md` **§4.2** 表格「上一版 ↔ 本版 skill 映射」。

---

## `migrate-v2-to-v3`（迁移用 Cursor skill）

**V2 → V3** 一次性迁移脚本与说明集中在目录 **`migrate-v2-to-v3/`**（与其它 skill 同级），内含 **`SKILL.md`** 与 **`scripts/migrate-v2-to-v3.cjs`**。可与 **`ai-*3`** 一样链到 **`~/.cursor/skills/migrate-v2-to-v3/`**，便于在对话中用触发词唤起；执行迁移时在 **skill-v3 仓库根**调用：

```bash
node migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs --project=/abs/path/to/business-repo
node migrate-v2-to-v3/scripts/migrate-v2-to-v3.cjs --project=/abs/path/to/business-repo --commit
```

默认 **`--templates-root`** 指向 skill-v3 根（含 **`docs/templates/`**）；若只拷贝了 `migrate-v2-to-v3` 子目录，须显式传入 **`--templates-root`**。可能依赖本机 **`sqlite3` CLI**；未覆盖项见 **`docs/input-spec.md` §9.3** 与 **`migrate-v2-to-v3/SKILL.md`**。

---

## 文档入口

- 总览与契约边界：**[docs/input-spec.md](docs/input-spec.md)**
- 各阶段规格：`docs/spec/` 下 `prd3.md`、`design3.md`、`code3.md`、`auto3.md`、`publish3.md` 等
