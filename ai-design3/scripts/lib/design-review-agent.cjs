'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const agentIo = require('../../../scripts/lib/agent-io-log.cjs');

function resolveAgentBin() {
  const fromEnv = (process.env.AI_DESIGN_AGENT_BIN || process.env.AI_CODEGEN_AGENT_BIN || '').trim();
  if (fromEnv) {
    const parts = fromEnv.split(/\s+/);
    if (parts[0]) return { bin: parts[0], args_prefix: parts.slice(1) };
  }
  const r1 = spawnSync('sh', ['-c', 'command -v agent 2>/dev/null || command -v cursor-agent 2>/dev/null'], {
    encoding: 'utf8',
  });
  const line1 = (r1.stdout || '').trim().split('\n')[0];
  if (line1) return { bin: line1, args_prefix: [] };

  const r2 = spawnSync('sh', ['-c', 'command -v cursor 2>/dev/null'], { encoding: 'utf8' });
  const cursorBin = (r2.stdout || '').trim().split('\n')[0];
  if (cursorBin) {
    const r3 = spawnSync(cursorBin, ['agent', '--help'], { encoding: 'utf8' });
    if (r3.status === 0 || (r3.stdout || '').includes('cursor agent')) {
      return { bin: cursorBin, args_prefix: ['agent'] };
    }
  }
  return null;
}

function shouldInvokeDesignReviewAgent() {
  if (process.env.AI_DESIGN_DESIGN_REVIEW_SKIP_AGENT === '1') return false;
  if (process.env.AI_DESIGN_SKIP_AGENT === '1') return false;
  if (String(process.env.AI_DESIGN_DESIGN_REVIEW_JSON || '').trim()) return false;
  if (process.env.AI_DESIGN_DESIGN_REVIEW_USE_STUB === '1') return false;
  return process.env.AI_DESIGN_DESIGN_REVIEW_USE_AGENT === '1';
}

function buildDesignReviewPrompt({ featureId, projectRoot, outputPath, schemaPath }) {
  return [
    `执行 ai-design3 design-review（feature_id=${featureId}）。`,
    '',
    '## 约定',
    '- 只读评审；不得修改 docs/contracts/ 与 docs/designs/ 下文件。',
    `- 将 JSON 写入: ${outputPath}`,
    `- Schema: ${schemaPath}`,
    '- 须含 feature_id、outputs.decision、outputs.alignment_summary、gaps[]。',
    '',
    '## 项目根',
    projectRoot,
    '',
    '详细规则见 skill prompts/design-review.md。',
  ].join('\n');
}

function writeStubDesignReviewOutput(outputPath, featureId) {
  const payload = {
    feature_id: featureId,
    outputs: {
      decision: 'passed',
      alignment_summary: 'Stub: design-review agent skipped (AI_DESIGN_DESIGN_REVIEW_USE_STUB=1).',
    },
    gaps: [],
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

/**
 * 单 feature 调用外部 Agent；不写 stages（由调用方维护 feature.status）
 */
function runDesignReviewAgentForFeature({
  projectRoot,
  worktreePath,
  featureId,
  sessionId,
  skillRoot,
}) {
  const fid = String(featureId || '').trim();
  const outDir = path.join(projectRoot, '.agent-sessions');
  fs.mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `design-review-out-${fid}-${crypto.randomBytes(4).toString('hex')}.json`);
  const schemaPath = path.join(skillRoot, 'templates', 'schemas', 'design-review-output.v1.schema.json');

  if (process.env.AI_DESIGN_DESIGN_REVIEW_USE_STUB === '1') {
    writeStubDesignReviewOutput(outputPath, fid);
    return { ran: true, ok: true, outputPath, stub: true };
  }

  const resolved = resolveAgentBin();
  const promptRefStr = agentIo.promptRef({
    skill: 'ai-design3',
    relPath: 'prompts/design-review.md',
  });

  if (!resolved) {
    agentIo.logAgentIo(projectRoot, 'skip', {
      skill: 'ai-design3',
      stageKey: 'design_review',
      phase: 'design_review_agent',
      featureId: fid,
      sessionId,
      reason: 'no_agent_bin',
      promptRef: promptRefStr,
    });
    return { ran: false, ok: false, reason: 'no_agent_bin', outputPath: null };
  }

  const timeoutSec = Number(process.env.AI_DESIGN_DESIGN_REVIEW_TIMEOUT_S || 0);
  const configPath = path.join(projectRoot, 'docs', 'config.dev.json');
  let timeoutMs = 600000;
  if (timeoutSec > 0) timeoutMs = timeoutSec * 1000;
  else if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const sec = cfg?.timeouts?.stages?.design_review_s;
      if (typeof sec === 'number' && sec > 0) timeoutMs = sec * 1000;
    } catch {
      /* ignore */
    }
  }

  const prompt = buildDesignReviewPrompt({
    featureId: fid,
    projectRoot,
    outputPath,
    schemaPath,
  });

  const { bin, args_prefix } = resolved;
  const args = [
    ...args_prefix,
    '--workspace',
    worktreePath || projectRoot,
    '--print',
    '--trust',
    '--force',
  ];
  if (process.env.AI_CODEGEN_AGENT_MODEL) args.push('--model', process.env.AI_CODEGEN_AGENT_MODEL);
  args.push(prompt);

  const env = {
    ...process.env,
    AI_DESIGN_PHASE: 'design_review',
    AI_DESIGN_FEATURE_ID: fid,
    AI_DESIGN_PROJECT: projectRoot,
    AI_DESIGN_DESIGN_REVIEW_OUTPUT: outputPath,
  };

  const { callId } = agentIo.logAgentIo(projectRoot, 'begin', {
    skill: 'ai-design3',
    stageKey: 'design_review',
    phase: 'design_review_agent',
    featureId: fid,
    sessionId: sessionId || process.env.AI_SESSION_ID,
    agentBin: bin,
    promptRef: promptRefStr,
    promptSha: agentIo.sha256Short(prompt),
    outputPath,
    argvSummary: 'agent --workspace … --print --trust --force <prompt>',
  });

  const t0 = Date.now();
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined,
    env,
    cwd: worktreePath || projectRoot,
  });
  const elapsed = Date.now() - t0;

  if (r.error && r.error.code === 'ETIMEDOUT') {
    agentIo.logAgentIo(projectRoot, 'end', {
      skill: 'ai-design3',
      stageKey: 'design_review',
      phase: 'design_review_agent',
      featureId: fid,
      sessionId,
      callId,
      agentBin: bin,
      promptRef: promptRefStr,
      elapsedMs: elapsed,
      ok: false,
      reason: 'agent timeout',
    });
    return { ran: true, ok: false, reason: 'agent timeout', outputPath, timedOut: true };
  }

  const status = typeof r.status === 'number' ? r.status : 1;
  const ok = status === 0 && fs.existsSync(outputPath);
  agentIo.logAgentIo(projectRoot, 'end', {
    skill: 'ai-design3',
    stageKey: 'design_review',
    phase: 'design_review_agent',
    featureId: fid,
    sessionId,
    callId,
    agentBin: bin,
    promptRef: promptRefStr,
    elapsedMs: elapsed,
    exitCode: status,
    ok,
    reason: ok ? '' : `agent exit ${status}`,
    stdout: r.stdout,
    stderr: r.stderr,
    outputPath,
    outputSummary: ok ? agentIo.summarizeJsonFile(outputPath) : undefined,
  });

  return {
    ran: true,
    ok,
    reason: ok ? undefined : `agent exit ${status}`,
    outputPath,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

module.exports = {
  resolveAgentBin,
  shouldInvokeDesignReviewAgent,
  buildDesignReviewPrompt,
  runDesignReviewAgentForFeature,
  writeStubDesignReviewOutput,
};
