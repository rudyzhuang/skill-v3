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
const featureStages = require('../../ai-auto3/scripts/lib/feature-stages.cjs');
const gitSync = require('../../ai-auto3/scripts/lib/git-pipeline-sync.cjs');

/**
 * 在 agent 调用期间保持 per-feature 心跳（每 30 s 写 last_heartbeat_at + elapsed_ms）。
 * 返回 asyncFn() 的 Promise；无论成功/失败/超时都会在 finally 中清除定时器。
 * @param {string} projectRoot
 * @param {string} stageKey
 * @param {string} featureId
 * @param {string} startedAt  ISO 时间戳
 * @param {() => Promise<any>} asyncFn
 */
function wrapWithFeatureHeartbeat(projectRoot, stageKey, featureId, startedAt, asyncFn) {
  featureStages.writeFeatureHeartbeat(projectRoot, stageKey, featureId, startedAt);
  const interval = setInterval(
    () => featureStages.writeFeatureHeartbeat(projectRoot, stageKey, featureId, startedAt),
    30_000
  );
  interval.unref();
  return asyncFn().finally(() => clearInterval(interval));
}

function loadDevConfig(projectRoot) {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function syncPipelineGitForFeature(projectRoot, stageKey, featureId) {
  const config = loadDevConfig(projectRoot);
  const r = gitSync.syncAfterFeature(projectRoot, stageKey, featureId, { config });
  if (!r.ok && !r.skipped) {
    console.error(
      `[ai-code3] git sync ${stageKey}/${featureId} failed:`,
      r.reason || r.push_error || 'unknown'
    );
    if (r.push_status === 'failed') return 7;
    return 1;
  }
  return 0;
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

function normalizeWorktreeRow(r) {
  return {
    files_expected: [],
    files_changed: [],
    test_files_expected: [],
    test_files_changed: [],
    commit: '',
    ...r,
    files_expected: Array.isArray(r.files_expected) ? r.files_expected : [],
    files_changed: Array.isArray(r.files_changed) ? r.files_changed : [],
    test_files_expected: Array.isArray(r.test_files_expected) ? r.test_files_expected : [],
    test_files_changed: Array.isArray(r.test_files_changed) ? r.test_files_changed : [],
    commit: r.commit != null ? String(r.commit) : '',
  };
}

/** Merge per-feature codegen runs so autorun coverage checks see the full phase set. */
function mergeCodegenWorktrees(existing, rows) {
  const byId = new Map();
  for (const r of existing || []) {
    const id = String(r?.feature_id || '').trim();
    if (id) byId.set(id, normalizeWorktreeRow(r));
  }
  for (const r of rows || []) {
    const id = String(r?.feature_id || '').trim();
    if (!id) continue;
    const prev = byId.get(id) || {};
    const next = normalizeWorktreeRow({ ...prev, ...r });
    if (!String(next.commit || '').trim() && String(prev.commit || '').trim()) {
      next.commit = prev.commit;
    }
    if (!next.files_changed?.length && prev.files_changed?.length) {
      next.files_changed = prev.files_changed;
    }
    if (!next.test_files_changed?.length && prev.test_files_changed?.length) {
      next.test_files_changed = prev.test_files_changed;
    }
    byId.set(id, next);
  }
  return [...byId.values()].sort((a, b) =>
    String(a.feature_id || '').localeCompare(String(b.feature_id || ''))
  );
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

function ensureGitRepoForCodegen(projectRoot, _baseBranch) {
  const inside = spawnSync('git', ['-C', projectRoot, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8',
  });
  if (inside.status === 0 && String(inside.stdout || '').trim() === 'true') return { ok: true };

  return {
    ok: false,
    reason:
      'not_a_git_repo: run ai-prd3 bootstrap first (input-spec.md §3.5 — git init moved to prd stage)',
  };
}

/**
 * Commit agent changes on the feature branch so merge-push can merge real diffs.
 * @returns {{ ok: boolean, commit?: string, skipped?: boolean, reason?: string }}
 */
function commitFeatureWorktreeChanges(worktreePath, featureId) {
  const st = spawnSync('git', ['-C', worktreePath, 'status', '--porcelain'], { encoding: 'utf8' });
  if (st.status !== 0) {
    return { ok: false, reason: st.stderr || 'git_status_failed' };
  }
  if (!String(st.stdout || '').trim()) {
    return { ok: true, skipped: true };
  }
  const add = spawnSync('git', ['-C', worktreePath, 'add', '-A'], { encoding: 'utf8' });
  if (add.status !== 0) {
    return { ok: false, reason: add.stderr || 'git_add_failed' };
  }
  const msg = `feat(${featureId}): codegen agent implementation`;
  const commit = spawnSync('git', ['-C', worktreePath, 'commit', '-m', msg], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'ai-code3',
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'ai-code3@local',
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'ai-code3',
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'ai-code3@local',
    },
  });
  if (commit.status !== 0) {
    return { ok: false, reason: commit.stderr || commit.stdout || 'git_commit_failed' };
  }
  const rev = spawnSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const hash = rev.status === 0 ? String(rev.stdout || '').trim() : '';
  return { ok: true, commit: hash };
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
  const sessionId = options.sessionId || '';

  doc = featureStages.backfillFeatureStages(doc);
  const begun = featureStages.beginStageForFeatures(doc, {
    stageKey: 'codegen',
    featureIds,
    skill: 'ai-code3',
    message: `codegen 开始，本波 feature：${featureIds.join('、')}`,
  });
  doc = begun.doc;
  stagesIo.writeStagesSync(projectRoot, doc);
  featureStages.appendStageLog(projectRoot, {
    skill: 'ai-code3',
    sessionId,
    stageKey: 'codegen',
    featureIds,
    message: `已标记 ${begun.marked.length} 个 feature 为处理中`,
    detail: begun.marked.length ? begun.marked.join(',') : 'none',
  });

  if (options.dryRun) {
    console.error(`[dry-run] codegen ok; summary_hash would be ${hash}; features=${featureIds.join(',')}`);
    return 0;
  }

  const codegenMs = stageTimeoutMs(config, 'codegen_s', 1800);
  const soakStrictCodegen =
    process.env.AI_SOAK3_STRICT === '1' || process.env.AI_SOAK3_STRICT === 'true';
  const envPhaseMs = Number(process.env.AI_CODE3_AGENT_PHASE_TIMEOUT_MS);
  const subMs =
    Number.isFinite(envPhaseMs) && envPhaseMs > 0
      ? Math.floor(envPhaseMs)
      : soakStrictCodegen
        ? Math.max(120_000, Math.floor(codegenMs / 2))
        : Math.max(60_000, Math.floor(codegenMs / 4));

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

  const soakStrict =
    process.env.AI_SOAK3_STRICT === '1' || process.env.AI_SOAK3_STRICT === 'true';
  const skipAgent =
    process.env.AI_CODE3_SKIP_AGENT === '1' ||
    process.env.AI_CODEGEN_SKIP_AGENT === '1' ||
    (!(process.env.AI_CODE3_AGENT_BIN || '').trim() && !(process.env.AI_CODEGEN_AGENT_BIN || '').trim());
  const allowNoAgent = process.env.AI_CODE3_ALLOW_NO_AGENT_PASS === 'yes';

  if (soakStrict && skipAgent) {
    console.error(
      'failed_stage=codegen: AI_SOAK3_STRICT=1 禁止 AI_CODE3_SKIP_AGENT / 无 Agent 完成 codegen（见 code3.md §7.12）'
    );
    if (!options.dryRun) {
      writeTerminal(projectRoot, doc, 'codegen', 'failed', {
        summary: 'AI_SOAK3_STRICT forbids skip agent',
      });
    }
    return 4;
  }

  let hb;
  if (sessionId) {
    appendHeartbeat(projectRoot, sessionId, 'codegen', 'start', { featureIds, stderrTag: 'ai-code3' });
    hb = setInterval(
      () => appendHeartbeat(projectRoot, sessionId, 'codegen', 'tick', { featureIds, stderrTag: 'ai-code3' }),
      30_000
    );
  }

  console.error(
    `[ai-code3] codegen begin features=${featureIds.join(',')} count=${featureIds.length} agent_phase_timeout_ms=${subMs} skip_agent=${skipAgent ? 1 : 0} session=${sessionId || 'none'}`
  );

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
            worktrees: mergeCodegenWorktrees(
              doc.stages?.codegen?.outputs?.worktrees,
              wtResult.rows
            ),
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
      const scaffoldTargets = healthFull.resolveScaffoldClientTargets(doc, config);
      for (const row of wtResult.rows) {
        const t = healthFull.applyHealthFullScaffold(row.worktree_path, {
          clientTargets: scaffoldTargets,
          projectRoot,
        });
        if (t > 0) {
          console.error(
            `codegen full health scaffold: ${t} files (worktree src + .pipeline/ai-code3 tooling) feature=${row.feature_id}`
          );
        }
      }
    } else {
      const featureTotal = wtResult.rows.length;
      for (let fi = 0; fi < wtResult.rows.length; fi++) {
        const row = wtResult.rows[fi];
        const featureNo = `${fi + 1}/${featureTotal}`;
        console.error(
          `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} impl begin timeout_ms=${subMs}`
        );
        doc = featureStages.markFeatureStage(doc, 'codegen', row.feature_id, 'running', {
          message: `impl Agent 执行中（${featureNo}）`,
        });
        stagesIo.writeStagesSync(projectRoot, doc);
        featureStages.appendStageLog(projectRoot, {
          skill: 'ai-code3',
          sessionId,
          stageKey: 'codegen',
          featureId: row.feature_id,
          message: `开始 impl Agent（${featureNo}）`,
        });
        const featureStartedAt =
          featureStages.getFeatureStageRow(doc, 'codegen', row.feature_id)?.started_at ||
          new Date().toISOString();
        const ir = await wrapWithFeatureHeartbeat(
          projectRoot,
          'codegen',
          row.feature_id,
          featureStartedAt,
          () =>
            invokeCodegenAgent({
              worktreePath: row.worktree_path,
              projectRoot,
              phase: 'impl',
              timeoutMs: subMs,
              featureId: row.feature_id,
              sessionId,
            })
        );
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
                worktrees: mergeCodegenWorktrees(
                  doc.stages?.codegen?.outputs?.worktrees,
                  wtResult.rows
                ),
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
              worktrees: mergeCodegenWorktrees(
                doc.stages?.codegen?.outputs?.worktrees,
                wtResult.rows
              ),
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
          console.error(
            `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} impl failed reason=${ir.reason || 'impl_failed'} code=${ir.code}`
          );
          console.error('failed_stage=codegen impl agent failed');
          return ir.code === 3 ? 3 : 4;
        }
        const commitResult = commitFeatureWorktreeChanges(row.worktree_path, row.feature_id);
        if (!commitResult.ok) {
          implStatus = 'failed';
          testStatus = 'skipped';
          const now = new Date().toISOString();
          doc = stagesIo.updateStage(doc, 'codegen', {
            status: 'failed',
            completed_at: now,
            inputs: { ...doc.stages?.codegen?.inputs, summary_hash: hash, requires_stage: 'design_review' },
            outputs: {
              ...doc.stages?.codegen?.outputs,
              worktrees: mergeCodegenWorktrees(doc.stages?.codegen?.outputs?.worktrees, wtResult.rows),
              impl_codegen_status: implStatus,
              test_codegen_status: testStatus,
              agent: { ...agentMeta, skipped: false, skip_reason: commitResult.reason || 'commit_failed' },
              duration_ms: 0,
              timed_out: false,
              timeout_reason: null,
            },
            validation: {
              ...doc.stages?.codegen?.validation,
              passed: false,
              contract_diff_guard_passed: true,
              summary: commitResult.reason || 'post-impl commit failed',
            },
          });
          stagesIo.writeStagesSync(projectRoot, doc);
          console.error(
            `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} commit failed reason=${commitResult.reason || 'commit_failed'}`
          );
          console.error('failed_stage=codegen post-impl commit failed');
          return 4;
        }
        if (commitResult.commit) {
          row.commit = commitResult.commit;
        }
        implStatus = 'completed';
        // 重新读最新 doc，避免并行进程竞态覆盖其他 feature 的完成记录
        try { doc = stagesIo.readStagesSync(projectRoot); } catch { /* 保持内存 doc */ }
        doc = featureStages.markFeatureStage(doc, 'codegen', row.feature_id, 'completed', {
          message: `impl 完成，commit=${commitResult.commit || 'unchanged'}`,
        });
        stagesIo.writeStagesSync(projectRoot, doc);
        console.error(
          `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} impl ok commit=${commitResult.commit || 'unchanged'}`
        );

        if (!shouldSkipTestAgentPhase(testSpecAbs)) {
          console.error(
            `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} test begin timeout_ms=${subMs}`
          );
          const tr = await wrapWithFeatureHeartbeat(
            projectRoot,
            'codegen',
            row.feature_id,
            featureStartedAt,
            () =>
              invokeCodegenAgent({
                worktreePath: row.worktree_path,
                projectRoot,
                phase: 'test',
                timeoutMs: subMs,
                featureId: row.feature_id,
                sessionId,
              })
          );
          if (!tr.ok && !tr.skipped) {
            testStatus = 'failed';
            const now = new Date().toISOString();
            doc = stagesIo.updateStage(doc, 'codegen', {
              status: 'failed',
              completed_at: now,
              inputs: { ...doc.stages?.codegen?.inputs, summary_hash: hash, requires_stage: 'design_review' },
              outputs: {
                ...doc.stages?.codegen?.outputs,
                worktrees: mergeCodegenWorktrees(
                  doc.stages?.codegen?.outputs?.worktrees,
                  wtResult.rows
                ),
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
            console.error(
              `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} test failed reason=${tr.reason || 'test_failed'} code=${tr.code}`
            );
            console.error('failed_stage=codegen test agent failed');
            return tr.code === 3 ? 3 : 4;
          }
          testStatus = tr.skipped ? 'skipped' : 'completed';
          console.error(
            `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} test ${testStatus}`
          );
        } else {
          testStatus = 'skipped_no_spec';
          console.error(
            `[ai-code3] codegen feature ${featureNo} feature_id=${row.feature_id} test skipped_no_spec`
          );
        }
        const gitCode = syncPipelineGitForFeature(projectRoot, 'codegen', row.feature_id);
        if (gitCode !== 0) return gitCode;
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

  // 写最终结果前重新从磁盘读最新 doc，避免并行进程竞态覆盖其他 feature 的完成记录
  try { doc = stagesIo.readStagesSync(projectRoot); } catch { /* 保持内存 doc */ }

  if (passed) {
    doc = featureStages.markFeaturesCompleted(doc, 'codegen', featureIds, {
      message: 'codegen 阶段全部完成',
    });
  } else {
    doc = featureStages.markFeaturesFailed(doc, 'codegen', featureIds, {
      message: `codegen 失败 impl=${implStatus} test=${testStatus}`,
    });
  }

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
      worktrees: mergeCodegenWorktrees(
        doc.stages?.codegen?.outputs?.worktrees,
        wtResult.rows
      ),
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
  console.error(
    `[ai-code3] codegen end passed=${passed ? 1 : 0} impl_status=${implStatus} test_status=${testStatus} features=${featureIds.join(',')}`
  );
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
