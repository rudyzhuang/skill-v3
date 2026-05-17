'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * 与 ai-auto3 autorun.cjs `resolveCode3AgentBin` 对齐的探测顺序。
 * @param {{ pipeline?: { autorun?: { code3_agent_bin?: string } } }} [cfg] 可选 config.dev.json 片段
 * @returns {string} 可执行路径，未找到则 ''
 */
function detectCursorAgentBin(cfg) {
  const configured = String(cfg?.pipeline?.autorun?.code3_agent_bin || '').trim();
  if (configured) return configured;

  const envPrimary = String(process.env.AI_CODE3_AGENT_BIN || '').trim();
  if (envPrimary) return envPrimary;

  const envLegacy = String(process.env.AI_CODEGEN_AGENT_BIN || '').trim();
  if (envLegacy) return envLegacy;

  const home = String(process.env.HOME || '').trim();
  if (home) {
    const localBin = path.join(home, '.local', 'bin', 'cursor-agent');
    try {
      if (fs.existsSync(localBin)) return localBin;
    } catch {
      /* ignore */
    }
  }

  for (const sh of ['zsh', 'bash']) {
    const probe = spawnSync(sh, ['-lc', 'command -v cursor-agent'], {
      encoding: 'utf8',
    });
    if (probe.status !== 0) continue;
    const resolved = String(probe.stdout || '').trim();
    if (resolved) return resolved;
  }

  return '';
}

/** E2E 默认与 codegen 共用 cursor-agent；可被环境变量覆盖。 */
function detectE2eAgentBin(code3Bin) {
  const explicit = String(process.env.AI_E2E3_AGENT_BIN || '').trim();
  if (explicit) return explicit;
  return code3Bin || '';
}

function shellSingleQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

module.exports = {
  detectCursorAgentBin,
  detectE2eAgentBin,
  shellSingleQuote,
};
