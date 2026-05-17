#!/usr/bin/env node
/**
 * run-pipeline.cjs — ai-std3 标准流水线主编排入口
 *
 * 用法:
 *   node run-pipeline.cjs --project=<业务项目根绝对路径>
 *     [--from-stage=<stage>]         从某个 stage 续跑（默认 setup）
 *     [--to-stage=<stage>]           跑到哪个 stage 停止（默认 report）
 *     [--force-rerun=<stage>]        强制重跑单个 stage（忽略 completed 缓存）
 *     [--feature=<feature_id>]       仅处理指定 feature（codegen 等 stage 支持）
 *     [--explicit-confirm]           对 destructive deploy 的手工确认
 *
 * 退出码:
 *   0  = 流水线全部通过
 *   1  = 脚本/前置错误
 *   2  = 用户中断
 *   3  = 超时
 *   4  = 需 Agent 介入
 *   7  = git push 失败
 */

'use strict';

const fs          = require('fs');
const path        = require('path');
const { spawnSync } = require('child_process');

// ── 参数解析 ──────────────────────────────────────────────────────────────

const args = { _: [] };
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) {
    const k = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[k] = m[2];
  } else if (arg.startsWith('--')) {
    const k = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    args[k] = true;
  } else {
    args._.push(arg);
  }
}

if (!args.project) {
  console.error('[run-pipeline] 必须提供 --project=<业务项目根绝对路径>');
  process.exit(1);
}

const projectRoot = path.resolve(args.project);
const skillDir    = path.resolve(__dirname, '..');
const libDir      = path.join(skillDir, 'scripts', 'lib');
const scriptsDir  = path.join(skillDir, 'scripts');

// ── 阶段定义 ──────────────────────────────────────────────────────────────

const STAGES = [
  { name: 'setup',                scripts: [
      { dir: scriptsDir, file: 'setup-inputs.cjs'  },
      { dir: scriptsDir, file: 'verify-req.cjs'    },
      { dir: scriptsDir, file: 'sync-config-env.cjs' },
    ]
  },
  { name: 'prd',                  scripts: [{ dir: libDir, file: 'prd.cjs'                  }] },
  { name: 'prd-review',           scripts: [{ dir: libDir, file: 'prd-review.cjs'           }] },
  { name: 'design',               scripts: [{ dir: libDir, file: 'design.cjs'               }] },
  { name: 'design-review',        scripts: [{ dir: libDir, file: 'design-review.cjs'        }] },
  { name: 'create-ui-scenarios',  scripts: [{ dir: libDir, file: 'create-ui-scenarios.cjs'  }] },
  { name: 'codegen',              scripts: [{ dir: libDir, file: 'codegen.cjs'              }] },
  { name: 'code-review',          scripts: [{ dir: libDir, file: 'code-review.cjs'          }] },
  { name: 'merge_push',           scripts: [{ dir: libDir, file: 'merge-push.cjs'           }] },
  { name: 'build',                scripts: [{ dir: libDir, file: 'build.cjs'                }] },
  { name: 'deploy',               scripts: [{ dir: libDir, file: 'deploy.cjs'               }] },
  { name: 'smoke',                scripts: [{ dir: libDir, file: 'smoke.cjs'                }] },
  { name: 'ui_e2e',               scripts: [{ dir: libDir, file: 'ui-e2e.cjs'               }] },
  { name: 'report',               scripts: [{ dir: libDir, file: 'report.cjs'               }] },
];

const STAGE_NAMES = STAGES.map(s => s.name);

function stageIndex(name) {
  const i = STAGE_NAMES.indexOf(name);
  if (i < 0) {
    console.error(`[run-pipeline] 未知 stage: ${name}。可选值: ${STAGE_NAMES.join(', ')}`);
    process.exit(1);
  }
  return i;
}

const fromStage    = args.fromStage    || 'setup';
const toStage      = args.toStage      || 'report';
const forceRerun   = args.forceRerun   || null;

const fromIdx = stageIndex(fromStage);
const toIdx   = stageIndex(toStage);

// ── 会话 ID ────────────────────────────────────────────────────────────────

const sessionId = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── 阶段运行函数 ───────────────────────────────────────────────────────────

function runStageScript(scriptPath, extraArgs = []) {
  const baseArgs = [`--project=${projectRoot}`, `--session-id=${sessionId}`];
  if (args.feature)          baseArgs.push(`--feature=${args.feature}`);
  if (args.explicitConfirm)  baseArgs.push('--explicit-confirm');

  const allArgs = [...baseArgs, ...extraArgs];
  const result = spawnSync(process.execPath, [scriptPath, ...allArgs], {
    stdio: 'inherit',
    env:   process.env,
  });

  if (result.error) {
    console.error(`[run-pipeline] ❌ 无法启动脚本 ${scriptPath}: ${result.error.message}`);
    return 1;
  }
  return result.status;
}

function shouldSkipStage(stageName) {
  if (forceRerun === stageName) return false;
  const stagesJsonPath = path.join(projectRoot, '.pipeline', 'stages.json');
  if (!fs.existsSync(stagesJsonPath)) return false;
  try {
    const s = JSON.parse(fs.readFileSync(stagesJsonPath, 'utf8'));
    const key = stageName.replace(/-/g, '_');
    return s.stages && s.stages[key] && s.stages[key].status === 'completed';
  } catch { return false; }
}

// ── 主循环 ─────────────────────────────────────────────────────────────────

console.log(`[run-pipeline] ▶ 启动流水线 project=${projectRoot}`);
console.log(`[run-pipeline]   range: ${fromStage} → ${toStage}  session=${sessionId}`);
if (forceRerun) console.log(`[run-pipeline]   force-rerun: ${forceRerun}`);
console.log('');

let overallExitCode = 0;

for (let i = fromIdx; i <= toIdx; i++) {
  const stage = STAGES[i];

  // setup 阶段不做缓存跳过
  const skip = stage.name !== 'setup' && shouldSkipStage(stage.name);
  if (skip) {
    console.log(`[run-pipeline] ⏭ 跳过 ${stage.name}（已 completed，用 --force-rerun=${stage.name} 强制重跑）`);
    continue;
  }

  console.log(`[run-pipeline] ▶ 运行 stage: ${stage.name}`);

  let stageCode = 0;
  for (const { dir, file } of stage.scripts) {
    const scriptPath = path.join(dir, file);
    if (!fs.existsSync(scriptPath)) {
      console.error(`[run-pipeline] ❌ 脚本不存在: ${scriptPath}`);
      stageCode = 1;
      break;
    }
    const code = runStageScript(scriptPath);
    if (code !== 0) {
      stageCode = code;
      break;
    }
  }

  if (stageCode === 0) {
    console.log(`[run-pipeline] ✅ ${stage.name} 完成`);
    console.log('');
  } else {
    console.error(`[run-pipeline] ❌ ${stage.name} 失败（退出码 ${stageCode}）`);
    overallExitCode = stageCode;

    if (stageCode === 4) {
      console.error(`[run-pipeline] → 退出码 4：需要 Agent 介入。`);
      console.error(`[run-pipeline] → 产出所需文件后，用 --from-stage=${stage.name} 续跑。`);
    }

    // report stage 总是尝试运行（即使前面有失败）
    if (stage.name !== 'report') {
      const reportStage = STAGES.find(s => s.name === 'report');
      if (reportStage && i < STAGE_NAMES.indexOf('report')) {
        console.log(`[run-pipeline] → 尝试生成 report...`);
        const { dir, file } = reportStage.scripts[0];
        runStageScript(path.join(dir, file), [`--failure-reason=${stage.name}:exit_${stageCode}`]);
      }
      break;
    }
  }
}

if (overallExitCode === 0) {
  console.log('[run-pipeline] 🎉 流水线全部通过！');
  const reportDir = path.join(projectRoot, '.pipeline', 'reports');
  if (fs.existsSync(reportDir)) {
    const reports = fs.readdirSync(reportDir).filter(f => f.startsWith('autorun-'));
    if (reports.length > 0) {
      const latest = reports.sort().pop();
      console.log(`[run-pipeline]   报告: .pipeline/reports/${latest}`);
    }
  }
}

process.exit(overallExitCode);
