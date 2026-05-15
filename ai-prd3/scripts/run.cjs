'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { parseArgs, requireProject, skillDirFrom, prdSpecPath } = require('./lib/paths.cjs');
const { parseClientTargets, tryLegacyYaml } = require('./prd-parse-client-targets.cjs');
const { spawnSyncWithTimeout, readStageTimeoutSec } = require('./lib/run-with-timeout.cjs');
const { markPrdFailed, markPrdTimeout, markPrdReviewTimeout } = require('./lib/stage-status.cjs');

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
  const sub = args._[0];
  const project = requireProject(args);
  const skillDir = skillDirFrom(__filename);
  const scriptDir = path.join(skillDir, 'scripts');

  if (!sub || sub === 'help' || sub === '-h') {
    console.log(`用法: node scripts/run.cjs <子命令> --project=<绝对路径> [选项]

子命令:
  bootstrap | parse-targets | validate-prd | write-prd |
  validate-prd-review | write-prd-review

选项:
  --force  覆盖已完成阶段（prd / prd-review）；bootstrap 在 prd 已完成时须加此选项
  --no-timeout  禁用 config 中的阶段超时（冒烟/调试可用；亦支持环境变量 AI_PRD3_NO_TIMEOUT=1）
  --lang=cn|en  bootstrap 选用 prd-spec 模板语言
  --json=<path>  write-prd-review 合并用 JSON（绝对路径或相对项目根）

超时（prd3.md §11）：默认读取 docs/config.dev.json → timeouts.stages.prd_s / prd_review_s（秒），
子进程超时将写 stages.*.outputs.timed_out 并以退出码 3 结束。
`);
    process.exit(sub ? 0 : 1);
  }

  if (sub === 'bootstrap') {
    const extra = [];
    if (args.lang === 'en') extra.push('--lang=en');
    else extra.push('--lang=cn');
    if (args.force) extra.push('--force');
    const r = runNodeScript(scriptDir, 'prd-bootstrap.cjs', project, args, extra, 'prd');
    if (r.timedOut) process.exit(3);
    process.exit(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'parse-targets') {
    const fs = require('fs');
    const spec = prdSpecPath(project);
    if (!fs.existsSync(spec)) {
      console.error('缺少', spec);
      process.exit(1);
    }
    const text = fs.readFileSync(spec, 'utf8');
    let p = parseClientTargets(text);
    if (!p.ok) {
      const leg = tryLegacyYaml(text);
      if (leg && leg.length) p = { ok: true, slugs: leg, legacy: true };
    }
    if (!p.ok) {
      console.error(JSON.stringify({ ok: false, error: p.error }, null, 2));
      process.exit(1);
    }
    console.log(JSON.stringify({ declared: p.slugs, legacy: !!p.legacy }, null, 2));
    process.exit(0);
  }

  if (sub === 'validate-prd') {
    const steps = ['prd-validate-spec.cjs', 'prd-validate-derived.cjs', 'prd-validate-config.cjs'];
    for (const s of steps) {
      const r = runNodeScript(scriptDir, s, project, args, [], 'prd');
      if (r.timedOut) process.exit(3);
      if (r.status !== 0) {
        console.error(r.stderr || r.stdout);
        markPrdFailed(project, `validate_failed:${s}`);
        process.exit(r.status || 1);
      }
    }
    process.exit(0);
  }

  if (sub === 'write-prd') {
    const extra = args.force ? ['--force'] : [];
    const r = runNodeScript(scriptDir, 'prd-write-stage.cjs', project, args, extra, 'prd');
    if (r.timedOut) process.exit(3);
    process.exit(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'validate-prd-review') {
    const r = runNodeScript(scriptDir, 'prd-review-validate.cjs', project, args, [], 'prd_review');
    if (r.timedOut) process.exit(3);
    process.exit(r.status === 0 ? 0 : r.status || 1);
  }

  if (sub === 'write-prd-review') {
    if (!args.json) {
      console.error('缺少 --json=');
      process.exit(1);
    }
    const extra = [`--json=${args.json}`, ...(args.force ? ['--force'] : [])];
    const r = runNodeScript(scriptDir, 'prd-review-write-stage.cjs', project, args, extra, 'prd_review');
    if (r.timedOut) process.exit(3);
    process.exit(r.status === 0 ? 0 : r.status || 1);
  }

  console.error('未知子命令:', sub);
  process.exit(1);
}

main();
