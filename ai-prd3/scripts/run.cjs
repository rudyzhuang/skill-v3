'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, requireProject, skillDirFrom, prdSpecPath } = require('./lib/paths.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');
const { spawnSyncWithTimeout, readStageTimeoutSec } = require('./lib/run-with-timeout.cjs');
const { markPrdFailed, markPrdTimeout, markPrdReviewTimeout } = require('./lib/stage-status.cjs');
const { appendSessionLog } = require('./lib/session-log.cjs');

function useTimeout(args) {
  if (args.noTimeout) return false;
  if (process.env.AI_PRD3_NO_TIMEOUT === '1') return false;
  return true;
}

/**
 * @param {'prd'|'prd_review'|null} timeoutStage null = 不启用超时
 */
function runNodeScript(scriptDir, scriptName, project, args, extraArgs = [], timeoutStage = null) {
  const full = path.join(scriptDir, scriptName);
  const argv = [full, `--project=${project}`, ...extraArgs];
  const sec =
    useTimeout(args) && timeoutStage
      ? readStageTimeoutSec(project, timeoutStage === 'prd_review' ? 'prd_review' : 'prd')
      : 0;
  const t0 = Date.now();
  const stdio = ['inherit', 'pipe', 'pipe'];
  const r =
    sec > 0
      ? spawnSyncWithTimeout(process.execPath, argv, { encoding: 'utf8', stdio }, sec * 1000)
      : spawnSync(process.execPath, argv, { encoding: 'utf8', stdio });
  const timedOut = !!(r.timedOut || (r.error && r.error.code === 'ETIMEDOUT'));
  if (timedOut && timeoutStage) {
    const ms = Date.now() - t0;
    if (timeoutStage === 'prd_review') markPrdReviewTimeout(project, ms, 'stage_timeout');
    else markPrdTimeout(project, ms, 'stage_timeout');
    console.error('子进程超时:', scriptName);
    return { status: 3, timedOut: true, stderr: r.stderr, stdout: r.stdout };
  }
  return { status: r.status ?? 1, timedOut: false, stderr: r.stderr, stdout: r.stdout };
}

function main() {
  const args = parseArgs(process.argv);
  const sub = args._[0] || '';
  const sessionId = args.sessionId || process.env.AI_SESSION_ID || '';

  process.on('SIGINT', () => {
    try {
      if (args.project && path.isAbsolute(args.project)) {
        const root = path.resolve(args.project);
        if (fs.existsSync(root)) {
          appendSessionLog(root, {
            subcommand: sub,
            event: 'sigint',
            session_id: sessionId,
            exit_code: 2,
          });
        }
      }
    } catch (_) {
      /* ignore */
    }
    process.exit(2);
  });

  const project = requireProject(args);
  const skillDir = skillDirFrom(__filename);
  const scriptDir = path.join(skillDir, 'scripts');

  function done(code) {
    appendSessionLog(project, {
      subcommand: sub || '',
      event: 'exit',
      session_id: sessionId,
      exit_code: code,
    });
    process.exit(code);
  }

  appendSessionLog(project, {
    subcommand: sub || 'help',
    event: 'invoke',
    session_id: sessionId,
    argv: process.argv.slice(2),
  });

  if (!sub || sub === 'help' || sub === '-h') {
    console.log(`用法: node scripts/run.cjs <子命令> --project=<绝对路径> [选项]

子命令:
  bootstrap | parse-targets | validate-prd | write-prd |
  validate-prd-review | write-prd-review | report

选项:
  --force  覆盖已完成阶段（prd / prd-review）；bootstrap 在 prd 已完成时须加此选项
  --no-timeout  禁用 config 中的阶段超时（冒烟/调试可用；亦支持环境变量 AI_PRD3_NO_TIMEOUT=1）
  --lang=cn|en  bootstrap 选用 prd-spec 模板语言
  --allow-fill-missing-keys  bootstrap：config 相对模板缺键时做 additive 补齐（prd3.md §7.2）
  --session-id=<id>  写入 .agent-sessions/ai-prd3.ndjson 与 <id>.log（prd3.md §11）
  --json=<path>  write-prd-review 合并用 JSON（绝对路径或相对项目根）

report:
  在 prd_review 已完成且 outputs.decision=passed 时，依据 phase_plan 与各端 feature_list 生成「人话版」实施节奏摘要；
  写入 .pipeline/reports/prd-implementation-summary.md 并 stdout 输出全文（prd3.md §8.8）。
  validate-prd-review 终检通过时也会自动写入该文件。

超时（prd3.md §11）：默认读取 docs/config.dev.json → timeouts.stages.prd_s / prd_review_s（秒），
子进程超时将写 stages.*.outputs.timed_out 并以退出码 3 结束。
用户中断（Ctrl+C）→ 退出码 2（prd3.md §7.4 / SKILL.md）。
`);
    done(sub ? 0 : 1);
  }

  if (sub === 'bootstrap') {
    const extra = [];
    if (args.lang === 'en') extra.push('--lang=en');
    else extra.push('--lang=cn');
    if (args.force) extra.push('--force');
    if (args.allowFillMissingKeys) extra.push('--allow-fill-missing-keys');
    const r = runNodeScript(scriptDir, 'prd-bootstrap.cjs', project, args, extra, 'prd');
    appendSessionLog(project, {
      subcommand: 'bootstrap',
      event: 'child_done',
      session_id: sessionId,
      script: 'prd-bootstrap.cjs',
      exit_code: r.timedOut ? 3 : r.status,
    });
    if (r.timedOut) done(3);
    done(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'parse-targets') {
    const spec = prdSpecPath(project);
    if (!fs.existsSync(spec)) {
      console.error('缺少', spec);
      done(1);
    }
    const text = fs.readFileSync(spec, 'utf8');
    let p = parseClientTargets(text);
    if (!p.ok && p.error === 'missing_client_targets_heading') {
      const leg = tryLegacyYaml(text);
      if (leg && leg.length) p = { ok: true, slugs: leg, legacy: true };
    }
    if (!p.ok) {
      console.error(JSON.stringify({ ok: false, error: p.error }, null, 2));
      done(1);
    }
    console.log(JSON.stringify({ declared: p.slugs, legacy: !!p.legacy }, null, 2));
    done(0);
  }

  if (sub === 'validate-prd') {
    const steps = ['prd-validate-spec.cjs', 'prd-validate-derived.cjs', 'prd-validate-config.cjs'];
    for (const s of steps) {
      const r = runNodeScript(scriptDir, s, project, args, [], 'prd');
      if (r.timedOut) done(3);
      if (r.status !== 0) {
        console.error(r.stderr || r.stdout);
        markPrdFailed(project, `validate_failed:${s}`);
        appendSessionLog(project, {
          subcommand: 'validate-prd',
          event: 'validate_step_failed',
          session_id: sessionId,
          script: s,
          exit_code: r.status || 1,
        });
        done(r.status || 1);
      }
    }
    done(0);
  }

  if (sub === 'write-prd') {
    const extra = args.force ? ['--force'] : [];
    const r = runNodeScript(scriptDir, 'prd-write-stage.cjs', project, args, extra, 'prd');
    if (r.timedOut) done(3);
    done(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'validate-prd-review') {
    const r = runNodeScript(scriptDir, 'prd-review-validate.cjs', project, args, [], 'prd_review');
    if (r.timedOut) done(3);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    done(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'report') {
    const r = runNodeScript(scriptDir, 'prd-implementation-report.cjs', project, args, [], null);
    if (r.timedOut) done(3);
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    done(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'write-prd-review') {
    if (!args.json) {
      console.error('缺少 --json=');
      done(1);
    }
    const extra = [`--json=${args.json}`, ...(args.force ? ['--force'] : [])];
    const r = runNodeScript(scriptDir, 'prd-review-write-stage.cjs', project, args, extra, 'prd_review');
    if (r.timedOut) done(3);
    done(r.status === 0 ? 0 : r.status || 1);
  }

  console.error('未知子命令:', sub);
  done(1);
}

main();
