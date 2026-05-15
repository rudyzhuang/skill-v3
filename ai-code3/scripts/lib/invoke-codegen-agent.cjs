'use strict';

const { runWithTimeout } = require('./run-with-timeout.cjs');

/**
 * §7.8：调用外部 Agent 二进制（由团队提供）；无二进制则 skipped。
 * 环境变量：`AI_CODE3_AGENT_BIN` 或兼容 `AI_CODEGEN_AGENT_BIN`。
 * 子进程 env：`AI_CODE3_PHASE`、`AI_CODE3_WORKTREE`、`AI_CODE3_PROJECT`。
 */
async function invokeCodegenAgent({ worktreePath, projectRoot, phase, timeoutMs }) {
  const bin =
    process.env.AI_CODE3_AGENT_BIN ||
    process.env.AI_CODEGEN_AGENT_BIN ||
    '';
  if (!bin.trim()) {
    return { ok: false, skipped: true, code: 0, reason: 'no_agent_bin' };
  }
  const r = await runWithTimeout(bin, [], {
    cwd: worktreePath,
    timeoutMs,
    env: {
      ...process.env,
      AI_CODE3_PHASE: phase,
      AI_CODE3_WORKTREE: worktreePath,
      AI_CODE3_PROJECT: projectRoot,
    },
  });
  const ok = !r.timedOut && r.code === 0;
  return {
    ok,
    skipped: false,
    code: r.timedOut ? 3 : r.code,
    reason: r.timedOut ? 'agent_timed_out' : ok ? '' : `agent_exit_${r.code}`,
  };
}

module.exports = { invokeCodegenAgent };
