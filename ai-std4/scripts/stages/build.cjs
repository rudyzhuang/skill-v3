'use strict';

/**
 * build.cjs — build stage
 *
 * 职责：在 merge_push 将 feature 合入主干后，按 client_target × sub_platform
 * 矩阵对各端执行构建，产出可供 deploy 消费的 artifact。
 *
 * 参数：
 *   --project=<路径>    业务项目根（绝对或相对），默认 AI_STD4_PROJECT 环境变量或 cwd
 *   --run-id=<id>       run_id（由 run-pipeline 传入）
 *   --force-rerun       强制跳过 hash 门控，重新执行
 *
 * 退出码：
 *   0  所有须构建 unit 成功（或 hash 门控命中整段跳过）
 *   1  门闸/HEAD 不一致/配置无法解析/无 target/PID 锁占用
 *   3  至少一个 unit 超时（无其它失败）
 *   4  至少一个 unit 构建或产物校验失败
 *   5  stop.signal
 */

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const { createPipelinePaths } = require('../libs/pipeline-paths.cjs');
const { createLogger, formatLocalTimeShort } = require('../libs/logger.cjs');
const { probe }     = require('../libs/build-probe.cjs');
const { runUnit }   = require('../libs/build-runner.cjs');

// ── 解析参数 ──────────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=');
      return [k, v.join('=') || true];
    })
);

const projectRoot = args.project
  ? path.resolve(args.project)
  : process.env.AI_STD4_PROJECT
    ? path.resolve(process.env.AI_STD4_PROJECT)
    : process.cwd();
const paths = createPipelinePaths(projectRoot);

const runId      = args['run-id'] || null;
const forceRerun = args['force-rerun'] === true || args['force-rerun'] === 'true';

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'build', runId });

// ── stages.json 读写 ──────────────────────────────────────────────
function readStagesJson() {
  return paths.readStagesJson();
}

function writeStagesJson(obj) {
  return paths.writeStagesJson(obj);
}

// ── config.dev.json 读取 ──────────────────────────────────────────
function readConfigDevJson() {
  const p = path.join(projectRoot, 'docs', 'config.dev.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; }
}

// ── Git 辅助 ──────────────────────────────────────────────────────
function getHeadCommit() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd:      projectRoot,
    encoding: 'utf8',
    timeout:  15000,
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

// ── PID 锁 ────────────────────────────────────────────────────────
const locksDir    = paths.locksDir;
const pidLockPath = path.join(locksDir, 'build.pid');

function acquirePidLock() {
  fs.mkdirSync(locksDir, { recursive: true });
  if (fs.existsSync(pidLockPath)) {
    const existingPid = parseInt(fs.readFileSync(pidLockPath, 'utf8').trim(), 10);
    try {
      process.kill(existingPid, 0);
      return { ok: false, existingPid };
    } catch (_) {
      fs.unlinkSync(pidLockPath);
    }
  }
  fs.writeFileSync(pidLockPath, String(process.pid), 'utf8');
  return { ok: true };
}

function releasePidLock() {
  try {
    if (fs.existsSync(pidLockPath)) {
      const pid = fs.readFileSync(pidLockPath, 'utf8').trim();
      if (pid === String(process.pid)) fs.unlinkSync(pidLockPath);
    }
  } catch (_) {}
}

// ── stop.signal ───────────────────────────────────────────────────
const stopSignalPath = paths.stopSignalPath;

function getStopReason() {
  if (!fs.existsSync(stopSignalPath)) return null;
  try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason || 'unknown'; }
  catch (_) { return 'unknown'; }
}

// ── 构建目标集解析 ────────────────────────────────────────────────
/**
 * 按优先级解析 target_set[]
 */
function resolveTargetSet(buildCfg, stages) {
  // 1. config.build.client_targets 为对象（矩阵形态）
  if (buildCfg.client_targets && typeof buildCfg.client_targets === 'object' &&
      !Array.isArray(buildCfg.client_targets)) {
    return Object.keys(buildCfg.client_targets);
  }

  // 2. config.build.client_targets 为字符串数组
  if (Array.isArray(buildCfg.client_targets) && buildCfg.client_targets.length > 0) {
    return buildCfg.client_targets;
  }

  // 3. config.build.commands 的键集（排除保留键）
  const RESERVED = new Set(['build', 'install']);
  if (buildCfg.commands && typeof buildCfg.commands === 'object') {
    const keys = Object.keys(buildCfg.commands).filter(k => !RESERVED.has(k));
    if (keys.length > 0) return keys;
  }

  // 4. stages.prd.outputs.client_targets[]
  const prdTargets = stages.stages &&
                     stages.stages.prd &&
                     stages.stages.prd.outputs &&
                     stages.stages.prd.outputs.client_targets;
  if (Array.isArray(prdTargets) && prdTargets.length > 0) {
    return prdTargets;
  }

  // 5. 扫描 src/ 下包含可识别工程文件的子目录
  const srcDir = path.join(projectRoot, 'src');
  if (fs.existsSync(srcDir)) {
    const MARKERS = [
      'package.json', 'pubspec.yaml', 'Cargo.toml',
      'go.mod', 'pyproject.toml', 'setup.py',
    ];
    try {
      return fs.readdirSync(srcDir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .filter(e => MARKERS.some(m => fs.existsSync(path.join(srcDir, e.name, m))))
        .map(e => e.name);
    } catch (_) {}
  }

  return [];
}

/**
 * 展开为 build units（client_target × sub_platforms）
 */
function expandBuildUnits(targetSet, buildCfg) {
  const units = [];
  for (const target of targetSet) {
    const targetCfg = buildCfg.client_targets &&
                      typeof buildCfg.client_targets === 'object' &&
                      !Array.isArray(buildCfg.client_targets)
      ? (buildCfg.client_targets[target] || null)
      : null;

    const subPlatforms = (targetCfg && Array.isArray(targetCfg.sub_platforms))
      ? targetCfg.sub_platforms
      : [{ id: 'default' }];

    for (const sp of subPlatforms) {
      units.push({
        client_target: target,
        sub_platform:  sp.id || 'default',
        targetConfig:  targetCfg,
      });
    }
  }
  return units;
}

// ── summary_hash 计算 ─────────────────────────────────────────────
function computeSummaryHash(finalCommit, buildCfg, buildUnits) {
  const payload = {
    final_commit:  finalCommit,
    client_targets: buildCfg.client_targets || null,
    commands:       buildCfg.commands || null,
    artifacts_dir:  buildCfg.artifacts_dir || 'dist',
    install_before_build: buildCfg.install_before_build !== false,
    unit_keys:      buildUnits.map(u => `${u.client_target}:${u.sub_platform}`).sort(),
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

// ── 并行 Promise 池 ───────────────────────────────────────────────
async function runWithPool(tasks, concurrency) {
  const results = new Array(tasks.length);
  let   idx     = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i     = idx++;
      results[i]  = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ── 计算目录大小（字节）────────────────────────────────────────────
function getDirSizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const stat = fs.statSync(dirPath);
    if (stat.isFile()) return stat.size;
    let total = 0;
    function walk(d) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); }
        else { try { total += fs.statSync(full).size; } catch (_) {} }
      }
    }
    walk(dirPath);
    return total;
  } catch (_) { return 0; }
}

// ── 生成构建报告 ──────────────────────────────────────────────────
function generateBuildReport({ finalCommit, targetBranch, artifacts, startedAt,
                                completedAt, effectiveParallel, validationPassed }) {
  const durMs  = completedAt - startedAt;
  const durSec = (durMs / 1000).toFixed(1);

  const lines = [
    '# Build Summary',
    '',
    '## 摘要',
    '',
    `| 项目 | 值 |`,
    `| --- | --- |`,
    `| Commit | \`${(finalCommit || '').slice(0, 8)}\` |`,
    `| 目标分支 | ${targetBranch || '-'} |`,
    `| 总耗时 | ${durSec}s |`,
    `| 并行度 | ${effectiveParallel} |`,
    `| 校验结果 | ${validationPassed ? '✅ 通过' : '❌ 失败'} |`,
    `| 报告时间 | ${formatLocalTimeShort(new Date(completedAt))} |`,
    '',
    '## 构建结果',
    '',
    '| client_target | sub_platform | framework | status | duration | artifact_path | log |',
    '| --- | --- | --- | --- | --- | --- | --- |',
  ];

  for (const a of artifacts) {
    const dur      = a.duration_ms != null ? `${(a.duration_ms / 1000).toFixed(1)}s` : '-';
    const artPath  = a.artifact_path ? path.relative(projectRoot, a.artifact_path) : '-';
    const logRel   = a.log_path ? path.relative(projectRoot, a.log_path) : '-';
    const statusMark = {
      completed:      '✅',
      failed:         '❌',
      skipped:        '⏭',
      not_applicable: '➖',
    }[a.status] || a.status;
    lines.push(
      `| ${a.client_target} | ${a.sub_platform} | ${a.framework || '-'} ` +
      `| ${statusMark} ${a.status} | ${dur} | ${artPath} | [log](${logRel}) |`
    );
  }

  // 失败详情
  const failedArtifacts = artifacts.filter(a => a.status === 'failed');
  if (failedArtifacts.length > 0) {
    lines.push('', '## 失败详情', '');
    for (const a of failedArtifacts) {
      lines.push(
        `### ${a.client_target}/${a.sub_platform}`,
        '',
        `- **命令**: \`${a.command || '(无)'}\``,
        `- **exit code**: ${a.exit_code != null ? a.exit_code : 'N/A'}`,
        `- **超时**: ${a.timed_out ? '是' : '否'}`,
        `- **缺失产物**: ${(a.artifact_check && a.artifact_check.missing_globs || []).join(', ') || '无'}`,
        `- **日志**: ${a.log_path ? path.relative(projectRoot, a.log_path) : '-'}`,
        ''
      );
    }
  }

  // 探测记录
  lines.push('', '## 探测记录', '');
  for (const a of artifacts) {
    lines.push(
      `- **${a.client_target}/${a.sub_platform}**: framework=${a.framework || '-'}, ` +
      `build_type=${a.build_type || '-'}, ` +
      `cmd=\`${a.command || '(无)'}\``
    );
  }

  return lines.join('\n') + '\n';
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt    = Date.now();
  const startedAtStr = formatLocalTimeShort(new Date(startedAt));

  log.info('stage_start', `build stage 启动，项目: ${projectRoot}`, {
    run_id:     runId,
    stage:      'build',
    project:    projectRoot,
    started_at: startedAtStr,
  });

  // ── 1. 读 stages.json ─────────────────────────────────────────────
  let stages = readStagesJson();
  if (!stages) {
    log.error('stage_failed', 'stages.json 不存在', {
      stage: 'build', exit_code: 1, reason: 'stages.json missing',
      duration_ms: 0,
    });
    process.exit(1);
  }

  // ── 2. 上游门闸：merge_push.status=completed ─────────────────────
  const mergePush = stages.stages && stages.stages.merge_push;
  if (!mergePush || mergePush.status !== 'completed') {
    log.error('stage_failed',
      `上游门闸未满足：merge_push.status=${mergePush ? mergePush.status : 'missing'}，需要 completed`, {
        stage: 'build', exit_code: 1,
        reason: `merge_push.status=${mergePush ? mergePush.status : 'missing'}`,
        duration_ms: 0,
      });
    process.exit(1);
  }

  const finalCommit = mergePush.outputs && mergePush.outputs.final_commit;
  if (!finalCommit) {
    log.error('stage_failed',
      '上游门闸未满足：merge_push.outputs.final_commit 为空', {
        stage: 'build', exit_code: 1,
        reason: 'merge_push.outputs.final_commit missing',
        duration_ms: 0,
      });
    process.exit(1);
  }

  const targetBranch = (mergePush.outputs && mergePush.outputs.target_branch) || null;

  // ── 3. stop.signal 检查 ───────────────────────────────────────────
  const stopReason = getStopReason();
  if (stopReason !== null) {
    log.info('pipeline_stop', '检测到 stop.signal，build stage 停止', {
      stage:      'build',
      reason:     stopReason,
      stopped_at: formatLocalTimeShort(),
    });
    stages.stages         = stages.stages || {};
    stages.stages.build   = Object.assign({}, stages.stages.build || {}, { status: 'stopped' });
    stages.pipeline       = stages.pipeline || {};
    stages.pipeline.updated_at = formatLocalTimeShort();
    writeStagesJson(stages);
    process.exit(5);
  }

  // ── 4. hash 门控（全段跳过）─────────────────────────────────────
  if (!forceRerun) {
    const buildStage = stages.stages && stages.stages.build;
    if (buildStage && buildStage.status === 'completed') {
      const storedHash = buildStage.inputs && buildStage.inputs.build_commit_hash;
      if (storedHash && storedHash === finalCommit) {
        // 检查 outputs.overall
        const overall = buildStage.outputs && buildStage.outputs.overall;
        if (overall === 'success' || overall === 'completed') {
          log.info('stage_skipped', 'build hash 门控命中（build_commit_hash 匹配），跳过执行', {
            stage:  'build',
            reason: 'build_commit_hash matched final_commit',
            exit_code: 0,
          });
          process.exit(0);
        }
      }
    }
  }

  // ── 5. HEAD 漂移检测 ──────────────────────────────────────────────
  const headCommit = getHeadCommit();
  if (headCommit && headCommit !== finalCommit) {
    log.error('stage_failed',
      `HEAD 漂移：HEAD=${headCommit.slice(0, 8)}，期望 final_commit=${finalCommit.slice(0, 8)}` +
      `，请执行 git checkout ${finalCommit} 后重跑`, {
        stage:        'build',
        exit_code:    1,
        reason:       `HEAD_drift: HEAD=${headCommit} != final_commit=${finalCommit}`,
        duration_ms:  0,
      });
    process.exit(1);
  }

  // ── 6. PID 锁 ─────────────────────────────────────────────────────
  const lockResult = acquirePidLock();
  if (!lockResult.ok) {
    log.error('stage_failed',
      `PID 锁被占用（pid=${lockResult.existingPid}），可能有并发 build 在运行`, {
        stage: 'build', exit_code: 1,
        reason: `pid_lock_occupied: ${lockResult.existingPid}`,
        duration_ms: Date.now() - startedAt,
      });
    process.exit(1);
  }

  process.on('exit', releasePidLock);
  process.on('SIGINT',  () => { releasePidLock(); process.exit(1); });
  process.on('SIGTERM', () => { releasePidLock(); process.exit(1); });

  // ── 7. 读取 config.dev.json ───────────────────────────────────────
  const config     = readConfigDevJson();
  const buildCfg   = config.build || {};
  const pipelineCfg = config.pipeline || {};

  const timeoutMs = ((config.timeouts && config.timeouts.stages && config.timeouts.stages.build_s) || 300) * 1000;

  const clientMaxParallel = (pipelineCfg.stages && pipelineCfg.stages.build &&
                              pipelineCfg.stages.build.client_max_parallel) || 4;
  const autorunBuildMax   = (pipelineCfg.autorun && pipelineCfg.autorun.build_max_parallel) ||
                            (pipelineCfg.autorun && pipelineCfg.autorun.feature_max_parallel) ||
                            clientMaxParallel;
  const effectiveParallel = Math.min(clientMaxParallel, autorunBuildMax);

  const installBeforeBuild = buildCfg.install_before_build !== false;
  const failFast           = buildCfg.fail_fast === true;
  const artifactsDir       = buildCfg.artifacts_dir || 'dist';

  // ── 8. 解析构建目标 ───────────────────────────────────────────────
  const targetSet  = resolveTargetSet(buildCfg, stages);
  if (targetSet.length === 0) {
    log.error('stage_failed', '无法解析构建目标（target_set 为空）', {
      stage: 'build', exit_code: 1, reason: 'empty target_set',
      duration_ms: Date.now() - startedAt,
    });
    releasePidLock();
    process.exit(1);
  }

  const buildUnits = expandBuildUnits(targetSet, buildCfg);

  // ── 9. 计算 summary_hash ──────────────────────────────────────────
  const summaryHash    = computeSummaryHash(finalCommit, buildCfg, buildUnits);
  const oldBuildStage  = stages.stages && stages.stages.build;
  const oldSummaryHash = oldBuildStage && oldBuildStage.inputs && oldBuildStage.inputs.summary_hash;
  const hashChanged    = summaryHash !== oldSummaryHash;

  // ── 10. 初始化骨架 ────────────────────────────────────────────────
  stages.stages        = stages.stages || {};
  const buildStageInit = {
    status:       'running',
    started_at:   startedAtStr,
    inputs: {
      build_commit_hash: finalCommit,
      summary_hash:      summaryHash,
      client_targets:    targetSet,
    },
    outputs: {
      build_results:       {},
      overall:             null,
      failed_targets:      [],
      report_path:         null,
      duration_ms:         null,
      timed_out:           false,
      timeout_reason:      null,
      artifacts:           [],        // 构建结束后填充
      build_units_total:   buildUnits.length,
      failed_units:        [],
    },
    validation: {
      passed:                  false,
      checked_at:              null,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: [],
    blocking_issues: [],
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  if (!oldBuildStage) {
    stages.stages.build = buildStageInit;
  } else {
    // 合并：保留已完成 unit 的信息（hash 未变时）
    Object.assign(stages.stages.build, {
      status:     'running',
      started_at: startedAtStr,
    });
    stages.stages.build.inputs = Object.assign({}, stages.stages.build.inputs || {}, {
      build_commit_hash: finalCommit,
      summary_hash:      summaryHash,
      client_targets:    targetSet,
    });
    if (!stages.stages.build.outputs) stages.stages.build.outputs = buildStageInit.outputs;
    if (!stages.stages.build.validation) stages.stages.build.validation = buildStageInit.validation;
  }

  stages.pipeline             = stages.pipeline || {};
  stages.pipeline.updated_at  = formatLocalTimeShort();
  stages.pipeline.current_stage = 'build';
  writeStagesJson(stages);

  // ── 11. 框架探测 ──────────────────────────────────────────────────
  const batchId = `build-${Date.now()}`;
  const probeResults = {};

  for (const unit of buildUnits) {
    const { client_target: ct, sub_platform: sp, targetConfig } = unit;
    const probeResult = probe(projectRoot, ct, sp, targetConfig, buildCfg);
    probeResults[`${ct}:${sp}`] = probeResult;

    log.info('build_probe',
      `[probe] ${ct}/${sp} → framework=${probeResult.framework}, cmd=${probeResult.command || '(无)'}`, {
        client_target:    ct,
        sub_platform:     sp,
        probe_root:       probeResult.probeRoot,
        framework:        probeResult.framework,
        markers:          probeResult.markers,
        command_resolved: probeResult.command,
        source:           probeResult.source,
      });
  }

  // ── 12. 并行构建 ──────────────────────────────────────────────────
  const logDir  = paths.stageLogsDir('build');
  const datetime = log.datetime;

  log.info('build_batch_start',
    `[build] 启动并行构建，unit数=${buildUnits.length}，并发=${effectiveParallel}`, {
      batch_id:         batchId,
      units_total:      buildUnits.length,
      effective_parallel: effectiveParallel,
      unit_keys:        buildUnits.map(u => `${u.client_target}:${u.sub_platform}`),
    });

  const artifacts = [];
  let   aborted   = false;

  const tasks = buildUnits.map(unit => async () => {
    const { client_target: ct, sub_platform: sp, targetConfig } = unit;
    const pr = probeResults[`${ct}:${sp}`];

    // fail_fast 中止检查
    if (failFast && aborted) {
      return {
        client_target:  ct,
        sub_platform:   sp,
        framework:      pr.framework,
        build_type:     pr.build_type,
        command:        pr.command,
        cwd:            pr.cwd,
        artifact_path:  null,
        log_path:       path.join(logDir, `${datetime}-${ct}-${sp}.log`),
        status:         'stopped',
        duration_ms:    0,
        artifact_check: { passed: false, missing_globs: pr.artifact_globs },
        timed_out:      false,
        exit_code:      null,
      };
    }

    // 启动前检查 stop.signal
    if (getStopReason() !== null) {
      aborted = true;
      return {
        client_target:  ct,
        sub_platform:   sp,
        framework:      pr.framework,
        build_type:     pr.build_type,
        command:        pr.command,
        cwd:            pr.cwd,
        artifact_path:  null,
        log_path:       path.join(logDir, `${datetime}-${ct}-${sp}.log`),
        status:         'stopped',
        duration_ms:    0,
        artifact_check: { passed: false, missing_globs: pr.artifact_globs },
        timed_out:      false,
        exit_code:      null,
      };
    }

    const result = await runUnit({
      clientTarget:       ct,
      subPlatform:        sp,
      command:            pr.command,
      cwd:                pr.cwd,
      framework:          pr.framework,
      build_type:         pr.build_type,
      artifact_globs:     pr.artifact_globs,
      installCommand:     pr.installCommand,
      installBeforeBuild,
      timeoutMs,
      logDir,
      datetime,
      projectRoot,
      log,
      checkStop: () => getStopReason() !== null,
    });

    if (result.status === 'failed' && failFast) {
      aborted = true;
    }

    return result;
  });

  const unitResults = await runWithPool(tasks, effectiveParallel);

  // 检查是否因 stop.signal 中止（有任意 unit 被标记为 stopped）
  if (unitResults.some(r => r.status === 'stopped')) {
    const completedAtStr = formatLocalTimeShort();
    stages = readStagesJson() || stages;
    stages.stages.build = Object.assign(stages.stages.build || {}, {
      status:       'stopped',
      completed_at: completedAtStr,
    });
    stages.pipeline.updated_at = completedAtStr;
    writeStagesJson(stages);
    releasePidLock();
    log.info('pipeline_stopped', 'build stage 因 stop.signal 停止', {
      stage: 'build', exit_code: 5,
    });
    process.exit(5);
  }

  artifacts.push(...unitResults);

  // ── 13. build_batch_complete 日志 ────────────────────────────────
  const succeeded      = artifacts.filter(a => a.status === 'completed').map(a => `${a.client_target}:${a.sub_platform}`);
  const failed         = artifacts.filter(a => a.status === 'failed').map(a => `${a.client_target}:${a.sub_platform}`);
  const skipped        = artifacts.filter(a => a.status === 'skipped').map(a => `${a.client_target}:${a.sub_platform}`);
  const notApplicable  = artifacts.filter(a => a.status === 'not_applicable').map(a => `${a.client_target}:${a.sub_platform}`);
  const batchDurMs     = Date.now() - startedAt;

  log.info('build_batch_complete',
    `[build] 全部 unit 结束：成功=${succeeded.length}，失败=${failed.length}，跳过=${skipped.length + notApplicable.length}`, {
      batch_id:       batchId,
      succeeded,
      failed,
      skipped,
      not_applicable: notApplicable,
      duration_ms:    batchDurMs,
    });

  // ── 14. 汇总与校验 ────────────────────────────────────────────────
  const completedAt    = Date.now();
  const completedAtStr = formatLocalTimeShort(new Date(completedAt));
  const durMs          = completedAt - startedAt;

  const hasTimedOut       = artifacts.some(a => a.timed_out);
  // 区分"超时失败"和"构建/产物校验失败"（用于退出码 3 vs 4 的判断）
  const hasBuildFailed    = artifacts.some(a => a.status === 'failed' && !a.timed_out);
  const hasFailed         = artifacts.some(a => a.status === 'failed');
  const overallOk         = !hasFailed;
  const overallStr        = overallOk ? 'success' : 'failed';

  const failedUnits  = artifacts
    .filter(a => a.status === 'failed')
    .map(a => `${a.client_target}:${a.sub_platform}`);

  // 构建 build_results 字段（sub_platform=default 时以 target 名为键，否则以 target:sub 为键）
  const buildResults = {};
  for (const a of artifacts) {
    const key = a.sub_platform === 'default' ? a.client_target : `${a.client_target}:${a.sub_platform}`;
    const artifactSize = a.artifact_path ? getDirSizeBytes(a.artifact_path) : 0;
    buildResults[key] = {
      status:              a.status,
      framework:           a.framework || null,
      command:             a.command || null,
      artifact_path:       a.artifact_path || null,
      artifact_size_bytes: artifactSize,
      duration_ms:         a.duration_ms,
      timed_out:           a.timed_out,
    };
  }

  // artifacts[] 精简版（去除运行时引用，保留 deploy 消费所需字段）
  const artifactsForJson = artifacts.map(a => ({
    client_target:  a.client_target,
    sub_platform:   a.sub_platform,
    framework:      a.framework || null,
    build_type:     a.build_type || null,
    command:        a.command || null,
    cwd:            a.cwd || null,
    artifact_path:  a.artifact_path || null,
    log_path:       a.log_path || null,
    status:         a.status,
    duration_ms:    a.duration_ms,
    artifact_check: a.artifact_check || { passed: false, missing_globs: [] },
    timed_out:      a.timed_out,
    exit_code:      a.exit_code != null ? a.exit_code : null,
  }));

  // 生成报告
  const reportDir  = path.join(paths.stageOutputDir('report'));
  const reportPath = paths.stageSummaryPath('build', 'build-summary.md');
  fs.mkdirSync(reportDir, { recursive: true });

  const reportContent = generateBuildReport({
    finalCommit,
    targetBranch,
    artifacts,
    startedAt,
    completedAt,
    effectiveParallel,
    validationPassed: overallOk,
  });
  fs.writeFileSync(reportPath, reportContent, 'utf8');

  // ── 15. 写 stages.json 完成态 ────────────────────────────────────
  const validationPassed = overallOk;
  const validationSummary = overallOk
    ? null
    : `构建失败：${failedUnits.join(', ')}`;

  stages = readStagesJson() || stages;
  stages.stages.build = Object.assign(stages.stages.build || {}, {
    status:       overallOk ? 'completed' : 'failed',
    started_at:   startedAtStr,
    completed_at: completedAtStr,
    inputs: {
      build_commit_hash: finalCommit,
      summary_hash:      summaryHash,
      client_targets:    targetSet,
    },
    outputs: {
      build_results:     buildResults,
      overall:           overallStr,
      failed_targets:    failedUnits,
      report_path:       reportPath,
      duration_ms:       durMs,
      timed_out:         hasTimedOut,
      timeout_reason:    hasTimedOut ? `unit(s) timed out: ${artifacts.filter(a => a.timed_out).map(a => `${a.client_target}:${a.sub_platform}`).join(', ')}` : null,
      artifacts:         artifactsForJson,
      build_units_total: buildUnits.length,
      failed_units:      failedUnits,
    },
    validation: {
      passed:                  validationPassed,
      checked_at:              completedAtStr,
      summary:                 validationSummary,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files: [reportPath],
    blocking_issues: failedUnits.length > 0
      ? [`构建失败的 unit：${failedUnits.join(', ')}`]
      : [],
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });
  stages.pipeline.updated_at          = completedAtStr;
  stages.pipeline.last_completed_stage = overallOk ? 'build' : (stages.pipeline.last_completed_stage || null);

  writeStagesJson(stages);
  releasePidLock();

  // ── 16. 最终日志与退出码 ─────────────────────────────────────────
  if (overallOk) {
    log.info('validation_pass', 'build 校验通过', {
      checks:   artifacts.length,
      warnings: [],
    });
    log.info('stage_complete',
      `build stage 完成，耗时 ${durMs}ms，成功 ${succeeded.length}/${buildUnits.length}`, {
        stage:       'build',
        exit_code:   0,
        duration_ms: durMs,
      });
    process.exit(0);
  }

  // 退出码：有构建/产物校验失败 → 4；纯超时（无其它失败）→ 3；其它 → 4
  const exitCode = hasBuildFailed ? 4 : (hasTimedOut ? 3 : 4);

  log.error('stage_failed',
    `build stage 失败，耗时 ${durMs}ms，失败 unit: ${failedUnits.join(', ')}`, {
      stage:       'build',
      exit_code:   exitCode,
      duration_ms: durMs,
      failed_units: failedUnits,
    });
  process.exit(exitCode);
}

main().catch(err => {
  console.error(`[FATAL] build.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  releasePidLock();
  process.exit(1);
});
