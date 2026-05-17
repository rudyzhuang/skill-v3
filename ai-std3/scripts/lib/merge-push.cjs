#!/usr/bin/env node
/**
 * merge-push.cjs — stage: merge_push
 *
 * 规范: docs/spec/std3.md §1 merge_push.cjs
 *
 * 将所有 feature 分支合并到 default_branch，并推送。
 */

'use strict';

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { readStages, updateStage, sha256Text } = require('./stages-io.cjs');

const args = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (a.startsWith('--')) args[a.slice(2)] = true;
}

if (!args.project) { console.error('[merge-push] 必须提供 --project='); process.exit(1); }
const projectRoot = path.resolve(args.project);

const stages = readStages(projectRoot);
if (!stages) { console.error('[merge-push] ❌ stages.json 不存在'); process.exit(1); }

const cr = stages.stages.code_review;
if (cr.status !== 'completed' || cr.outputs.decision === 'failed') {
  console.error('[merge-push] ❌ 上游门闸失败：code_review 未通过');
  process.exit(1);
}

updateStage(projectRoot, 'merge_push', { status: 'running', started_at: new Date().toISOString() });

// ── 读取配置 ───────────────────────────────────────────────────────────────
let cfg = {};
const cfgPath = path.join(projectRoot, 'docs', 'config.dev.json');
if (fs.existsSync(cfgPath)) {
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
}

const defaultBranch = (cfg.git && cfg.git.default_branch) || 'main';
const remote        = (cfg.git && cfg.git.remote) || 'origin';

function git(gitArgs, cwd = projectRoot) {
  return spawnSync('git', gitArgs, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

// ── 合并 feature 分支 ──────────────────────────────────────────────────────
const worktrees       = stages.stages.codegen.outputs.worktrees || [];
const mergedFeatures  = [];
const conflictFeatures = [];

// 切到 default_branch
let r = git(['checkout', defaultBranch]);
if (r.status !== 0) {
  console.error(`[merge-push] ❌ 无法切换到 ${defaultBranch}: ${r.stderr}`);
  process.exit(1);
}
git(['pull', remote, defaultBranch]);

for (const wt of worktrees) {
  const { feature_id, branch } = wt;
  console.log(`[merge-push] 合并 ${branch} → ${defaultBranch}`);

  const merge = git(['merge', '--no-ff', branch, '-m', `feat(${feature_id}): merge codegen implementation`]);
  if (merge.status !== 0) {
    console.error(`[merge-push] ⚠ 合并冲突: ${feature_id}`);
    console.error(merge.stderr);
    git(['merge', '--abort']);
    conflictFeatures.push(feature_id);
  } else {
    mergedFeatures.push(feature_id);
    console.log(`[merge-push]   ✅ ${feature_id} 合并成功`);
  }
}

if (conflictFeatures.length > 0) {
  console.error(`[merge-push] ❌ 存在合并冲突: ${conflictFeatures.join(', ')}`);
  console.error('[merge-push] → 请人工解决冲突后重跑 --from-stage=merge_push');
  updateStage(projectRoot, 'merge_push', {
    status: 'failed',
    outputs: { conflict_features: conflictFeatures, merged_features: mergedFeatures },
    validation: { passed: false, summary: `${conflictFeatures.length} conflict(s)` },
  });
  process.exit(4);
}

// ── Push ────────────────────────────────────────────────────────────────────
console.log(`[merge-push] git push ${remote} ${defaultBranch} ...`);
let pushResult = git(['push', remote, defaultBranch]);
if (pushResult.status !== 0) {
  console.log('[merge-push] push 失败，尝试 pull --rebase 后重推...');
  git(['pull', '--rebase', remote, defaultBranch]);
  pushResult = git(['push', remote, defaultBranch]);
  if (pushResult.status !== 0) {
    console.error(`[merge-push] ❌ push 失败: ${pushResult.stderr}`);
    updateStage(projectRoot, 'merge_push', {
      status: 'failed',
      outputs: { merged_features: mergedFeatures, target_branch: defaultBranch },
      validation: { passed: false, summary: 'push failed' },
    });
    process.exit(7);
  }
}

const finalCommit = git(['rev-parse', 'HEAD']).stdout.trim();
updateStage(projectRoot, 'merge_push', {
  status: 'completed',
  completed_at: new Date().toISOString(),
  inputs: { summary_hash: sha256Text(mergedFeatures.join('|')) },
  outputs: {
    merged_features: mergedFeatures,
    target_branch: defaultBranch,
    final_commit: finalCommit,
  },
  validation: { passed: true, checked_at: new Date().toISOString(), summary: `${mergedFeatures.length} features merged` },
});

console.log(`[merge-push] ✅ merge_push 完成。${mergedFeatures.length} features → ${defaultBranch} (${finalCommit.slice(0,8)})`);
process.exit(0);
