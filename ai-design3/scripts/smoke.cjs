#!/usr/bin/env node
/**
 * ai-design3 smoke：临时业务仓 + 串联子命令，退出码非 0 则失败。
 * 用法：node scripts/smoke.cjs（在 ai-design3 目录执行，或传绝对路径作第一参数为 skill 根）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const skillRoot = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const runCjs = path.join(skillRoot, 'scripts', 'run.cjs');
const repoRoot = path.resolve(skillRoot, '..');

function run(projectRoot, args) {
  const r = spawnSync(process.execPath, [runCjs, ...args, `--project=${projectRoot}`], {
    encoding: 'utf8',
    cwd: skillRoot,
    env: {
      ...process.env,
      AI_DESIGN_LIB_RESEARCH_USE_STUB: '1',
    },
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.status;
}

function write(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-design3-smoke-'));
  const stagesPath = path.join(tmp, '.pipeline', 'stages.json');
  let stages;
  try {
    stages = JSON.parse(fs.readFileSync(path.join(repoRoot, 'docs', 'templates', 'stages.json.template'), 'utf8'));
  } catch (e) {
    console.error('smoke: need repo docs/templates/stages.json.template next to ai-design3/', e.message);
    process.exit(1);
  }
  stages.stages.prd_review.status = 'completed';
  stages.stages.prd_review.outputs.decision = 'passed';
  stages.stages.prd_review.review.phase_plan = [{ phase: 'mvp', feature_ids: ['smoke_feat_01'], goal: '', exit_criteria: [] }];
  stages.stages.design.outputs = stages.stages.design.outputs || {};
  stages.stages.design.outputs.needs_human_review = false;
  write(stagesPath, JSON.stringify(stages, null, 2));

  const fid = 'smoke_feat_01';
  write(path.join(tmp, 'docs', 'prd-spec.md'), '# Smoke PRD\n');
  const cfgMin = {
    _schema: { name: 'skill-v3-project-config', version: 1, environment: 'dev' },
    project: { name: 'smoke' },
    git: { remote: 'origin', default_branch: 'main', working_branch_prefix: 'ai', allow_push: false },
    pipeline: { autorun: { allow_destructive_deploy: false } },
    build: { package_manager: 'auto', commands: {}, artifacts_dir: 'dist', client_targets: {} },
    timeouts: {
      stages: {
        prd_s: 600,
        prd_review_s: 600,
        design_s: 600,
        contract_s: 600,
        design_review_s: 600,
      },
    },
    deploy: { enabled: false },
    security: { forbidden_json_key_patterns: ['secret', 'password', 'api_key', 'private_key'] },
  };
  write(path.join(tmp, 'docs', 'config.dev.json'), JSON.stringify(cfgMin, null, 2));
  write(path.join(tmp, 'docs', 'config.release.json'), JSON.stringify({ ...cfgMin, _schema: { ...cfgMin._schema, environment: 'release' } }, null, 2));

  write(
    path.join(tmp, 'docs', 'website', 'feature_list.md'),
    `# Feature List\n## Features\n| Feature ID | Area | Name | Status |\n| --- | --- | --- | --- |\n| ${fid} | core | Smoke | draft |\n`
  );

  const designDoc = {
    feature_id: fid,
    client_target: 'website',
    status: 'ready_for_contract',
    risks: [],
    shared_changes: [],
    api_outline: [{ handler: 'smokeHandler', method: 'GET', path: '/ping' }],
    file_plan: { new_files: ['src/website/components/SmokeWidget.tsx'] },
  };
  write(path.join(tmp, 'docs', 'designs', `${fid}.design.json`), JSON.stringify(designDoc, null, 2));

  write(
    path.join(tmp, 'src', 'website', 'SmokeWidget.tsx'),
    `import React from 'react';\nexport function SmokeWidget() { return null; }\n`
  );

  const snap = {
    feature_id: fid,
    client_target: 'website',
    snapshot_version: 1,
    api_outline: [{ method: 'GET', path: '/ping' }],
    file_plan: { new_files: ['src/website/components/SmokeWidget.tsx'] },
  };
  write(path.join(tmp, 'docs', 'contracts', fid, `${fid}.design.snapshot.json`), JSON.stringify(snap, null, 2));
  write(path.join(tmp, 'docs', 'contracts', fid, `${fid}.types.ts`), 'export const smokeMarker = 1;\n');
  write(
    path.join(tmp, 'docs', 'contracts', fid, `${fid}.api.yaml`),
    `openapi: 3.0.3
info:
  title: Smoke API
  version: "1.0.0"
paths:
  /ping:
    x-smoke:
      method: GET
      expected_status: 200
    get:
      summary: ping
      responses:
        "200":
          description: ok
`
  );
  write(path.join(tmp, 'docs', 'contracts', fid, `${fid}.schema.sql`), '-- smoke schema\nCREATE TABLE IF NOT EXISTS smoke_t (id INT);\n');
  write(path.join(tmp, 'docs', 'contracts', fid, `${fid}.test-spec.md`), '# Test spec\n\n## Cases\n- ping returns 200.\n');

  const steps = [
    ['preflight'],
    ['list-design-candidates'],
    ['scan-design-style'],
    ['lib-research'],
    ['validate-design'],
    ['write-design'],
    ['hash-design-inputs'],
    ['validate-design'],
    ['register-contract-artifacts'],
    ['validate-contract'],
    ['approve-contract'],
    ['hash-contract-inputs'],
    ['validate-contract'],
    ['validate-design-review'],
    ['write-design-review'],
    ['hash-design-review-inputs'],
  ];

  for (const args of steps) {
    const code = run(tmp, args);
    if (code !== 0) {
      console.error(`smoke FAILED at: ${args.join(' ')} exit=${code}`);
      process.exit(code || 1);
    }
  }

  const dry = run(tmp, ['validate-design', '--dry-run']);
  if (dry !== 0) {
    console.error('smoke: dry-run validate-design failed');
    process.exit(dry || 1);
  }

  console.error('smoke OK', tmp);
  process.exit(0);
}

main();
