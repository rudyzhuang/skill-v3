'use strict';

/**
 * setup.cjs — setup stage 编排入口
 *
 * 执行顺序：
 *   0. 检测 stop.signal → exit 5
 *   1. hash 门控（已 completed + hash 命中 → skipped exit 0）
 *   2. setup-inputs.cjs（拷贝模板）
 *   3. 初始化/更新 stages.json（status=started）
 *   4. verify-inputs.cjs → 未通过 status=pending_user_input，exit 2
 *   5. sync-config-env.cjs → 失败 exit 1
 *   6. register-project.cjs → 失败 exit 1
 *   7. 写 setup 完成态 → exit 0
 *
 * 参数：
 *   --project=<路径>   业务项目根（绝对或相对）
 *   --run-id=<id>      run_id（由 run-pipeline 传入；缺失时自动生成）
 *   --force-rerun      强制跳过 hash 门控，重新执行
 */

const fs    = require('fs');
const path  = require('path');
const crypto = require('crypto');

const { createPipelinePaths } = require('../libs/pipeline-paths.cjs');
const { createLogger, formatLocalTimeShort, datetimeFromRunId } = require('../libs/logger.cjs');
const { setupInputs }    = require('../libs/setup-inputs.cjs');
const { verifyInputs }   = require('../libs/verify-inputs.cjs');
const { syncConfigEnv }  = require('../libs/sync-config-env.cjs');
const { registerProject, generateProjectId } = require('../libs/register-project.cjs');
const gitStageSync = require('../libs/git-stage-sync.cjs');
const { ensureProjectGitRepo } = require('../libs/resolve-project-git.cjs');

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

const skillsRoot = process.env.CURSOR_SKILLS_ROOT
  || path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const forceRerun = args['force-rerun'] === true || args['force-rerun'] === 'true';

// ── 生成 run_id（若未传入）──────────────────────────────────────────
function generateRunId() {
  const now = new Date();
  const y   = now.getFullYear();
  const mo  = String(now.getMonth() + 1).padStart(2, '0');
  const d   = String(now.getDate()).padStart(2, '0');
  const hr  = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const sec = String(now.getSeconds()).padStart(2, '0');
  const hex = crypto.randomBytes(4).toString('hex');
  return `${y}-${mo}-${d}_${hr}-${min}-${sec}-${hex}`;
}

const runId = args['run-id'] || generateRunId();

// ── 初始化 Logger ─────────────────────────────────────────────────
const log = createLogger({ projectRoot, stage: 'setup', runId });

// ── 工具函数 ──────────────────────────────────────────────────────
/** 计算文件 SHA-256 hex；文件不存在返回 null */
function fileSha256(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/** 读取 stages.json；不存在返回 null */
function readStagesJson() {
  return paths.readStagesJson();
}

/** 原子写入 stages.json */
function writeStagesJson(obj) {
  return paths.writeStagesJson(obj);
}

/** 探测 git 信息 */
function detectGitInfo() {
  const { execSync } = require('child_process');
  let remoteUrl    = null;
  let defaultBranch = 'main';

  try {
    remoteUrl = execSync('git remote get-url origin', {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).toString().trim() || null;
  } catch (_) { /* git 未初始化或无 remote */ }

  try {
    defaultBranch = execSync('git symbolic-ref --short HEAD', {
      cwd: projectRoot, stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
    }).toString().trim() || 'main';
  } catch (_) { /* ignore */ }

  return { remoteUrl, defaultBranch };
}

// ── 主流程 ────────────────────────────────────────────────────────
async function main() {
  const startedAt = new Date();
  const startedAtStr = formatLocalTimeShort(startedAt);

  // 0. 检测 stop.signal
  const stopSignalPath = paths.stopSignalPath;
  if (fs.existsSync(stopSignalPath)) {
    log.info('pipeline_stop', '检测到 stop.signal，立即中止 setup', {
      stage: 'setup',
      reason: (() => {
        try { return JSON.parse(fs.readFileSync(stopSignalPath, 'utf8')).reason; } catch (_) { return 'unknown'; }
      })(),
      stopped_at: formatLocalTimeShort(),
    });

    // 写 stopped 状态（如果 stages.json 存在）
    const stages = readStagesJson();
    if (stages && stages.stages && stages.stages.setup) {
      stages.stages.setup.status = 'stopped';
      stages.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stages);
    }

    log.info('pipeline_stopped', 'setup 已优雅停止', {
      stage: 'setup',
      stopped_at: formatLocalTimeShort(),
      exit_code: 5,
    });
    process.exit(5);
  }

  // stage_start 日志
  log.info('stage_start', `setup stage 启动，项目: ${projectRoot}`, {
    run_id: runId,
    stage: 'setup',
    project: projectRoot,
    started_at: startedAtStr,
  });

  // 1. hash 门控
  if (!forceRerun) {
    const existing = readStagesJson();
    if (existing && existing.stages && existing.stages.setup) {
      const setupStage = existing.stages.setup;
      if (setupStage.status === 'completed') {
        const reqMdPath    = path.join(projectRoot, 'inputs', 'req.md');
        const configEnvPath = path.join(projectRoot, 'inputs', 'config.env');

        const currentReqHash    = fileSha256(reqMdPath);
        const currentConfigHash = fileSha256(configEnvPath);

        const storedReqHash    = setupStage.inputs && setupStage.inputs.req_hash;
        const storedConfigHash = setupStage.inputs && setupStage.inputs.config_env_hash;

        const reqHit    = currentReqHash    && storedReqHash    && currentReqHash    === storedReqHash;
        const configHit = (currentConfigHash === storedConfigHash) ||
                          (currentConfigHash === null && storedConfigHash === null);

        log.info('hash_check', 'hash 门控检查', {
          file: 'req.md',
          stored_hash: storedReqHash || null,
          computed_hash: currentReqHash,
          hit: !!reqHit,
        });
        log.info('hash_check', 'hash 门控检查', {
          file: 'config.env',
          stored_hash: storedConfigHash || null,
          computed_hash: currentConfigHash,
          hit: !!configHit,
        });

        if (reqHit && configHit) {
          log.info('stage_skipped', 'setup hash 门控命中，跳过执行', {
            stage: 'setup',
            reason: 'hash_match',
          });
          process.exit(0);
        }
      }
    }
  }

  // 2. setup-inputs（拷贝模板）
  let reqMdPath, configEnvPath;
  try {
    const result = setupInputs({ projectRoot, skillsRoot, runId, logger: log });
    reqMdPath    = result.reqMdPath;
    configEnvPath = result.configEnvPath;
  } catch (err) {
    const durationMs = Date.now() - startedAt.getTime();
    log.error('stage_failed', `setup-inputs 失败: ${err.message}`, {
      stage: 'setup', step: 'setup-inputs', exit_code: 1, reason: err.message, duration_ms: durationMs,
    });
    process.exit(1);
  }

  // 3. 初始化/更新 stages.json
  const reqHash    = fileSha256(reqMdPath);
  const configHash = fileSha256(configEnvPath);

  let stagesObj = readStagesJson();
  const pipelineDir = path.join(projectRoot, '.pipeline');

  if (!stagesObj) {
    // 从模板拷贝并初始化
    const templatePath = path.join(skillsRoot, 'ai-std4', 'templates', 'stages.json.template');
    let template;
    try {
      template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));
    } catch (_) {
      template = { pipeline: { current_stage: null, last_completed_stage: null, updated_at: null, updated_by: 'ai-std4', project: { project_id: null, root_path: null, name: null, git: { remote: null, remote_url: null, default_branch: null, repo_initialized_at: null, remote_configured_at: null } } }, stages: {} };
    }

    // 探测 git
    const git = detectGitInfo();

    stagesObj = template;
    stagesObj.pipeline.updated_by = 'ai-std4';
    stagesObj.pipeline.project = {
      project_id: generateProjectId(projectRoot),
      root_path:  projectRoot,
      name:       null, // 由 register-project 更新
      git: {
        remote:               'origin',
        remote_url:           git.remoteUrl,
        default_branch:       git.defaultBranch,
        repo_initialized_at:  null,
        remote_configured_at: null,
      },
    };

    // 初始化 stages.setup
    stagesObj.stages.setup = buildSetupStage({ status: 'started', startedAtStr, reqHash, configHash, reqMdPath, configEnvPath });

    const stagesPath = writeStagesJson(stagesObj);
    const stat = fs.statSync(stagesPath);
    log.info('file_created', '已从模板创建 output-stages/stages.json', {
      path: stagesPath,
      size_bytes: stat.size,
      from_template: true,
    });
  } else {
    // 更新 stages.setup 部分，不重置其它 stage 状态
    if (!stagesObj.stages) stagesObj.stages = {};
    stagesObj.stages.setup = buildSetupStage({
      status: 'started',
      startedAtStr,
      reqHash,
      configHash,
      reqMdPath,
      configEnvPath,
      existing: stagesObj.stages.setup, // 保留现有字段
    });
    stagesObj.pipeline.updated_at = formatLocalTimeShort();

    const stagesPath = writeStagesJson(stagesObj);
    const stat = fs.statSync(stagesPath);
    log.info('file_updated', '已更新 output-stages/stages.json（status=started）', {
      path: stagesPath,
      size_bytes: stat.size,
    });
  }

  // 4. verify-inputs
  let verifyResult;
  try {
    verifyResult = verifyInputs({ projectRoot, runId, logger: log });
  } catch (err) {
    verifyResult = { passed: false, missing: [err.message], warnings: [] };
  }

  if (!verifyResult.passed) {
    // 写 pending_user_input 状态
    stagesObj = readStagesJson();
    if (stagesObj) {
      stagesObj.stages.setup.status = 'pending_user_input';
      stagesObj.stages.setup.validation = {
        passed: false,
        checked_at: formatLocalTimeShort(),
        summary: `缺少必填项: ${verifyResult.missing.join('; ')}`,
        required_files: [],
        missing_required_fields: verifyResult.missing,
        warnings: verifyResult.warnings || [],
      };
      stagesObj.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stagesObj);
    }

    const durationMs = Date.now() - startedAt.getTime();
    log.error('stage_failed', `inputs 校验未通过，等待用户补全`, {
      stage: 'setup',
      step: 'verify-inputs',
      exit_code: 2,
      reason: `missing: ${verifyResult.missing.join(', ')}`,
      duration_ms: durationMs,
    });
    console.error('\n请补全以下内容后重跑 setup：');
    verifyResult.missing.forEach(m => console.error(`  - ${m}`));
    console.error(`\n补全后运行：node ai-std4/scripts/stages/setup.cjs --project=${projectRoot}`);
    process.exit(2);
  }

  // 5. sync-config-env
  let syncResult;
  try {
    syncResult = syncConfigEnv({ projectRoot, skillsRoot, runId, logger: log });
  } catch (err) {
    stagesObj = readStagesJson();
    if (stagesObj) {
      stagesObj.stages.setup.status = 'failed';
      stagesObj.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stagesObj);
    }
    const durationMs = Date.now() - startedAt.getTime();
    log.error('stage_failed', `sync-config-env 失败: ${err.message}`, {
      stage: 'setup', step: 'sync-config-env', exit_code: 1, reason: err.message, duration_ms: durationMs,
    });
    process.exit(1);
  }

  // 6. register-project
  let regResult;
  try {
    regResult = registerProject({ projectRoot, skillsRoot, runId, logger: log });
  } catch (err) {
    stagesObj = readStagesJson();
    if (stagesObj) {
      stagesObj.stages.setup.status = 'failed';
      stagesObj.pipeline.updated_at = formatLocalTimeShort();
      writeStagesJson(stagesObj);
    }
    const durationMs = Date.now() - startedAt.getTime();
    log.error('stage_failed', `register-project 失败: ${err.message}`, {
      stage: 'setup', step: 'register-project', exit_code: 1, reason: err.message, duration_ms: durationMs,
    });
    process.exit(1);
  }

  // 6b. 业务项目 Git 作用域（父仓子目录时嵌套 init，避免 codegen 检出整仓）
  let configDevForGit = {};
  const configDevPathEarly = path.join(projectRoot, 'docs', 'config.dev.json');
  if (fs.existsSync(configDevPathEarly)) {
    try {
      configDevForGit = JSON.parse(fs.readFileSync(configDevPathEarly, 'utf8'));
    } catch (_) { /* ignore */ }
  }
  const gitScope = ensureProjectGitRepo(projectRoot, { config: configDevForGit, log });
  if (!gitScope.ok) {
    log.warn('validation_fail', '业务项目 git 初始化失败（不阻断 setup）', {
      reason: gitScope.reason,
    });
  }

  // 7. 写 setup 完成态
  const completedAt    = new Date();
  const completedAtStr = formatLocalTimeShort(completedAt);
  const durationMs     = completedAt.getTime() - startedAt.getTime();

  stagesObj = readStagesJson();
  if (!stagesObj) {
    log.error('stage_failed', 'stages.json 丢失，无法写完成态', {
      stage: 'setup', exit_code: 1, reason: 'stages.json missing', duration_ms: durationMs,
    });
    process.exit(1);
  }

  stagesObj.pipeline.current_stage       = 'setup';
  stagesObj.pipeline.last_completed_stage = 'setup';
  stagesObj.pipeline.updated_at          = completedAtStr;
  stagesObj.pipeline.project.project_id  = regResult.projectId;
  stagesObj.pipeline.project.name        = regResult.projectName;

  const configDevPath = syncResult.configDevPath;
  if (configDevPath && fs.existsSync(configDevPath)) {
    try {
      const configDev = JSON.parse(fs.readFileSync(configDevPath, 'utf8'));
      stagesObj = gitStageSync.applyGitConfigToStages(stagesObj, configDev);
      const g = gitStageSync.resolveGitConfig(configDev);
      const init = ensureProjectGitRepo(projectRoot, { config: configDev, log });
      if (!init.ok) {
        log.warn('validation_fail', 'git 仓库初始化失败（不阻断 setup）', {
          reason: init.reason,
        });
      } else {
        if (stagesObj.pipeline.project.git) {
          if (init.action === 'init_nested' || init.action === 'existing') {
            stagesObj.pipeline.project.git.repo_initialized_at =
              stagesObj.pipeline.project.git.repo_initialized_at || completedAtStr;
          }
          if (g.remote_url && init.ok) {
            stagesObj.pipeline.project.git.remote_configured_at = completedAtStr;
          }
        }
      }
      log.info('file_updated', '已从 config.dev.json 同步 pipeline.project.git', {
        remote: g.remote,
        default_branch: g.default_branch,
        auto_commit: g.auto_commit,
        allow_push: g.allow_push,
        remote_url_configured: !!g.remote_url,
      });
    } catch (e) {
      log.warn('validation_fail', '读取 config.dev.json 同步 git 配置失败', {
        reason: e.message,
      });
    }
  }

  stagesObj.stages.setup = {
    status:       'completed',
    started_at:   startedAtStr,
    completed_at: completedAtStr,
    inputs: {
      source_prd_spec:  reqMdPath,
      req_hash:         reqHash,
      config_env_hash:  configHash,
      summary_hash:     reqHash,   // schema 要求字段，与 req_hash 保持一致
      raw_input_refs:   [],
    },
    outputs: {
      config_dev:      syncResult.configDevPath,
      config_release:  syncResult.configReleasePath,
      config_env:      syncResult.configEnvDestPath,
      client_targets:  [],
      duration_ms:     durationMs,
      timed_out:       false,
      timeout_reason:  null,
    },
    validation: {
      passed:                  true,
      checked_at:              completedAtStr,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                verifyResult.warnings || [],
    },
    generated_files: [
      reqMdPath,
      configEnvPath,
      syncResult.configDevPath,
      syncResult.configReleasePath,
      syncResult.configEnvDestPath,
      regResult.runtimeJsonPath,
    ],
    blocking_issues: [],
    git_sync: {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  };

  const stagesPath = writeStagesJson(stagesObj);
  const stat = fs.statSync(stagesPath);
  log.info('file_updated', '已写入 setup 完成态', {
    path: stagesPath,
    size_bytes: stat.size,
    status: 'completed',
  });

  log.info('stage_complete', `setup stage 完成，耗时 ${durationMs}ms`, {
    stage: 'setup',
    duration_ms: durationMs,
    exit_code: 0,
  });

  process.exit(0);
}

/**
 * 构建 stages.setup 对象（仅包含初始/started 字段）
 */
function buildSetupStage({ status, startedAtStr, reqHash, configHash, reqMdPath, configEnvPath, existing }) {
  const base = existing || {};
  return Object.assign({}, base, {
    status,
    started_at:   startedAtStr,
    completed_at: base.completed_at || null,
    inputs: Object.assign({}, base.inputs || {}, {
      source_prd_spec:  reqMdPath,
      req_hash:         reqHash,
      config_env_hash:  configHash,
      summary_hash:     reqHash,
      raw_input_refs:   [],
    }),
    outputs: base.outputs || {
      config_dev:     null,
      config_release: null,
      config_env:     null,
      client_targets: [],
      duration_ms:    null,
      timed_out:      false,
      timeout_reason: null,
    },
    validation: base.validation || {
      passed:                  false,
      checked_at:              null,
      summary:                 null,
      required_files:          [],
      missing_required_fields: [],
      warnings:                [],
    },
    generated_files:  base.generated_files  || [],
    blocking_issues:  base.blocking_issues  || [],
    git_sync: base.git_sync || {
      initial_pushed_at:       null,
      docs_pipeline_pushed_at: null,
      last_commit:             null,
      last_push_status:        null,
    },
  });
}

main().catch(err => {
  console.error(`[FATAL] setup.cjs 未捕获异常: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
