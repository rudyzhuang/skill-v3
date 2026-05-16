'use strict';

const path = require('path');
const { runWithTimeout } = require('./run-with-timeout.cjs');

function stageLabelForLog(phase) {
  const p = String(phase || 'impl');
  if (p === 'test_fix') return 'test_fix';
  if (p === 'code_review') return 'code_review';
  if (p === 'test' || p === 'impl') return 'codegen';
  return 'codegen';
}

function buildCursorAgentPrompt({ phase, worktreePath, projectRoot, featureId, extraEnv }) {
  const p = String(phase || 'impl');
  const fid = featureId != null && String(featureId) !== '' ? String(featureId) : '(none)';
  const outPath = String(extraEnv?.AI_CODE3_CODE_REVIEW_OUTPUT || '').trim();
  const lines = [
    'You are running as ai-code3 external agent in non-interactive mode.',
    `Phase: ${p}`,
    `Feature ID: ${fid}`,
    `Worktree: ${worktreePath}`,
    `Project root: ${projectRoot}`,
    '',
    'Requirements:',
    '- Make only the minimal required changes for the current phase.',
    '- Do not modify contract artifacts under docs/contracts.',
    '- Do not print secrets.',
  ];
  if (p === 'code_review') {
    lines.push(
      '- Perform code review and write JSON output to AI_CODE3_CODE_REVIEW_OUTPUT.',
      `- Output path: ${outPath || '(missing)'}`,
      '- JSON must be valid and follow the expected schema.',
      '- After writing the file, exit successfully.'
    );
  } else {
    lines.push('- Complete the requested phase work, then exit successfully.');
  }
  return lines.join('\n');
}

/**
 * 统一外部 Agent 二进制（P4/P5/codegen 共用）。
 * 环境：`AI_CODE3_AGENT_BIN` 或兼容 `AI_CODEGEN_AGENT_BIN`。
 * 注入：`AI_CODE3_PHASE`、`AI_CODE3_WORKTREE`、`AI_CODE3_PROJECT`、可选 **`AI_CODE3_FEATURE_ID`**。
 * 子进程 **cwd** = **`worktreePath`**（code_review 可将主仓根传入二者）。
 */
async function invokeAiCode3Agent({
  worktreePath,
  projectRoot,
  phase,
  featureId,
  timeoutMs,
  extraEnv = {},
}) {
  const bin =
    process.env.AI_CODE3_AGENT_BIN ||
    process.env.AI_CODEGEN_AGENT_BIN ||
    '';
  if (!bin.trim()) {
    return { ok: false, skipped: true, code: 0, reason: 'no_agent_bin' };
  }
  const fid = featureId != null && String(featureId) !== '' ? String(featureId) : '';
  const env = {
    ...process.env,
    ...extraEnv,
    AI_CODE3_PHASE: String(phase || 'impl'),
    AI_CODE3_WORKTREE: worktreePath,
    AI_CODE3_PROJECT: projectRoot,
  };
  if (fid) env.AI_CODE3_FEATURE_ID = fid;
  const cmdBase = path.basename(bin).toLowerCase();
  const args = [];
  if (cmdBase === 'cursor-agent') {
    args.push('--print', '--trust');
    args.push(
      buildCursorAgentPrompt({
        phase,
        worktreePath,
        projectRoot,
        featureId: fid,
        extraEnv,
      })
    );
  }

  const r = await runWithTimeout(bin, args, {
    cwd: worktreePath,
    timeoutMs,
    env,
  });
  const ok = !r.timedOut && r.code === 0;
  const label = stageLabelForLog(phase);
  if (r.timedOut) {
    console.error(`failed_stage=${label}${fid ? ` feature_id=${fid}` : ''} timed_out=1`);
  } else if (!ok) {
    console.error(
      `failed_stage=${label}${fid ? ` feature_id=${fid}` : ''} agent_exit_${r.code ?? 1}`
    );
  }
  return {
    ok,
    skipped: false,
    code: r.timedOut ? 3 : r.code,
    reason: r.timedOut ? 'agent_timed_out' : ok ? '' : `agent_exit_${r.code ?? 1}`,
  };
}

module.exports = { invokeAiCode3Agent, stageLabelForLog };
