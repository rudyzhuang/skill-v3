'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { assertCodegenGates } = require('./lib/codegen-gates.cjs');
const worktreeLib = require('./lib/codegen-worktree.cjs');
const scaffold = require('./lib/codegen-scaffold.cjs');
const healthFull = require('./lib/codegen-health-full-scaffold.cjs');
const { invokeCodegenAgent } = require('./lib/invoke-codegen-agent.cjs');
const { appendHeartbeat } = require('./lib/session-log.cjs');
const { writeTerminal } = require('./lib/stage-terminal.cjs');

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function stageTimeoutMs(config, key, fallbackSec) {
  const sec = config?.timeouts?.stages?.[key];
  if (typeof sec === 'number' && sec > 0) return sec * 1000;
  return fallbackSec * 1000;
}

function gatherFeatureIds(doc, options) {
  if (options.featureIds?.length) return options.featureIds;
  const phases = doc.stages?.prd_review?.review?.phase_plan || [];
  const ids = [];
  for (const p of phases) {
    for (const id of p.feature_ids || []) ids.push(String(id));
  }
  return ids;
}

function resolveFeatureIds(doc, options) {
  const ids = gatherFeatureIds(doc, options);
  if (ids.length) return ids;
  const art = doc.stages?.contract?.outputs?.artifacts?.[0];
  if (art?.feature_id) return [String(art.feature_id)];
  return ['default'];
}

const CONTRACT_KEYS = ['types', 'api', 'schema', 'test_spec', 'design_snapshot'];

function collectContractRelPaths(projectRoot, doc) {
  const arts = doc.stages?.contract?.outputs?.artifacts || [];
  if (arts.length === 0) {
    throw new Error('contract.outputs.artifacts[] empty');
  }
  const art = arts[0];
  const paths = [];
  for (const k of CONTRACT_KEYS) {
    const rel = art[k];
    if (typeof rel !== 'string' || !rel.trim()) {
      throw new Error(`contract artifact missing non-empty path for key "${k}"`);
    }
    const full = path.join(projectRoot, rel);
    if (!fs.existsSync(full)) {
      throw new Error(`contract artifact path missing: ${rel}`);
    }
    paths.push(rel);
  }
  return { relPaths: paths, firstArtifact: art };
}

function runDiffGuard(repoRoot, relPaths) {
  const inside = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status !== 0 || String(inside.stdout || '').trim() !== 'true') {
    return { exit: 1, reason: 'not_a_git_work_tree' };
  }
  if (relPaths.length === 0) return { exit: 1, reason: 'no_paths' };
  const r = spawnSync('git', ['-C', repoRoot, 'diff', '--exit-code', '--', ...relPaths], {
    encoding: 'utf8',
  });
  if (r.status === 0) return { exit: 0 };
  if (r.status === 1) return { exit: 5, reason: 'dirty_contract_paths' };
  return { exit: 1, reason: r.stderr || 'git_diff_failed' };
}

function ensureGitRepoForCodegen(projectRoot, baseBranch) {
  const inside = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status === 0 && String(inside.stdout || '').trim() === 'true') return { ok: true };

  const init = spawnSync('git', ['-C', projectRoot, 'init'], { encoding: 'utf8' });
  if (init.status !== 0) {
    const recheck = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    if (recheck.status === 0 && String(recheck.stdout || '').trim() === 'true') {
      return { ok: true };
    }
    return { ok: false, reason: init.stderr || 'git_init_failed' };
  }

  const target = baseBranch || 'main';
  const cur = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const currentBranch = String(cur.stdout || '').trim();
  if (!currentBranch || currentBranch !== target) {
    const chk = spawnSync('git', ['-C', projectRoot, 'checkout', '-B', target], { encoding: 'utf8' });
    if (chk.status !== 0) {
      return { ok: false, reason: chk.stderr || 'git_checkout_base_failed' };
    }
  }

  spawnSync('git', ['-C', projectRoot, 'add', '-A'], { encoding: 'utf8' });
  const hasHead = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8' });
  if (hasHead.status !== 0) {
    const commit = spawnSync(
      'git',
      ['-C', projectRoot, 'commit', '--allow-empty', '-m', 'chore: initialize repository for ai-code3 autorun'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'ai-code3',
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'ai-code3@local',
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'ai-code3',
          GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'ai-code3@local',
        },
      }
    );
    if (commit.status !== 0) {
      return { ok: false, reason: commit.stderr || commit.stdout || 'git_initial_commit_failed' };
    }
  }
  return { ok: true };
}

function baseBranchFromDoc(doc, config) {
  return (
    config.git?.default_branch ||
    doc.project?.git?.default_branch ||
    doc.stages?.merge_push?.inputs?.target_branch ||
    'main'
  );
}

function shouldSkipTestAgentPhase(testSpecAbs) {
  if (process.env.AI_CODE3_SKIP_TEST_CODEGEN === '1') return true;
  if (!testSpecAbs || !fs.existsSync(testSpecAbs)) return false;
  try {
    const j = JSON.parse(fs.readFileSync(testSpecAbs, 'utf8'));
    if (j && j.generate_tests === false) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function writeIfMissing(absPath, content) {
  if (fs.existsSync(absPath)) {
    try {
      const prev = fs.readFileSync(absPath, 'utf8');
      if (prev === content) return false;
    } catch {
      /* ignore and overwrite */
    }
  }
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return true;
}

function ensureNoAgentHealthScaffold(worktreePath) {
  let touched = 0;
  const pkg = {
    name: 'health-minimal-app',
    version: '0.1.0',
    private: true,
    scripts: {
      'start:backend': 'node backend/server.cjs',
      'start:website': 'node website/server.cjs',
      test: 'node tests/health.test.cjs',
      build: 'node scripts/build.cjs',
    },
  };
  if (writeIfMissing(path.join(worktreePath, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`)) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'backend', 'server.cjs'),
      `'use strict';\n` +
        `const http = require('http');\n` +
        `const PORT = Number(process.env.BACKEND_PORT || 3001);\n` +
        `const server = http.createServer((req, res) => {\n` +
        `  if (req.method === 'GET' && req.url && req.url.startsWith('/api/')) {\n` +
        `    const now = new Date().toISOString();\n` +
        `    const routes = {\n` +
        `      '/api/health': { status: 'healthy', service: 'backend', timestamp: now },\n` +
        `      '/api/version': { version: '0.1.0', build: 'no-agent-scaffold', timestamp: now },\n` +
        `      '/api/time': { now, timezone: 'UTC' },\n` +
        `      '/api/ping': { pong: true, timestamp: now }\n` +
        `    };\n` +
        `    if (routes[req.url]) {\n` +
        `      res.setHeader('Content-Type', 'application/json');\n` +
        `      res.setHeader('Access-Control-Allow-Origin', '*');\n` +
        `      res.end(JSON.stringify(routes[req.url]));\n` +
        `      return;\n` +
        `    }\n` +
        `  }\n` +
        `  res.statusCode = 404;\n` +
        `  res.end('not found');\n` +
        `});\n` +
        `server.listen(PORT, () => console.log('backend listening on', PORT));\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'index.html'),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Health</title></head>\n` +
        `<body><h1>Health Home</h1><p>请选择页面：</p><ul>` +
        `<li><a href="/page-health.html">Health</a></li>` +
        `<li><a href="/page-version.html">Version</a></li>` +
        `<li><a href="/page-time.html">Time</a></li>` +
        `<li><a href="/page-ping.html">Ping</a></li>` +
        `</ul></body></html>\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'page-health.html'),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Health Page</title></head>\n` +
        `<body data-endpoint="/api/health"><h1>Health Page</h1><a href="/">Back Home</a><pre id="out">loading...</pre><script src="/app.js"></script></body></html>\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'page-version.html'),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Version Page</title></head>\n` +
        `<body data-endpoint="/api/version"><h1>Version Page</h1><a href="/">Back Home</a><pre id="out">loading...</pre><script src="/app.js"></script></body></html>\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'page-time.html'),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Time Page</title></head>\n` +
        `<body data-endpoint="/api/time"><h1>Time Page</h1><a href="/">Back Home</a><pre id="out">loading...</pre><script src="/app.js"></script></body></html>\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'page-ping.html'),
      `<!doctype html>\n<html><head><meta charset="utf-8"><title>Ping Page</title></head>\n` +
        `<body data-endpoint="/api/ping"><h1>Ping Page</h1><a href="/">Back Home</a><pre id="out">loading...</pre><script src="/app.js"></script></body></html>\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'app.js'),
      `(async function(){\n` +
        `  const out = document.getElementById('out');\n` +
        `  if (!out) return;\n` +
        `  const base = window.BACKEND_BASE_URL || 'http://localhost:3001';\n` +
        `  const endpoint = document.body.getAttribute('data-endpoint') || '/api/health';\n` +
        `  try {\n` +
        `    const r = await fetch(base + endpoint);\n` +
        `    const j = await r.json();\n` +
        `    out.textContent = JSON.stringify(j, null, 2);\n` +
        `  } catch (e) {\n` +
        `    out.textContent = 'error: ' + (e && e.message ? e.message : String(e));\n` +
        `  }\n` +
        `})();\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'website', 'server.cjs'),
      `'use strict';\n` +
        `const http = require('http');\n` +
        `const fs = require('fs');\n` +
        `const path = require('path');\n` +
        `const PORT = Number(process.env.WEBSITE_PORT || 3000);\n` +
        `const root = __dirname;\n` +
        `http.createServer((req, res) => {\n` +
        `  const p = req.url === '/' ? '/index.html' : req.url;\n` +
        `  const abs = path.join(root, p.replace(/^\\//, ''));\n` +
        `  if (!abs.startsWith(root) || !fs.existsSync(abs)) { res.statusCode = 404; res.end('not found'); return; }\n` +
        `  if (abs.endsWith('.js')) res.setHeader('Content-Type', 'text/javascript');\n` +
        `  if (abs.endsWith('.html')) res.setHeader('Content-Type', 'text/html; charset=utf-8');\n` +
        `  res.end(fs.readFileSync(abs));\n` +
        `}).listen(PORT, () => console.log('website listening on', PORT));\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'tests', 'health.test.cjs'),
      `'use strict';\n` +
        `const { spawn } = require('child_process');\n` +
        `const http = require('http');\n` +
        `const child = spawn(process.execPath, ['backend/server.cjs'], { stdio: 'ignore' });\n` +
        `function req(pathname){\n` +
        `  return new Promise((resolve,reject)=>{\n` +
        `    const r = http.request({ host:'127.0.0.1', port:3001, path:pathname, method:'GET' }, (res)=>{\n` +
        `      let b=''; res.on('data',c=>b+=c); res.on('end',()=>resolve({status:res.statusCode, body:b}));\n` +
        `    });\n` +
        `    r.on('error',reject); r.end();\n` +
        `  });\n` +
        `}\n` +
        `(async()=>{\n` +
        `  try {\n` +
        `    await new Promise(r=>setTimeout(r, 400));\n` +
        `    const res = await req('/api/health');\n` +
        `    if (res.status !== 200) throw new Error('status=' + res.status);\n` +
        `    const j = JSON.parse(res.body);\n` +
        `    if (j.status !== 'healthy') throw new Error('unexpected payload');\n` +
        `    process.exit(0);\n` +
        `  } catch (e) {\n` +
        `    console.error(e && e.message ? e.message : String(e));\n` +
        `    process.exit(1);\n` +
        `  } finally {\n` +
        `    child.kill('SIGTERM');\n` +
        `  }\n` +
        `})();\n`
    )
  ) touched += 1;
  if (
    writeIfMissing(
      path.join(worktreePath, 'scripts', 'build.cjs'),
      `'use strict';\n` +
        `const fs = require('fs');\n` +
        `const path = require('path');\n` +
        `const dist = path.join(process.cwd(), 'dist');\n` +
        `fs.mkdirSync(path.join(dist, 'website', 'default'), { recursive: true });\n` +
        `fs.mkdirSync(path.join(dist, 'backend', 'default'), { recursive: true });\n` +
        `fs.copyFileSync(path.join(process.cwd(), 'website', 'index.html'), path.join(dist, 'website', 'default', 'index.html'));\n` +
        `fs.copyFileSync(path.join(process.cwd(), 'website', 'app.js'), path.join(dist, 'website', 'default', 'app.js'));\n` +
        `fs.copyFileSync(path.join(process.cwd(), 'backend', 'server.cjs'), path.join(dist, 'backend', 'default', 'server.cjs'));\n` +
        `console.log('build done');\n`
    )
  ) touched += 1;
  return touched;
}

async function run(ctx) {
  const { projectRoot, options } = ctx;
  let doc;
  try {
    doc = stagesIo.readStagesSync(projectRoot);
    stagesIo.assertSchemaSupported(doc);
  } catch (e) {
    console.error(String(e.message || e));
    return 1;
  }

  const prevCg = doc.stages?.codegen;
  if (
    !options.dryRun &&
    prevCg?.status === 'completed' &&
    prevCg?.validation?.passed &&
    process.env.AI_CODE3_CODEGEN_CONFIRM !== 'yes'
  ) {
    console.error(
      'failed_stage=codegen: overwriting completed codegen requires AI_CODE3_CODEGEN_CONFIRM=yes (input-spec §7.2 / code3.md §6)'
    );
    writeTerminal(projectRoot, doc, 'codegen', 'blocked', {
      summary: 'codegen overwrite blocked pending explicit confirm',
    });
    return 1;
  }

  const gateErr = assertCodegenGates(doc);
  if (gateErr) {
    console.error(gateErr);
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'codegen', 'blocked', { summary: gateErr });
    }
    return 1;
  }

  let relPaths;
  let firstArtifact;
  try {
    const c = collectContractRelPaths(projectRoot, doc);
    relPaths = c.relPaths;
    firstArtifact = c.firstArtifact;
  } catch (e) {
    console.error(String(e.message || e));
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'codegen', 'failed', {
        summary: String(e.message || e),
      });
    }
    return 1;
  }

  const config = loadDevConfig(projectRoot);
  const base = baseBranchFromDoc(doc, config);
  const ensureRepo = ensureGitRepoForCodegen(projectRoot, base);
  if (!ensureRepo.ok) {
    console.error(`failed_stage=codegen ${ensureRepo.reason || 'ensure_git_repo_failed'}`);
    writeTerminal(projectRoot, doc, 'codegen', 'failed', {
      summary: ensureRepo.reason || 'ensure_git_repo_failed',
    });
    return 1;
  }

  const dgMain = runDiffGuard(projectRoot, relPaths);
  if (dgMain.exit !== 0) {
    if (dgMain.exit === 5) {
      console.error('failed_stage=codegen contract diff-guard failed (main worktree dirty vs HEAD)');
    } else {
      console.error(`failed_stage=codegen diff-guard: ${dgMain.reason || 'error'}`);
    }
    if (!options.dryRun) {
      doc = stagesIo.updateStage(doc, 'codegen', {
        status: 'failed',
        completed_at: new Date().toISOString(),
        validation: {
          ...doc.stages?.codegen?.validation,
          passed: false,
          contract_diff_guard_passed: dgMain.exit === 5 ? false : doc.stages?.codegen?.validation?.contract_diff_guard_passed,
          summary: dgMain.reason || 'diff-guard',
        },
        outputs: {
          ...doc.stages?.codegen?.outputs,
          duration_ms: null,
          timed_out: false,
          timeout_reason: null,
        },
      });
      stagesIo.writeStagesSync(projectRoot, doc);
    }
    return dgMain.exit;
  }

  const featureIds = resolveFeatureIds(doc, options);
  const hash = summaryHash.computeCodegenInputHash(doc, projectRoot, featureIds);

  if (options.dryRun) {
    console.error(`[dry-run] codegen ok; summary_hash would be ${hash}; features=${featureIds.join(',')}`);
    return 0;
  }

  const codegenMs = stageTimeoutMs(config, 'codegen_s', 1800);
  const subMs = Math.max(60_000, Math.floor(codegenMs / 4));
  const sessionId = options.sessionId || '';

  const wtResult = worktreeLib.ensureAllFeatureWorktrees(projectRoot, featureIds, base);
  if (!wtResult.ok) {
    console.error(`failed_stage=codegen ${wtResult.error}`);
    writeTerminal(projectRoot, doc, 'codegen', 'failed', { summary: wtResult.error });
    return 1;
  }

  const designRel = firstArtifact.design_snapshot;
  const designAbs = designRel ? path.join(projectRoot, designRel) : null;
  const testSpecAbs = firstArtifact.test_spec ? path.join(projectRoot, firstArtifact.test_spec) : null;

  for (const row of wtResult.rows) {
    const wg = runDiffGuard(row.worktree_path, relPaths);
    if (wg.exit !== 0) {
      const msg =
        wg.exit === 5
          ? 'contract diff-guard failed inside feature worktree (contracts dirty vs HEAD)'
          : wg.reason || 'worktree diff-guard';
      console.error(`failed_stage=codegen ${msg}`);
      doc = stagesIo.updateStage(doc, 'codegen', {
        status: 'failed',
        completed_at: new Date().toISOString(),
        validation: {
          ...doc.stages?.codegen?.validation,
          passed: false,
          contract_diff_guard_passed: false,
          summary: msg,
        },
      });
      stagesIo.writeStagesSync(projectRoot, doc);
      return wg.exit === 5 ? 5 : 1;
    }
    const sc = scaffold.applyScaffold(row.worktree_path, designAbs);
    if (sc.warnings.length) {
      console.error(`codegen scaffold warnings: ${sc.warnings.join('; ')}`);
    }
  }

  const skipAgent =
    process.env.AI_CODE3_SKIP_AGENT === '1' ||
    process.env.AI_CODEGEN_SKIP_AGENT === '1' ||
    (!(process.env.AI_CODE3_AGENT_BIN || '').trim() && !(process.env.AI_CODEGEN_AGENT_BIN || '').trim());
  const allowNoAgent = process.env.AI_CODE3_ALLOW_NO_AGENT_PASS === 'yes';

  let hb;
  if (sessionId) {
    appendHeartbeat(projectRoot, sessionId, 'codegen', 'start');
    hb = setInterval(() => appendHeartbeat(projectRoot, sessionId, 'codegen', 'tick'), 30_000);
  }

  let implStatus = 'pending';
  let testStatus = 'pending';
  let agentMeta = {
    mode: (process.env.AI_CODE3_AGENT_BIN || process.env.AI_CODEGEN_AGENT_BIN || '').trim()
      ? 'external_cli'
      : 'none',
    skipped: false,
    skip_reason: '',
    model: '',
  };

  try {
    if (skipAgent) {
      agentMeta = { ...agentMeta, skipped: true, skip_reason: 'AI_CODE3_SKIP_AGENT or no AI_CODE3_AGENT_BIN' };
      if (!allowNoAgent) {
        implStatus = 'skipped';
        testStatus = 'skipped';
        const now = new Date().toISOString();
        doc = stagesIo.updateStage(doc, 'codegen', {
          status: 'failed',
          completed_at: now,
          inputs: {
            ...doc.stages?.codegen?.inputs,
            summary_hash: hash,
            requires_stage: 'design_review',
          },
          outputs: {
            ...doc.stages?.codegen?.outputs,
            worktrees: wtResult.rows.map((r) => ({
              ...r,
              commit: '',
              files_expected: [],
              files_changed: [],
              test_files_expected: [],
              test_files_changed: [],
            })),
            impl_codegen_status: implStatus,
            test_codegen_status: testStatus,
            agent: agentMeta,
            duration_ms: 0,
            timed_out: false,
            timeout_reason: null,
          },
          validation: {
            ...doc.stages?.codegen?.validation,
            passed: false,
            contract_diff_guard_passed: true,
            summary: 'agent skipped without AI_CODE3_ALLOW_NO_AGENT_PASS=yes',
          },
        });
        stagesIo.writeStagesSync(projectRoot, doc);
        console.error('failed_stage=codegen agent skipped (set AI_CODE3_ALLOW_NO_AGENT_PASS=yes for CI smoke only)');
        return 4;
      }
      implStatus = 'skipped';
      testStatus = 'skipped';
      for (const row of wtResult.rows) {
        const t = healthFull.applyHealthFullScaffold(row.worktree_path);
        if (t > 0) {
          console.error(`codegen full health scaffold: ${t} files in ${row.worktree_path}`);
        }
      }
    } else {
      for (const row of wtResult.rows) {
        const ir = await invokeCodegenAgent({
          worktreePath: row.worktree_path,
          projectRoot,
          phase: 'impl',
          timeoutMs: subMs,
          featureId: row.feature_id,
        });
        if (ir.skipped) {
          agentMeta = { ...agentMeta, skipped: true, skip_reason: ir.reason || 'no_agent_bin' };
          if (!allowNoAgent) {
            implStatus = 'skipped';
            testStatus = 'skipped';
            const now = new Date().toISOString();
            doc = stagesIo.updateStage(doc, 'codegen', {
              status: 'failed',
              completed_at: now,
              inputs: { ...doc.stages?.codegen?.inputs, summary_hash: hash, requires_stage: 'design_review' },
              outputs: {
                ...doc.stages?.codegen?.outputs,
                worktrees: wtResult.rows.map((r) => ({
                  ...r,
                  commit: '',
                  files_expected: [],
                  files_changed: [],
                  test_files_expected: [],
                  test_files_changed: [],
                })),
                impl_codegen_status: implStatus,
                test_codegen_status: testStatus,
                agent: agentMeta,
                duration_ms: 0,
                timed_out: false,
                timeout_reason: null,
              },
              validation: {
                ...doc.stages?.codegen?.validation,
                passed: false,
                contract_diff_guard_passed: true,
                summary: 'no agent binary (set AI_CODE3_ALLOW_NO_AGENT_PASS=yes for CI)',
              },
            });
            stagesIo.writeStagesSync(projectRoot, doc);
            console.error('failed_stage=codegen no agent binary');
            return 4;
          }
          implStatus = 'skipped';
          testStatus = 'skipped';
          break;
        }
        if (!ir.ok) {
          implStatus = 'failed';
          testStatus = 'skipped';
          const now = new Date().toISOString();
          doc = stagesIo.updateStage(doc, 'codegen', {
            status: 'failed',
            completed_at: now,
            inputs: { ...doc.stages?.codegen?.inputs, summary_hash: hash, requires_stage: 'design_review' },
            outputs: {
              ...doc.stages?.codegen?.outputs,
              worktrees: wtResult.rows.map((r) => ({
                ...r,
                commit: '',
                files_expected: [],
                files_changed: [],
                test_files_expected: [],
                test_files_changed: [],
              })),
              impl_codegen_status: implStatus,
              test_codegen_status: testStatus,
              agent: { ...agentMeta, skipped: false, skip_reason: ir.reason || 'impl_failed' },
              duration_ms: 0,
              timed_out: ir.code === 3,
              timeout_reason: ir.code === 3 ? 'codegen_agent' : null,
            },
            validation: {
              ...doc.stages?.codegen?.validation,
              passed: false,
              contract_diff_guard_passed: true,
              summary: ir.reason || 'impl agent failed',
            },
          });
          stagesIo.writeStagesSync(projectRoot, doc);
          console.error('failed_stage=codegen impl agent failed');
          return ir.code === 3 ? 3 : 4;
        }
        implStatus = 'completed';

        if (!shouldSkipTestAgentPhase(testSpecAbs)) {
          const tr = await invokeCodegenAgent({
            worktreePath: row.worktree_path,
            projectRoot,
            phase: 'test',
            timeoutMs: subMs,
            featureId: row.feature_id,
          });
          if (!tr.ok && !tr.skipped) {
            testStatus = 'failed';
            const now = new Date().toISOString();
            doc = stagesIo.updateStage(doc, 'codegen', {
              status: 'failed',
              completed_at: now,
              inputs: { ...doc.stages?.codegen?.inputs, summary_hash: hash, requires_stage: 'design_review' },
              outputs: {
                ...doc.stages?.codegen?.outputs,
                worktrees: wtResult.rows.map((r) => ({
                  ...r,
                  commit: '',
                  files_expected: [],
                  files_changed: [],
                  test_files_expected: [],
                  test_files_changed: [],
                })),
                impl_codegen_status: implStatus,
                test_codegen_status: testStatus,
                agent: { ...agentMeta, skipped: false, skip_reason: tr.reason || 'test_agent_failed' },
                duration_ms: 0,
                timed_out: tr.code === 3,
                timeout_reason: tr.code === 3 ? 'codegen_agent_test' : null,
              },
              validation: {
                ...doc.stages?.codegen?.validation,
                passed: false,
                contract_diff_guard_passed: true,
                summary: tr.reason || 'test agent failed',
              },
            });
            stagesIo.writeStagesSync(projectRoot, doc);
            console.error('failed_stage=codegen test agent failed');
            return tr.code === 3 ? 3 : 4;
          }
          testStatus = tr.skipped ? 'skipped' : 'completed';
        } else {
          testStatus = 'skipped_no_spec';
        }
      }
    }
  } finally {
    if (hb) clearInterval(hb);
  }

  const now = new Date().toISOString();
  const testOk =
    testStatus === 'completed' ||
    testStatus === 'skipped' ||
    testStatus === 'skipped_no_spec';
  const passed =
    skipAgent && allowNoAgent && implStatus === 'skipped' && testStatus === 'skipped'
      ? true
      : !skipAgent &&
        implStatus === 'completed' &&
        testOk;

  doc = stagesIo.updateStage(doc, 'codegen', {
    status: passed ? 'completed' : 'failed',
    started_at: doc.stages?.codegen?.started_at || now,
    completed_at: now,
    inputs: {
      ...doc.stages?.codegen?.inputs,
      summary_hash: hash,
      requires_stage: 'design_review',
    },
    outputs: {
      ...doc.stages?.codegen?.outputs,
      worktrees: wtResult.rows.map((r) => ({
        ...r,
        commit: '',
        files_expected: [],
        files_changed: [],
        test_files_expected: [],
        test_files_changed: [],
      })),
      impl_codegen_status: implStatus,
      test_codegen_status: testStatus,
      agent: agentMeta,
      duration_ms: 0,
      timed_out: false,
      timeout_reason: null,
    },
    validation: {
      ...doc.stages?.codegen?.validation,
      passed,
      contract_diff_guard_passed: true,
      summary: 'ai-code3/scripts/codegen.cjs (worktree + dual diff-guard + agent hook)',
    },
  });
  stagesIo.writeStagesSync(projectRoot, doc);
  return passed ? 0 : 4;
}

module.exports = { run };

if (require.main === module) {
  const { parseCommonArgs } = require('./lib/cli-args.cjs');
  const o = parseCommonArgs(process.argv);
  if (!o.project) {
    console.error('missing --project=<absolute>');
    process.exit(1);
  }
  run({ projectRoot: o.project, options: o }).then((c) => process.exit(c));
}
