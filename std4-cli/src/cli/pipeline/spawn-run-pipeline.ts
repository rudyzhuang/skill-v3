import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 不向内置流水线子进程透传的变量（与设计约束对齐，避免凭据或无意义的大块 env 混入）。 */
const PIPELINE_ENV_DENYLIST = new Set(
  (
    [
      'DASH_STD4_API_KEY',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GIT_ASKPASS',
      'NPM_TOKEN',
      'CURSOR_API_KEY',
    ] as const
  ).map((k) => k.toUpperCase()),
);

/** 拷贝父进程环境并剔除 denylist（大小写均匹配）。仅用于流水线 spawn。 */
export function sanitizeEnvForPipeline(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, val] of Object.entries(source)) {
    if (val === undefined) continue;
    if (PIPELINE_ENV_DENYLIST.has(key.toUpperCase())) continue;
    out[key] = val;
  }
  return out;
}

export type SpawnRunPipelineOpts = {
  /** CURSOR_SKILLS_ROOT 对应的目录（含 ai-std4 子目录）。 */
  skillsRoot: string;
  /** 业务项目根，作为子进程 cwd。 */
  projectRoot: string;
  /** 传给 run-pipeline.cjs 的额外 argv（不含 node 与脚本路径）。 */
  pipelineArgs?: readonly string[];
  /** 与子进程合并的环境（会在合并后与父进程一同经 sanitize，禁止透传条目无法注入）。 */
  env?: NodeJS.ProcessEnv;
};

export function runPipelineScriptPath(skillsRoot: string): string {
  return path.join(skillsRoot, 'ai-std4', 'scripts', 'run-pipeline.cjs');
}

/**
 * spawn 内置 run-pipeline.cjs；注入 CURSOR_SKILLS_ROOT；返回子进程退出码（缺省映射为 1）。
 */
export function spawnRunPipeline(opts: SpawnRunPipelineOpts): Promise<number> {
  const script = runPipelineScriptPath(opts.skillsRoot);
  if (!fs.existsSync(script)) {
    return Promise.reject(new Error('std4_cli_spawn_run_pipeline_missing_script'));
  }

  const cwd = path.resolve(opts.projectRoot);
  const node = process.execPath;
  const args = [script, ...(opts.pipelineArgs ?? [])];
  const skillsAbs = path.resolve(opts.skillsRoot);

  const env: NodeJS.ProcessEnv = {
    ...sanitizeEnvForPipeline({ ...process.env, ...opts.env }),
    CURSOR_SKILLS_ROOT: skillsAbs,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(node, args, {
      cwd,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', (err) => {
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(typeof code === 'number' ? code : 1);
    });
  });
}
