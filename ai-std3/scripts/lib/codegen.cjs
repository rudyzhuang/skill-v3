#!/usr/bin/env node
/**
 * codegen.cjs — stage: codegen
 *
 * 规范: docs/spec/std3.md §1 codegen.cjs
 *
 * 调用 cursor-agent（AI_STD3_AGENT_BIN）在 worktree 内实现代码。
 * 若 AI_STD3_SKIP_AGENT=1（仅非严格调试），跳过 agent 调用，创建空 commit。
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync, execSync } = require('child_process');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[codegen] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages) { console.error('[codegen] ❌ stages.json 不存在'); process.exit(1); }

const dr  = stages.stages.design_review;
const cui = stages.stages.create_ui_scenarios;
if (dr.status !== 'completed' || !dr.outputs.can_enter_codegen) {
  console.error('[codegen] ❌ 上游门闸失败：design_review 未通过');
  process.exit(1);
}
if (cui.status !== 'completed') {
  console.error('[codegen] ❌ 上游门闸失败：create_ui_scenarios 未完成');
  process.exit(1);
}

updateStage(projectRoot, 'codegen', { status: 'running', started_at: new Date().toISOString() });

// ── Agent 路径 ─────────────────────────────────────────────────────────────
const agentBin    = process.env.AI_STD3_AGENT_BIN || process.env.AI_CODE3_AGENT_BIN || '';
const skipAgent   = process.env.AI_STD3_SKIP_AGENT === '1' || process.env.AI_CODE3_SKIP_AGENT === '1';
const soakStrict  = process.env.AI_SOAK3_STRICT === '1';

if (!agentBin && !skipAgent) {
  console.error('[codegen] ❌ 未找到 Agent，请设置 AI_STD3_AGENT_BIN 环境变量（或运行 ensure-agent-env.cjs）');
  process.exit(1);
}
if (skipAgent && soakStrict) {
  console.error('[codegen] ❌ AI_SOAK3_STRICT=1 模式下禁止 AI_STD3_SKIP_AGENT=1');
  process.exit(1);
}

// ── 收集待 codegen 的 feature_ids ─────────────────────────────────────────
const phasePlan  = stages.stages.prd_review.outputs.phase_plan || [];
const featureIds = phasePlan.flatMap(p => p.feature_ids || []);
const filterFeat = args.feature || null;
const targets    = filterFeat ? featureIds.filter(f => f === filterFeat) : featureIds;

const worktreeBase = path.join(projectRoot, '.pipeline', 'worktrees');
fs.mkdirSync(worktreeBase, { recursive: true });

const worktrees = [];

for (const fid of targets) {
  const branch      = `features/v3-${fid}`;
  const worktreePath = path.join(worktreeBase, `v3-fc-${fid}`);
  const designPath  = path.join(projectRoot, 'docs', 'designs', `${fid}.design.json`);

  console.log(`[codegen] ▶ feature: ${fid}`);

  // 创建 worktree
  if (!fs.existsSync(worktreePath)) {
    const r = spawnSync('git', ['worktree', 'add', '-b', branch, worktreePath, 'HEAD'], {
      cwd: projectRoot, stdio: 'inherit',
    });
    if (r.status !== 0) {
      // 分支可能已存在，尝试不加 -b
      spawnSync('git', ['worktree', 'add', worktreePath, branch], {
        cwd: projectRoot, stdio: 'inherit',
      });
    }
  }

  if (!skipAgent && agentBin) {
    const promptDir = path.resolve(__dirname, '..', '..', 'prompts');
    const promptFile = path.join(promptDir, 'codegen-impl.md');
    const promptText = fs.existsSync(promptFile)
      ? fs.readFileSync(promptFile, 'utf8')
          .replace(/\{feature_id\}/g, fid)
          .replace(/\{worktree_path\}/g, worktreePath)
          .replace(/\{design_json\}/g, designPath)
      : `在 ${worktreePath} 内按 ${designPath} 实现 feature: ${fid}。完成后 git add . && git commit -m "feat(${fid}): codegen implementation"`;

    const timeoutMs = Number(process.env.AI_STD3_CODEGEN_TIMEOUT_MS) || 7200000;
    console.log(`[codegen]   调用 Agent (timeout=${Math.round(timeoutMs/60000)}min)...`);

    const agentResult = spawnSync(agentBin, ['--prompt', promptText, '--workspace', worktreePath], {
      stdio: 'inherit',
      timeout: timeoutMs,
      env: { ...process.env, PROJECT_ROOT: projectRoot, FEATURE_ID: fid },
    });

    if (agentResult.status !== 0) {
      console.error(`[codegen] ❌ Agent 失败（退出码 ${agentResult.status}）for feature: ${fid}`);
      updateStage(projectRoot, 'codegen', {
        status: 'failed',
        validation: { passed: false, summary: `Agent 失败: ${fid}` },
      });
      process.exit(agentResult.status === null ? 3 : agentResult.status);
    }
  }

  // 获取 worktree 内变更文件列表
  const gitLog = spawnSync('git', ['diff', '--name-only', 'HEAD~1', 'HEAD'], {
    cwd: worktreePath, encoding: 'utf8',
  });
  const filesChanged = (gitLog.stdout || '').trim().split('\n').filter(Boolean);
  const commitHash = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: worktreePath, encoding: 'utf8',
  }).stdout.trim();

  worktrees.push({ feature_id: fid, branch, worktree_path: worktreePath, commit: commitHash, files_changed: filesChanged });
  console.log(`[codegen] ✅ feature ${fid}: ${filesChanged.length} files changed`);
}

updateStage(projectRoot, 'codegen', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(targets.join('|')) },
  outputs: {
    worktrees,
    agent: { skipped: skipAgent, bin: agentBin || 'none' },
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${targets.length} features codegen'd` },
});

console.log(`[codegen] ✅ codegen 完成（${targets.length} features）`);
process.exit(0);
