'use strict';

/**
 * merge-push 真实 git 路径自测：成功合并、合并冲突退出码 6。
 * `node ai-code3/scripts/self-test-merge-push.cjs`
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const assert = require('assert');

const skillRoot = path.join(__dirname, '..');
const mergePushScript = path.join(skillRoot, 'scripts', 'merge-push.cjs');

function git(cwd, args, inherit = true) {
  const r = spawnSync('git', ['-C', cwd, ...args], { stdio: inherit ? 'inherit' : 'pipe', encoding: 'utf8' });
  return r.status ?? 1;
}

function commitAll(cwd, msg) {
  if (git(cwd, ['add', '-A']) !== 0) throw new Error('git add');
  if (git(cwd, ['-c', 'user.email=mp@test', '-c', 'user.name=mp', 'commit', '-m', msg]) !== 0) {
    throw new Error('git commit');
  }
}

function writeConfig(cwd) {
  fs.mkdirSync(path.join(cwd, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, 'docs', 'config.dev.json'),
    JSON.stringify(
      {
        _schema: { name: 'skill-v3-project-config', version: 1, environment: 'dev' },
        git: { remote: 'origin', default_branch: 'main', allow_push: false },
        timeouts: { stages: { merge_push_s: 120 } },
        security: { forbidden_json_key_patterns: [] },
      },
      null,
      2
    ),
    'utf8'
  );
}

function writeStages(cwd, worktrees) {
  fs.mkdirSync(path.join(cwd, '.pipeline'), { recursive: true });
  const doc = {
    _schema: { name: 'skill-v3-stages', version: 1 },
    stages: {
      code_review: {
        status: 'completed',
        validation: { passed: true },
        outputs: { decision: 'passed', critical_issues: 0 },
        inputs: { worktrees },
      },
      codegen: {
        outputs: { worktrees },
      },
      merge_push: {
        status: 'not_started',
        inputs: { target_branch: 'main', worktrees: [] },
        outputs: {},
        validation: { passed: false },
      },
    },
  };
  fs.writeFileSync(path.join(cwd, '.pipeline', 'stages.json'), JSON.stringify(doc, null, 2), 'utf8');
}

function runMergePush(cwd) {
  return spawnSync(process.execPath, [mergePushScript, 'merge-push', `--project=${cwd}`], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
}

function testHappyMerge() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-mp-ok-'));
  if (git(cwd, ['init']) !== 0) throw new Error('init');
  if (git(cwd, ['branch', '-M', 'main']) !== 0) throw new Error('branch');
  fs.writeFileSync(path.join(cwd, 'a.txt'), 'base\n', 'utf8');
  commitAll(cwd, 'base');
  if (git(cwd, ['checkout', '-b', 'feat']) !== 0) throw new Error('checkout feat');
  fs.writeFileSync(path.join(cwd, 'b.txt'), 'from-feat\n', 'utf8');
  commitAll(cwd, 'feat');
  if (git(cwd, ['checkout', 'main']) !== 0) throw new Error('checkout main');

  writeConfig(cwd);
  const wt = [{ feature_id: 'f1', branch: 'feat', worktree_path: cwd, commit: '', files_expected: [], files_changed: [], test_files_expected: [], test_files_changed: [] }];
  writeStages(cwd, wt);
  commitAll(cwd, 'pipeline files');

  const r = runMergePush(cwd);
  assert.strictEqual(r.status, 0, `happy merge exit 0, stderr=${r.stderr}`);
  assert.ok(fs.existsSync(path.join(cwd, 'b.txt')), 'merged file b.txt');
  const doc = JSON.parse(fs.readFileSync(path.join(cwd, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(doc.stages.merge_push.validation.passed, true);
  assert.strictEqual(doc.stages.merge_push.outputs.merge_status, 'completed');
}

function testMergeConflictExit6() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-mp-conf-'));
  if (git(cwd, ['init']) !== 0) throw new Error('init');
  if (git(cwd, ['branch', '-M', 'main']) !== 0) throw new Error('branch');
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'base-line\n', 'utf8');
  commitAll(cwd, 'base');
  if (git(cwd, ['checkout', '-b', 'feat']) !== 0) throw new Error('checkout feat');
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'feat-line\n', 'utf8');
  commitAll(cwd, 'feat commit');
  if (git(cwd, ['checkout', 'main']) !== 0) throw new Error('checkout main');
  fs.writeFileSync(path.join(cwd, 'x.txt'), 'main-line\n', 'utf8');
  commitAll(cwd, 'main diverge');

  writeConfig(cwd);
  const wt = [{ feature_id: 'f1', branch: 'feat', worktree_path: cwd, commit: '', files_expected: [], files_changed: [], test_files_expected: [], test_files_changed: [] }];
  writeStages(cwd, wt);
  commitAll(cwd, 'pipeline files');

  const r = runMergePush(cwd);
  assert.strictEqual(r.status, 6, `conflict exit 6, stderr=${r.stderr}`);
  const doc = JSON.parse(fs.readFileSync(path.join(cwd, '.pipeline', 'stages.json'), 'utf8'));
  assert.strictEqual(doc.stages.merge_push.outputs.merge_status, 'conflict');
  assert.strictEqual(fs.readFileSync(path.join(cwd, 'x.txt'), 'utf8').trim(), 'main-line');
}

testHappyMerge();
testMergeConflictExit6();
console.log('ai-code3 self-test-merge-push: ok');
