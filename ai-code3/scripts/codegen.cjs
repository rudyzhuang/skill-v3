'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const stagesIo = require('./lib/stages-io.cjs');
const summaryHash = require('./lib/summary-hash.cjs');
const { assertCodegenGates } = require('./lib/codegen-gates.cjs');
const worktreeLib = require('./lib/codegen-worktree.cjs');
const scaffold = require('./lib/codegen-scaffold.cjs');
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

  const config = loadDevConfig(projectRoot);
  const base = baseBranchFromDoc(doc, config);
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
