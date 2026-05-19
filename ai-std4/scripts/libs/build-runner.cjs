'use strict';

/**
 * build-runner.cjs — 单个 build unit 构建执行器
 *
 * 职责：
 * - 子进程执行构建命令（sh -c）
 * - stdout/stderr tee 到分 unit 日志文件
 * - 定期写 build_unit_progress 日志（每 ≥5s 或 ≥200 行）
 * - 挂钟超时控制（单个 unit）
 * - 产物存在性校验（artifact_globs）
 * - 返回 unit 结果对象
 */

const fs            = require('fs');
const path          = require('path');
const { spawn }     = require('child_process');
const { formatLocalTimeShort } = require('./logger.cjs');

// ── 简单 glob 匹配（不依赖第三方库）────────────────────────────────

/**
 * 递归获取目录下所有文件路径（绝对路径）
 */
function getAllFilesRecursive(dir, maxDepth = 8, depth = 0) {
  if (depth > maxDepth) return [];
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllFilesRecursive(full, maxDepth, depth + 1));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * 简单 glob 匹配（支持 ** 和 *）
 * pattern 和 str 都是相对路径（/ 分隔）
 */
function matchGlobPattern(pattern, str) {
  // 转换为正则
  const re = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars (except * ?)
    .replace(/\\\*\\\*/g, '<<DOUBLE_STAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLE_STAR>>/g, '.*');
  try {
    return new RegExp(`^${re}$`).test(str);
  } catch (_) {
    return false;
  }
}

/**
 * 在 baseDir 内匹配 glob pattern，返回命中的绝对路径列表
 * baseDir 是 probeRoot
 */
function globMatch(baseDir, pattern) {
  // 获取 pattern 中直到第一个通配符之前的目录
  const parts     = pattern.split('/');
  let   staticDir = baseDir;
  let   rest      = pattern;

  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes('*') || parts[i].includes('?')) {
      rest = parts.slice(i).join('/');
      break;
    }
    staticDir = path.join(staticDir, parts[i]);
    rest      = parts.slice(i + 1).join('/');
  }

  if (!fs.existsSync(staticDir)) return [];
  if (!rest) {
    // 静态路径，直接检查是否存在
    return fs.existsSync(staticDir) ? [staticDir] : [];
  }

  const allFiles = getAllFilesRecursive(staticDir);
  return allFiles.filter(f => {
    const rel = path.relative(staticDir, f).replace(/\\/g, '/');
    return matchGlobPattern(rest, rel);
  });
}

/**
 * 校验产物是否存在（artifact_globs）
 * @param {string}   cwd          构建 cwd（probeRoot）
 * @param {string[]} globs        artifact_globs 列表
 * @returns {{ passed: boolean, missing_globs: string[], found_files: string[] }}
 */
function checkArtifacts(cwd, globs) {
  const missingGlobs = [];
  const foundFiles   = [];

  for (const g of globs) {
    const hits = globMatch(cwd, g);
    if (hits.length === 0) {
      missingGlobs.push(g);
    } else {
      foundFiles.push(...hits.slice(0, 3)); // 只记录前 3 个
    }
  }

  // 只要有任意一个 glob 命中就算通过
  return {
    passed:        foundFiles.length > 0,
    missing_globs: missingGlobs,
    found_files:   foundFiles,
  };
}

/**
 * 执行单个 build unit（包括可选的 install 步骤）
 *
 * @param {object} opts
 * @param {string} opts.clientTarget
 * @param {string} opts.subPlatform
 * @param {string} opts.command          构建命令
 * @param {string} opts.cwd             工作目录
 * @param {string} opts.framework
 * @param {string} opts.build_type
 * @param {string[]} opts.artifact_globs
 * @param {string|null} opts.installCommand   install 命令（null 则跳过）
 * @param {boolean}     opts.installBeforeBuild
 * @param {number}      opts.timeoutMs     单 unit 超时（毫秒）
 * @param {number}      opts.installTimeoutMs
 * @param {string}      opts.logDir         日志目录（<project>/logs/stages/build/）
 * @param {string}      opts.datetime        日志文件名前缀
 * @param {string}      opts.projectRoot
 * @param {object}      opts.log            logger 实例
 * @param {Function}    opts.checkStop       检查 stop.signal 的函数
 * @returns {Promise<UnitResult>}
 */
async function runUnit(opts) {
  const {
    clientTarget,
    subPlatform,
    command,
    cwd,
    framework,
    build_type,
    artifact_globs,
    installCommand,
    installBeforeBuild = true,
    timeoutMs          = 300_000,
    installTimeoutMs,
    logDir,
    datetime,
    projectRoot,
    log,
    checkStop,
  } = opts;

  const effectiveInstallTimeout = installTimeoutMs ||
        Math.min(120_000, Math.floor(timeoutMs / 3));

  const unitKey  = `${clientTarget}-${subPlatform}`;
  const logFile  = path.join(logDir, `${datetime}-${unitKey}.log`);
  fs.mkdirSync(logDir, { recursive: true });

  const startedAt = Date.now();

  // ── 跳过类型处理 ─────────────────────────────────────────────────
  if (build_type === 'skipped' || build_type === 'not_applicable') {
    log.info('build_unit_complete',
      `[build] ${clientTarget}/${subPlatform} ${build_type}，跳过`, {
        client_target: clientTarget,
        sub_platform:  subPlatform,
        duration_ms:   0,
        artifact_path: null,
        artifact_check: { passed: true, missing_globs: [] },
      });
    return {
      client_target:  clientTarget,
      sub_platform:   subPlatform,
      framework,
      build_type,
      command,
      cwd,
      artifact_path:  null,
      log_path:       logFile,
      status:         build_type,
      duration_ms:    0,
      artifact_check: { passed: true, missing_globs: [] },
      timed_out:      false,
      exit_code:      null,
    };
  }

  if (build_type === 'not_configured') {
    log.error('build_unit_failed',
      `[build] ${clientTarget}/${subPlatform} 未配置构建命令`, {
        client_target: clientTarget,
        sub_platform:  subPlatform,
        duration_ms:   0,
        exit_code:     null,
        timed_out:     false,
        reason:        'build_type=not_configured，无命令',
        log_path:      logFile,
      });
    return {
      client_target:  clientTarget,
      sub_platform:   subPlatform,
      framework,
      build_type,
      command:        null,
      cwd,
      artifact_path:  null,
      log_path:       logFile,
      status:         'failed',
      duration_ms:    0,
      artifact_check: { passed: false, missing_globs: artifact_globs },
      timed_out:      false,
      exit_code:      null,
    };
  }

  log.info('build_unit_start',
    `[build] ${clientTarget}/${subPlatform} 开始：${framework}，cmd=${command}，cwd=${cwd}`, {
      client_target: clientTarget,
      sub_platform:  subPlatform,
      command,
      cwd,
      framework,
      build_type,
      log_path:      logFile,
    });

  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  // ── install 步骤 ─────────────────────────────────────────────────
  if (installBeforeBuild && installCommand) {
    const installResult = await spawnWithTimeout({
      command:    installCommand,
      cwd,
      env:        buildEnv(projectRoot, clientTarget, subPlatform),
      timeoutMs:  effectiveInstallTimeout,
      logStream,
      onProgress: null,
    });

    if (!installResult.success) {
      const durMs = Date.now() - startedAt;
      logStream.end();
      log.error('build_unit_failed',
        `[build] ${clientTarget}/${subPlatform} install 失败，exit=${installResult.exitCode}`, {
          client_target: clientTarget,
          sub_platform:  subPlatform,
          duration_ms:   durMs,
          exit_code:     installResult.exitCode,
          timed_out:     installResult.timedOut,
          reason:        `install 失败: ${installCommand}`,
          log_path:      logFile,
        });
      return {
        client_target:  clientTarget,
        sub_platform:   subPlatform,
        framework,
        build_type,
        command,
        cwd,
        artifact_path:  null,
        log_path:       logFile,
        status:         'failed',
        duration_ms:    durMs,
        artifact_check: { passed: false, missing_globs: artifact_globs },
        timed_out:      installResult.timedOut,
        exit_code:      installResult.exitCode,
      };
    }
  }

  // ── 构建步骤 ─────────────────────────────────────────────────────
  let linesStdout    = 0;
  let linesStderr    = 0;
  let lastProgressAt = Date.now();

  const buildResult = await spawnWithTimeout({
    command:   command,
    cwd,
    env:       buildEnv(projectRoot, clientTarget, subPlatform),
    timeoutMs,
    logStream,
    onProgress: (type, lines) => {
      if (type === 'stdout') linesStdout += lines;
      else                   linesStderr += lines;

      const now     = Date.now();
      const elapsed = now - startedAt;
      const sinceLP = now - lastProgressAt;

      if (sinceLP >= 5000 || linesStdout + linesStderr % 200 === 0) {
        lastProgressAt = now;
        log.info('build_unit_progress',
          `[build] ${clientTarget}/${subPlatform} 进行中 ${Math.floor(elapsed / 1000)}s`, {
            client_target: clientTarget,
            sub_platform:  subPlatform,
            elapsed_ms:    elapsed,
            lines_stdout:  linesStdout,
            lines_stderr:  linesStderr,
          });
        // 每次进度心跳也检查 stop.signal
        if (checkStop && checkStop()) return true; // 返回 true 表示请求终止
      }
      return false;
    },
  });

  const durMs = Date.now() - startedAt;
  logStream.end();

  // ── 超时处理 ─────────────────────────────────────────────────────
  if (buildResult.timedOut) {
    log.error('build_unit_failed',
      `[build] ${clientTarget}/${subPlatform} 超时（${timeoutMs}ms）`, {
        client_target: clientTarget,
        sub_platform:  subPlatform,
        duration_ms:   durMs,
        exit_code:     null,
        timed_out:     true,
        reason:        `超时 ${timeoutMs}ms`,
        log_path:      logFile,
      });
    return {
      client_target:  clientTarget,
      sub_platform:   subPlatform,
      framework,
      build_type,
      command,
      cwd,
      artifact_path:  null,
      log_path:       logFile,
      status:         'failed',
      duration_ms:    durMs,
      artifact_check: { passed: false, missing_globs: artifact_globs },
      timed_out:      true,
      exit_code:      null,
    };
  }

  // ── 命令失败 ─────────────────────────────────────────────────────
  if (!buildResult.success) {
    log.error('build_unit_failed',
      `[build] ${clientTarget}/${subPlatform} 构建失败，exit=${buildResult.exitCode}，cmd=${command}，log=${path.relative(projectRoot, logFile)}`, {
        client_target: clientTarget,
        sub_platform:  subPlatform,
        duration_ms:   durMs,
        exit_code:     buildResult.exitCode,
        timed_out:     false,
        reason:        `exit_code=${buildResult.exitCode}`,
        log_path:      logFile,
      });
    return {
      client_target:  clientTarget,
      sub_platform:   subPlatform,
      framework,
      build_type,
      command,
      cwd,
      artifact_path:  null,
      log_path:       logFile,
      status:         'failed',
      duration_ms:    durMs,
      artifact_check: { passed: false, missing_globs: artifact_globs },
      timed_out:      false,
      exit_code:      buildResult.exitCode,
    };
  }

  // ── 产物校验 ─────────────────────────────────────────────────────
  const artifactCheck = checkArtifacts(cwd, artifact_globs);

  log.info('artifact_check',
    `[build] ${clientTarget}/${subPlatform} 产物校验 ${artifactCheck.passed ? '通过' : '失败'}`, {
      client_target: clientTarget,
      sub_platform:  subPlatform,
      passed:        artifactCheck.passed,
      missing_globs: artifactCheck.missing_globs,
    });

  if (!artifactCheck.passed) {
    log.error('build_unit_failed',
      `[build] ${clientTarget}/${subPlatform} 产物缺失，missing=${artifactCheck.missing_globs.join(',')}`, {
        client_target: clientTarget,
        sub_platform:  subPlatform,
        duration_ms:   durMs,
        exit_code:     buildResult.exitCode,
        timed_out:     false,
        reason:        `产物缺失: ${artifactCheck.missing_globs.join(', ')}`,
        log_path:      logFile,
      });
    return {
      client_target:  clientTarget,
      sub_platform:   subPlatform,
      framework,
      build_type,
      command,
      cwd,
      artifact_path:  artifactCheck.found_files[0] || null,
      log_path:       logFile,
      status:         'failed',
      duration_ms:    durMs,
      artifact_check: { passed: false, missing_globs: artifactCheck.missing_globs },
      timed_out:      false,
      exit_code:      buildResult.exitCode,
    };
  }

  // ── 成功 ─────────────────────────────────────────────────────────
  // 计算产物目录（找最短公共父路径）
  const artifactPath = resolveArtifactPath(
    artifactCheck.found_files, cwd, artifact_globs
  );

  log.info('build_unit_complete',
    `[build] ${clientTarget}/${subPlatform} 完成，耗时 ${durMs}ms，产物: ${artifactPath}`, {
      client_target: clientTarget,
      sub_platform:  subPlatform,
      duration_ms:   durMs,
      artifact_path: artifactPath,
      artifact_check: { passed: true, missing_globs: [] },
    });

  return {
    client_target:  clientTarget,
    sub_platform:   subPlatform,
    framework,
    build_type,
    command,
    cwd,
    artifact_path:  artifactPath,
    log_path:       logFile,
    status:         'completed',
    duration_ms:    durMs,
    artifact_check: { passed: true, missing_globs: [] },
    timed_out:      false,
    exit_code:      buildResult.exitCode,
  };
}

// ── 辅助函数 ──────────────────────────────────────────────────────

/** 注入环境变量 */
function buildEnv(projectRoot, clientTarget, subPlatform) {
  return Object.assign({}, process.env, {
    AI_STD4_PROJECT_ROOT:  projectRoot,
    AI_STD4_CLIENT_TARGET: clientTarget,
    AI_STD4_SUB_PLATFORM:  subPlatform,
  });
}

/**
 * 带超时的子进程执行
 * @returns {Promise<{success, exitCode, timedOut}>}
 */
function spawnWithTimeout({ command, cwd, env, timeoutMs, logStream, onProgress }) {
  return new Promise(resolve => {
    let   finished = false;
    const child    = spawn('sh', ['-c', command], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill('SIGTERM'); } catch (_) {}
        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (_) {}
        }, 3000);
        resolve({ success: false, exitCode: null, timedOut: true });
      }
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      if (logStream && !logStream.destroyed) logStream.write(chunk);
      const lines = chunk.toString().split('\n').length - 1;
      if (onProgress) onProgress('stdout', lines);
    });

    child.stderr.on('data', chunk => {
      if (logStream && !logStream.destroyed) logStream.write(chunk);
      const lines = chunk.toString().split('\n').length - 1;
      if (onProgress) onProgress('stderr', lines);
    });

    child.on('close', code => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ success: code === 0, exitCode: code, timedOut: false });
      }
    });

    child.on('error', err => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        if (logStream && !logStream.destroyed) {
          logStream.write(`[spawn error] ${err.message}\n`);
        }
        resolve({ success: false, exitCode: null, timedOut: false });
      }
    });
  });
}

/**
 * 从命中文件列表计算 artifact_path（最短合理公共路径）
 */
function resolveArtifactPath(foundFiles, cwd, globs) {
  if (foundFiles.length === 0) {
    // 从 glob 中取第一个 static 前缀
    const firstGlob = globs[0] || 'dist';
    const parts     = firstGlob.split('/');
    const staticParts = [];
    for (const p of parts) {
      if (p.includes('*')) break;
      staticParts.push(p);
    }
    return path.join(cwd, staticParts.join('/'));
  }

  // 找公共父目录
  const dirs = foundFiles.map(f => path.dirname(f));
  if (dirs.length === 1) return dirs[0];

  let common = dirs[0];
  for (const d of dirs.slice(1)) {
    while (!d.startsWith(common)) {
      common = path.dirname(common);
      if (common === path.dirname(common)) break;
    }
  }
  return common;
}

module.exports = { runUnit, checkArtifacts, globMatch, spawnWithTimeout };
