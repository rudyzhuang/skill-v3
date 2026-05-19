'use strict';

/**
 * skill-prompt-publish.cjs — 在 skill git 仓提交并推送 prompts/ 变更（ui_e2e fix_prompt 等）
 *
 * CLI:
 *   node ai-std3/scripts/libs/skill-prompt-publish.cjs \
 *     --skill-root=<含 ai-std3 的 git 根> \
 *     --message="fix(ui-e2e): ..." \
 *     [--paths=prompts/a.md,prompts/b.md]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { getSkillsRoot } = require('./pipeline-config.cjs');

const GIT_BLOCKLIST = ['config.env', '/.env', '.env.', 'credentials', '.pem', '.key'];

function resolveSkillGitRoot(skillsRoot) {
  let cur = path.resolve(skillsRoot);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(cur, '.git'))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return path.resolve(skillsRoot);
}

function isBlocked(p) {
  const norm = String(p).replace(/\\/g, '/');
  return GIT_BLOCKLIST.some((s) => norm.includes(s));
}

function runGit(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * @param {object} opts
 * @param {string} [opts.skillsRoot]
 * @param {string} opts.message
 * @param {string[]} [opts.files] 相对 ai-std3/ 的路径，如 prompts/codegen-impl.md
 * @param {object} [opts.log] logger with info/warn/error
 * @returns {{ ok: boolean, commit: string|null, pushed: boolean, files: string[], error?: string, push_skipped_reason?: string }}
 */
function publishSkillPrompts(opts) {
  const skillsRoot = opts.skillsRoot || getSkillsRoot();
  const message = String(opts.message || '').trim();
  const log = opts.log || null;

  if (!message) {
    return { ok: false, commit: null, pushed: false, files: [], error: 'commit message 为空' };
  }

  const repoRoot = resolveSkillGitRoot(skillsRoot);
  const aiStd3Dir = fs.existsSync(path.join(repoRoot, 'ai-std3'))
    ? path.join(repoRoot, 'ai-std3')
    : repoRoot;

  const relFiles = (opts.files || [])
    .map((f) => String(f).trim().replace(/^ai-std3\//, ''))
    .filter((f) => f && f.startsWith('prompts/') && !isBlocked(f));

  if (relFiles.length === 0) {
    const promptsDir = path.join(aiStd3Dir, 'prompts');
    if (!fs.existsSync(promptsDir)) {
      return { ok: false, commit: null, pushed: false, files: [], error: '无 prompts/ 目录或无变更文件' };
    }
    const r = runGit(repoRoot, ['add', '--', 'ai-std3/prompts/']);
    if (r.status !== 0 && !fs.existsSync(path.join(repoRoot, 'prompts'))) {
      runGit(aiStd3Dir, ['add', '--', 'prompts/']);
    }
  } else {
    for (const rel of relFiles) {
      const abs = path.join(aiStd3Dir, rel);
      if (!fs.existsSync(abs)) continue;
      if (fs.existsSync(path.join(repoRoot, 'ai-std3'))) {
        runGit(repoRoot, ['add', '--', path.join('ai-std3', rel).replace(/\\/g, '/')]);
      } else {
        runGit(aiStd3Dir, ['add', '--', rel]);
      }
    }
  }

  const statR = runGit(repoRoot, ['diff', '--cached', '--stat']);
  const stagedR = runGit(repoRoot, ['diff', '--cached', '--quiet']);
  if (stagedR.status === 0) {
    return {
      ok: false,
      commit: null,
      pushed: false,
      files: relFiles,
      error: 'nothing_staged',
      push_skipped_reason: 'no_prompt_changes',
    };
  }

  const commitR = runGit(repoRoot, ['commit', '-m', message]);
  if (commitR.status !== 0) {
    const err = (commitR.stderr || commitR.stdout || 'commit failed').trim();
    if (log) log.error('prompt_publish_failed', err, { files: relFiles });
    return { ok: false, commit: null, pushed: false, files: relFiles, error: err };
  }

  const headR = runGit(repoRoot, ['rev-parse', '--short', 'HEAD']);
  const commit = headR.status === 0 ? headR.stdout.trim() : null;

  const pushR = runGit(repoRoot, ['push']);
  const pushed = pushR.status === 0;
  const push_skipped_reason = pushed
    ? null
    : (pushR.stderr || pushR.stdout || 'push failed').trim().slice(0, 200);

  if (log) {
    if (pushed) {
      log.info('prompt_published', `skill prompts 已 push commit=${commit}`, {
        skill_commit: commit,
        files: relFiles.length ? relFiles : ['prompts/'],
        pushed: true,
        diff_stat: (statR.stdout || '').trim().slice(0, 500),
      });
    } else {
      log.error('prompt_publish_failed', `commit 成功但 push 失败: ${push_skipped_reason}`, {
        skill_commit: commit,
        files: relFiles,
        pushed: false,
      });
    }
  }

  return {
    ok: pushed,
    committed: !!commit,
    commit,
    pushed,
    files: relFiles,
    error: pushed ? undefined : push_skipped_reason || 'push_failed',
    push_skipped_reason: push_skipped_reason || undefined,
  };
}

function parseCli() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith('--'))
      .map((a) => {
        const [k, ...v] = a.slice(2).split('=');
        return [k, v.join('=') || true];
      })
  );
  const skillsRoot = args['skill-root'] ? path.resolve(String(args['skill-root'])) : getSkillsRoot();
  const message = args.message ? String(args.message) : '';
  const paths = args.paths ? String(args.paths).split(',').map((s) => s.trim()).filter(Boolean) : [];
  return { skillsRoot, message, paths };
}

if (require.main === module) {
  const { skillsRoot, message, paths } = parseCli();
  const result = publishSkillPrompts({ skillsRoot, message, files: paths });
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

module.exports = { publishSkillPrompts, resolveSkillGitRoot };
