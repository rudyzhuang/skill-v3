import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface ResolvedRunPipeline {
  readonly scriptPath: string;
  /** 与 CLI-VENDOR-STD4-001 对齐：安装根目录，子路径含 vendor/ai-std4 或开发态 ai-std4。 */
  readonly cursorSkillsRoot: string;
}

/** 自任意构建后模块文件向上查找 `skill-v3-std4-cli` 的 package.json。 */
export function resolveCliInstallRootFromImportMeta(importMetaUrl: string): string {
  let dir = path.dirname(fileURLToPath(importMetaUrl));
  for (let depth = 0; depth < 12; depth++) {
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const raw = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string };
        if (raw.name === "skill-v3-std4-cli") return dir;
      } catch {
        /* ignore */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("cli_install_root_not_found_for_skill_v3_std4_cli");
}

/**
 * 优先使用打包 vendor；开发 worktree 回落到仓内 ai-std4。
 * `CURSOR_SKILLS_ROOT` 设为安装根，使 `vendor/ai-std4` 或 `ai-std4` 与 ai-std4 内 pipeline-config 约定一致。
 */
export function resolveRunPipelineBundle(cliInstallRoot: string): ResolvedRunPipeline {
  const vendorEntry = path.join(cliInstallRoot, "vendor", "ai-std4", "scripts", "run-pipeline.cjs");
  const devEntry = path.join(cliInstallRoot, "ai-std4", "scripts", "run-pipeline.cjs");

  const scriptPath = fs.existsSync(vendorEntry) ? vendorEntry : devEntry;
  if (!fs.existsSync(scriptPath)) {
    throw new Error("run_pipeline_entry_missing_under_vendor_or_ai_std4");
  }

  return { scriptPath, cursorSkillsRoot: path.resolve(cliInstallRoot) };
}

export interface SpawnRunPipelineOptions {
  nodeExecutable: string;
  scriptPath: string;
  projectRootAbs: string;
  env: NodeJS.ProcessEnv;
  extraArgs?: readonly string[];
}

function collectExitInfo(child: ReturnType<typeof spawn>): Promise<number> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(typeof code === "number" ? code : 8));
  });
}

/** 触发 vendor / ai-std4 的 `run-pipeline.cjs`，等待退出并返回退出码。 */
export async function spawnRunPipelineOnce(opts: SpawnRunPipelineOptions): Promise<number> {
  const args = [opts.scriptPath, `--project=${opts.projectRootAbs}`, ...(opts.extraArgs ?? [])];

  const child = spawn(opts.nodeExecutable, args, {
    cwd: opts.projectRootAbs,
    env: opts.env,
    stdio: "inherit",
  });

  return collectExitInfo(child);
}
