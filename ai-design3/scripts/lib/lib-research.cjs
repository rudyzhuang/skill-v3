'use strict';

/**
 * ai-design3 · lib-research（自 ai-design2 P2.5 移植，路径与 V3 设计文件对齐）
 *
 * 环境变量（与 v2 兼容）：
 *   AI_DESIGN_SKIP_LIB_RESEARCH=1
 *   AI_DESIGN_LIB_RESEARCH_WEB_SEARCH=1
 *   AI_DESIGN_LIB_RESEARCH_READ_DOCS=1
 *   AI_DESIGN_LIB_RESEARCH_CACHE_TTL_DAYS=30
 *   AI_CODEGEN_AGENT_BIN
 *   AI_CODEGEN_AGENT_TIMEOUT_MS
 *   AI_CODEGEN_AGENT_MODEL
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const agentIo = require('../../../scripts/lib/agent-io-log.cjs');

function normalizeCacheKey(functionArea) {
  return String(functionArea || '')
    .toLowerCase()
    .replace(/[()'"\/\\【】「」『』〔〕]/g, '')
    .replace(/[与和及、，,\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function detectPrimaryLanguage(projectRoot) {
  if (fs.existsSync(path.join(projectRoot, 'package.json'))) return 'typescript';
  if (
    fs.existsSync(path.join(projectRoot, 'pyproject.toml')) ||
    fs.existsSync(path.join(projectRoot, 'requirements.txt'))
  ) {
    return 'python';
  }
  if (fs.existsSync(path.join(projectRoot, 'go.mod'))) return 'go';
  if (fs.existsSync(path.join(projectRoot, 'Cargo.toml'))) return 'rust';
  return 'unknown';
}

/**
 * V3 design：api_outline[] + file_plan.new_files/modify_files（路径字符串）
 */
function identifyFunctionAreas(designSpec) {
  const seen = new Set();
  const areas = [];
  const push = (raw) => {
    const t = String(raw || '').trim();
    if (t && !seen.has(t)) {
      seen.add(t);
      areas.push(t);
    }
  };

  if (Array.isArray(designSpec.api_outline)) {
    for (const route of designSpec.api_outline) {
      if (!route || typeof route !== 'object') continue;
      push(
        route.handler ||
          route.operation_id ||
          route.operationId ||
          route.name ||
          route.summary ||
          route.path
      );
    }
  }

  if (designSpec.file_plan && typeof designSpec.file_plan === 'object') {
    for (const key of ['new_files', 'modify_files']) {
      const arr = designSpec.file_plan[key];
      if (!Array.isArray(arr)) continue;
      for (const p of arr) {
        if (typeof p !== 'string') continue;
        const base = path.basename(p).replace(/\.[^.]+$/, '');
        if (base) push(`${key}:${base}`);
      }
    }
  }

  return areas;
}

function cacheFileAbs(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'lib-research-cache.json');
}

function loadCache(projectRoot) {
  const p = cacheFileAbs(projectRoot);
  if (!fs.existsSync(p)) return { version: '1', entries: {} };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return { version: '1', entries: {} };
  }
}

function saveCache(projectRoot, cache) {
  const p = cacheFileAbs(projectRoot);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  cache.updated_at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  fs.writeFileSync(p, JSON.stringify(cache, null, 2) + '\n', 'utf8');
}

function getCacheTtlDays() {
  const v = parseInt(process.env.AI_DESIGN_LIB_RESEARCH_CACHE_TTL_DAYS || '30', 10);
  return Number.isFinite(v) && v > 0 ? v : 30;
}

function upsertCache(projectRoot, cache, decision, featureId) {
  const key = decision.cache_key;
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const ttl = getCacheTtlDays();
  const expires = new Date(Date.now() + ttl * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z');

  const existing = (cache.entries || {})[key];
  if (!cache.entries) cache.entries = {};
  cache.entries[key] = {
    original_name: decision.function_area,
    cached_at: existing ? existing.cached_at : now,
    expires_at: expires,
    decision: {
      strategy: decision.strategy,
      selected_library: decision.selected_library,
      selected_version: decision.selected_version,
      license: decision.license,
      doc_url: decision.doc_url,
      install: decision.install,
      usage_pattern: decision.usage_pattern,
      needs_human_review: decision.needs_human_review,
      constraints_added: decision.constraints_added || [],
    },
    used_by: [...new Set([...(existing ? existing.used_by || [] : []), featureId])],
  };
  if (!cache.cache_ttl_days) cache.cache_ttl_days = ttl;
  saveCache(projectRoot, cache);
}

function resolveAgentBin() {
  if (process.env.AI_CODEGEN_AGENT_BIN) {
    const parts = process.env.AI_CODEGEN_AGENT_BIN.trim().split(/\s+/);
    if (parts.length > 0 && parts[0]) {
      return { bin: parts[0], args_prefix: parts.slice(1) };
    }
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

function buildLibResearchPrompt({
  featureId,
  featureName,
  techStack,
  designSpecPath,
  outputPath,
  cacheFilePath,
  functionAreas,
  schemaPath,
}) {
  const webSearch = process.env.AI_DESIGN_LIB_RESEARCH_WEB_SEARCH !== '0' ? '1' : '0';
  const readDocs = process.env.AI_DESIGN_LIB_RESEARCH_READ_DOCS !== '0' ? '1' : '0';
  const ttlDays = getCacheTtlDays();

  const areasBlock =
    functionAreas.length > 0
      ? functionAreas.map((a, i) => `  ${i + 1}. ${a}`).join('\n')
      : '  （未识别到函数域：请补充 design.json 的 api_outline 或 file_plan）';

  return [
    `执行 ai-design3 lib-research，为 feature ${featureId}（${featureName || ''}）的每个函数域选择第三方库或自研策略。`,
    '',
    '## 控制参数',
    `- AI_DESIGN_LIB_RESEARCH_WEB_SEARCH=${webSearch}`,
    `- AI_DESIGN_LIB_RESEARCH_READ_DOCS=${readDocs}`,
    `- 缓存 TTL: ${ttlDays} 天`,
    '',
    '## 输入',
    `- design.json: ${designSpecPath}`,
    `- 项目级缓存: ${cacheFilePath}`,
    '',
    '## 预识别函数域',
    areasBlock,
    '',
    `## 技术栈探测: ${techStack}`,
    '',
    '## 输出',
    `写入 JSON 文件: ${outputPath}`,
    `必须符合 schema: ${schemaPath}`,
    '',
    '完成后将 constraints_added 汇总；研究流程细节见原 ai-design2 lib-research 约定。',
  ].join('\n');
}

function runLibResearchAgent({ projectRoot, worktreePath, prompt, featureId, sessionId, outputPath }) {
  const resolved = resolveAgentBin();
  const promptRefStr = agentIo.promptRef({
    skill: 'ai-design3',
    relPath: 'scripts/lib/lib-research.cjs',
    symbol: 'buildLibResearchPrompt',
  });
  if (!resolved) {
    if (projectRoot) {
      agentIo.logAgentIo(projectRoot, 'skip', {
        skill: 'ai-design3',
        stageKey: 'design',
        phase: 'lib_research',
        featureId,
        sessionId,
        reason: 'no_agent_bin',
        promptRef: promptRefStr,
      });
    }
    return { ran: false, ok: false, reason: 'no agent binary (install Cursor CLI or set AI_CODEGEN_AGENT_BIN)' };
  }
  const { bin, args_prefix } = resolved;
  const timeout = Number(process.env.AI_CODEGEN_AGENT_TIMEOUT_MS || 600000);
  const args = [...args_prefix, '--workspace', worktreePath, '--print', '--trust', '--force'];
  if (process.env.AI_CODEGEN_AGENT_MODEL) {
    args.push('--model', process.env.AI_CODEGEN_AGENT_MODEL);
  }
  args.push(prompt);

  const { callId } = projectRoot
    ? agentIo.logAgentIo(projectRoot, 'begin', {
        skill: 'ai-design3',
        stageKey: 'design',
        phase: 'lib_research',
        featureId,
        sessionId: sessionId || process.env.AI_SESSION_ID,
        agentBin: bin,
        promptRef: promptRefStr,
        promptSha: agentIo.sha256Short(prompt),
        promptDynamic: featureId ? `feature_id=${featureId}` : '',
        outputPath,
        argvSummary: 'agent --workspace … --print --trust --force <prompt>',
      })
    : { callId: '' };

  const t0 = Date.now();
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : undefined,
    env: { ...process.env },
  });
  const elapsed = Date.now() - t0;

  if (r.error && r.error.code === 'ETIMEDOUT') {
    if (projectRoot) {
      agentIo.logAgentIo(projectRoot, 'end', {
        skill: 'ai-design3',
        stageKey: 'design',
        phase: 'lib_research',
        featureId,
        sessionId,
        callId,
        agentBin: bin,
        promptRef: promptRefStr,
        elapsedMs: elapsed,
        ok: false,
        reason: 'agent timeout',
        stdout: r.stdout,
        stderr: r.stderr,
      });
    }
    return { ran: true, ok: false, reason: 'agent timeout' };
  }
  const status = typeof r.status === 'number' ? r.status : 1;
  const ok = status === 0;
  if (projectRoot) {
    agentIo.logAgentIo(projectRoot, 'end', {
      skill: 'ai-design3',
      stageKey: 'design',
      phase: 'lib_research',
      featureId,
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
      outputSummary: outputPath && fs.existsSync(outputPath) ? agentIo.summarizeJsonFile(outputPath) : undefined,
    });
  }
  return { ran: true, ok, reason: ok ? undefined : `agent exit ${status}` };
}

function generateStub({ featureId, featureName, techStack, functionAreas }) {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const decisions = functionAreas.map((area) => ({
    function_area: area,
    cache_key: normalizeCacheKey(area),
    strategy: 'fallback_algorithm',
    candidates_evaluated: [],
    selected_library: null,
    selected_version: null,
    license: null,
    doc_url: null,
    doc_fetch_failed: false,
    doc_summary: null,
    install: null,
    usage_pattern: null,
    rationale: 'Stub: Agent CLI not available; needs human review',
    algorithm_pseudocode: '// TODO: implement manually',
    needs_human_review: true,
    cache_hit: false,
    constraints_added: [],
  }));
  return {
    feature_id: featureId,
    feature_name: featureName || '',
    tech_stack: techStack,
    researched_at: now,
    decisions,
    packages_to_install: [],
    web_search_performed: false,
    docs_read: [],
    has_fallback_algorithms: decisions.length > 0,
    cache_hits: 0,
  };
}

function patchDesignSpec(designSpecPath, libResearch, featureId) {
  let spec;
  try {
    spec = JSON.parse(fs.readFileSync(designSpecPath, 'utf8'));
  } catch (e) {
    throw new Error(`Cannot parse design json: ${e.message}`);
  }

  const newConstraints = [];
  for (const d of libResearch.decisions || []) {
    for (const c of d.constraints_added || []) {
      if (c && !newConstraints.includes(c)) {
        newConstraints.push(c);
      }
    }
  }

  const existing = Array.isArray(spec.constraints) ? spec.constraints : [];
  for (const c of newConstraints) {
    if (!existing.includes(c)) {
      existing.push(c);
    }
  }
  spec.constraints = existing;

  const ref = `docs/designs/${featureId}.lib-research.json`;
  spec.library_decisions = {
    ref,
    packages_to_install: libResearch.packages_to_install || [],
    has_fallback_algorithms: !!libResearch.has_fallback_algorithms,
    summary: (libResearch.decisions || []).map((d) => ({
      function_area: d.function_area,
      library: d.selected_library
        ? `${d.selected_library}${d.selected_version ? '@' + d.selected_version : ''}`
        : null,
      strategy: d.strategy,
      needs_human_review: d.needs_human_review,
    })),
  };

  fs.writeFileSync(designSpecPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
}

/**
 * @param {{ projectRoot: string, featureId: string, featureName?: string, designSpecPath: string, outputPath: string, force?: boolean, skillRoot: string, dryRun?: boolean, validateJson?: (v:any,data:any,label:string)=>{ok:boolean,errors:string[]}, validateLibResearch?: any }} opts
 */
function runLibResearch(opts) {
  const {
    projectRoot,
    featureId,
    featureName,
    designSpecPath,
    outputPath,
    force,
    skillRoot,
    dryRun,
    validateJson,
    validateLibResearch,
  } = opts;

  if (process.env.AI_DESIGN_SKIP_LIB_RESEARCH === '1') {
    return { ok: true, status: 'skipped', reason: 'AI_DESIGN_SKIP_LIB_RESEARCH=1' };
  }

  let designSpec;
  try {
    designSpec = JSON.parse(fs.readFileSync(designSpecPath, 'utf8'));
  } catch (e) {
    return { ok: false, status: 'failed', reason: `cannot parse design json: ${e.message}` };
  }

  const functionAreas = identifyFunctionAreas(designSpec);
  if (functionAreas.length === 0) {
    return {
      ok: true,
      status: 'skipped',
      reason: 'no function_areas identified (add api_outline or file_plan paths)',
    };
  }

  const techStack = detectPrimaryLanguage(projectRoot);
  const schemaPath = path.join(skillRoot, 'templates', 'schemas', 'lib-research.v3.schema.json');
  const cacheFilePath = cacheFileAbs(projectRoot);

  if (dryRun) {
    const stub = generateStub({ featureId, featureName, techStack, functionAreas });
    return { ok: true, status: 'done', artifact: stub, dry_run: true };
  }

  if (process.env.AI_DESIGN_LIB_RESEARCH_USE_STUB === '1') {
    const stub = generateStub({ featureId, featureName, techStack, functionAreas });
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify(stub, null, 2) + '\n', 'utf8');
    try {
      patchDesignSpec(designSpecPath, stub, featureId);
    } catch (e) {
      process.stderr.write(`[lib-research] design patch error: ${e.message}\n`);
      return { ok: false, status: 'failed', reason: e.message };
    }
    try {
      const cache = loadCache(projectRoot);
      for (const decision of stub.decisions || []) {
        upsertCache(projectRoot, cache, decision, featureId);
      }
    } catch (e) {
      process.stderr.write(`[lib-research] cache update error (non-fatal): ${e.message}\n`);
    }
    return { ok: true, status: 'done', artifact: stub };
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  if (!force && fs.existsSync(outputPath)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (existing.feature_id === featureId) {
        if (validateJson && validateLibResearch) {
          const vr = validateJson(validateLibResearch, existing, 'lib-research.json');
          if (!vr.ok) {
            process.stderr.write(`[lib-research] existing file failed schema; regenerating: ${vr.errors.join('; ')}\n`);
          } else {
            process.stderr.write(`[lib-research] reusing existing file for ${featureId}\n`);
            try {
              patchDesignSpec(designSpecPath, existing, featureId);
            } catch (e) {
              return { ok: false, status: 'failed', reason: `reuse: design patch failed: ${e.message}` };
            }
            return { ok: true, status: 'done', artifact: existing };
          }
        } else {
          process.stderr.write(`[lib-research] reusing existing file for ${featureId}\n`);
          try {
            patchDesignSpec(designSpecPath, existing, featureId);
          } catch (e) {
            return { ok: false, status: 'failed', reason: `reuse: design patch failed: ${e.message}` };
          }
          return { ok: true, status: 'done', artifact: existing };
        }
      }
    } catch {
      /* regenerate */
    }
  }

  const prompt = buildLibResearchPrompt({
    featureId,
    featureName,
    techStack,
    designSpecPath,
    outputPath,
    cacheFilePath,
    functionAreas,
    schemaPath,
  });

  const agentResult = runLibResearchAgent({
    projectRoot,
    worktreePath: projectRoot,
    prompt,
    featureId,
    outputPath,
    sessionId: process.env.AI_SESSION_ID,
  });

  let libResearch;

  if (agentResult.ok && fs.existsSync(outputPath)) {
    try {
      libResearch = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      if (validateJson && validateLibResearch) {
        const vr = validateJson(validateLibResearch, libResearch, 'lib-research.json');
        if (!vr.ok) {
          process.stderr.write(`[lib-research] schema errors: ${vr.errors.join('; ')}; falling back to stub\n`);
          libResearch = null;
        }
      }
    } catch (e) {
      process.stderr.write(`[lib-research] parse error: ${e.message}; falling back to stub\n`);
    }
  } else if (!agentResult.ran || !agentResult.ok) {
    process.stderr.write(
      `[lib-research] agent not available or failed (${agentResult.reason || 'unknown'}); generating stub\n`
    );
  }

  if (!libResearch) {
    libResearch = generateStub({ featureId, featureName, techStack, functionAreas });
    fs.writeFileSync(outputPath, JSON.stringify(libResearch, null, 2) + '\n', 'utf8');
  }

  try {
    patchDesignSpec(designSpecPath, libResearch, featureId);
    process.stderr.write(`[lib-research] patched design.json (library_decisions + constraints)\n`);
  } catch (e) {
    return { ok: false, status: 'failed', reason: `design patch failed: ${e.message}` };
  }

  try {
    const cache = loadCache(projectRoot);
    if (force) {
      for (const k of Object.keys(cache.entries || {})) {
        if ((cache.entries[k].used_by || []).includes(featureId)) {
          cache.entries[k].used_by = cache.entries[k].used_by.filter((id) => id !== featureId);
        }
      }
    }
    for (const decision of libResearch.decisions || []) {
      if (!decision.cache_hit) {
        upsertCache(projectRoot, cache, decision, featureId);
      }
    }
  } catch (e) {
    process.stderr.write(`[lib-research] cache update error (non-fatal): ${e.message}\n`);
  }

  const hasReview = (libResearch.decisions || []).some((d) => d.needs_human_review);
  if (hasReview) {
    const lines = (libResearch.decisions || [])
      .filter((d) => d.needs_human_review)
      .map((d) => `  - ${d.function_area} (${d.strategy})`)
      .join('\n');
    process.stderr.write(`[lib-research] needs human review:\n${lines}\n`);
  }

  return { ok: true, status: 'done', artifact: libResearch };
}

module.exports = {
  runLibResearch,
  identifyFunctionAreas,
  detectPrimaryLanguage,
  patchDesignSpec,
  normalizeCacheKey,
};
