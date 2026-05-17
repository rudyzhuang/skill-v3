'use strict';

/**
 * test-level gate 自测：
 * 1) warn 模式：缺少 required level 不阻断，退出 0；
 * 2) enforce 模式：缺少 required level 阻断，退出 4。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

const skillRoot = path.join(__dirname, '..');
const runScript = path.join(skillRoot, 'scripts', 'run.cjs');

function writeJson(absPath, obj) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeText(absPath, text) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, text, 'utf8');
}

function buildProject(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-code3-tl-${mode}-`));
  const testSpecRel = path.join('contracts', 'feature.test-spec.json');
  writeJson(path.join(root, testSpecRel), {
    required_test_levels: ['unit', 'integration'],
  });
  writeJson(path.join(root, 'docs', 'config.dev.json'), {
    _schema: { name: 'skill-v3-project-config', version: 1, environment: 'dev' },
    git: { remote: 'origin', default_branch: 'main', allow_push: false },
    build: {
      commands: {
        test: 'npm test --if-present',
        test_max_fix_attempts: 1,
      },
      test_level_gate: {
        mode,
        fallback_required_test_levels: [],
      },
    },
    timeouts: { stages: { test_s: 60 } },
    security: { forbidden_json_key_patterns: [] },
  });
  writeJson(path.join(root, '.pipeline', 'stages.json'), {
    _schema: { name: 'skill-v3-stages', version: 1 },
    stages: {
      contract: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          artifacts: [
            {
              feature_id: 'f1',
              types: 'contracts/feature.types.ts',
              api: 'contracts/feature.api.yaml',
              schema: 'contracts/feature.schema.sql',
              test_spec: testSpecRel,
              design_snapshot: 'contracts/feature.design.snapshot.json',
            },
          ],
        },
      },
      codegen: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          worktrees: [
            {
              feature_id: 'f1',
              worktree_path: root,
              branch: '',
            },
          ],
        },
      },
      typecheck: {
        status: 'completed',
        validation: { passed: true },
        inputs: {},
        outputs: {},
      },
      test: {
        status: 'not_started',
        validation: { passed: false },
        outputs: {},
      },
    },
  });

  writeText(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'tl-gate-fixture',
        private: true,
        scripts: { test: 'node tests/unit/ping.unit.test.cjs' },
      },
      null,
      2
    ) + '\n'
  );
  writeText(
    path.join(root, 'tests', 'unit', 'ping.unit.test.cjs'),
    `'use strict';\nprocess.exit(0);\n`
  );

  // 占位契约文件，满足路径存在性预期
  writeText(path.join(root, 'contracts', 'feature.types.ts'), 'export type X = string;\n');
  writeText(path.join(root, 'contracts', 'feature.api.yaml'), 'openapi: 3.0.0\n');
  writeText(path.join(root, 'contracts', 'feature.schema.sql'), '-- schema\n');
  writeJson(path.join(root, 'contracts', 'feature.design.snapshot.json'), { file_plan: {} });

  return root;
}

function buildProjectWithFallback(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ai-code3-tl-fallback-${mode}-`));
  writeJson(path.join(root, 'docs', 'config.dev.json'), {
    _schema: { name: 'skill-v3-project-config', version: 1, environment: 'dev' },
    git: { remote: 'origin', default_branch: 'main', allow_push: false },
    build: {
      commands: {
        test: 'npm test --if-present',
        test_max_fix_attempts: 1,
      },
      test_level_gate: {
        mode,
        fallback_required_test_levels: ['integration'],
      },
    },
    timeouts: { stages: { test_s: 60 } },
    security: { forbidden_json_key_patterns: [] },
  });
  writeJson(path.join(root, '.pipeline', 'stages.json'), {
    _schema: { name: 'skill-v3-stages', version: 1 },
    stages: {
      contract: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          artifacts: [
            {
              feature_id: 'f1',
              types: 'contracts/feature.types.ts',
              api: 'contracts/feature.api.yaml',
              schema: 'contracts/feature.schema.sql',
              test_spec: 'contracts/feature.test-spec.json',
              design_snapshot: 'contracts/feature.design.snapshot.json',
            },
          ],
        },
      },
      codegen: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          worktrees: [
            {
              feature_id: 'f1',
              worktree_path: root,
              branch: '',
            },
          ],
        },
      },
      typecheck: {
        status: 'completed',
        validation: { passed: true },
        inputs: {},
        outputs: {},
      },
      test: {
        status: 'not_started',
        validation: { passed: false },
        outputs: {},
      },
    },
  });
  writeText(
    path.join(root, 'contracts', 'feature.test-spec.json'),
    JSON.stringify({ note: 'no required levels in spec' }, null, 2) + '\n'
  );
  writeText(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'tl-gate-fallback-fixture',
        private: true,
        scripts: { test: 'node tests/unit/ping.unit.test.cjs' },
      },
      null,
      2
    ) + '\n'
  );
  writeText(path.join(root, 'tests', 'unit', 'ping.unit.test.cjs'), `'use strict';\nprocess.exit(0);\n`);
  writeText(path.join(root, 'contracts', 'feature.types.ts'), 'export type X = string;\n');
  writeText(path.join(root, 'contracts', 'feature.api.yaml'), 'openapi: 3.0.0\n');
  writeText(path.join(root, 'contracts', 'feature.schema.sql'), '-- schema\n');
  writeJson(path.join(root, 'contracts', 'feature.design.snapshot.json'), { file_plan: {} });
  return root;
}

function buildProjectIntegrationTreeOnly() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-tl-int-tree-'));
  const testSpecRel = path.join('contracts', 'feature.test-spec.json');
  writeJson(path.join(root, testSpecRel), {
    required_test_levels: ['integration'],
  });
  writeJson(path.join(root, 'docs', 'config.dev.json'), {
    _schema: { name: 'skill-v3-project-config', version: 1, environment: 'dev' },
    git: { remote: 'origin', default_branch: 'main', allow_push: false },
    build: {
      commands: {
        test: 'npm test --if-present',
        test_max_fix_attempts: 1,
      },
      test_level_gate: {
        mode: 'enforce',
        fallback_required_test_levels: [],
      },
    },
    timeouts: { stages: { test_s: 60 } },
    security: { forbidden_json_key_patterns: [] },
  });
  writeJson(path.join(root, '.pipeline', 'stages.json'), {
    _schema: { name: 'skill-v3-stages', version: 1 },
    stages: {
      contract: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          artifacts: [
            {
              feature_id: 'f1',
              types: 'contracts/feature.types.ts',
              api: 'contracts/feature.api.yaml',
              schema: 'contracts/feature.schema.sql',
              test_spec: testSpecRel,
              design_snapshot: 'contracts/feature.design.snapshot.json',
            },
          ],
        },
      },
      codegen: {
        status: 'completed',
        validation: { passed: true },
        outputs: {
          worktrees: [
            {
              feature_id: 'f1',
              worktree_path: root,
              branch: '',
            },
          ],
        },
      },
      typecheck: {
        status: 'completed',
        validation: { passed: true },
        inputs: {},
        outputs: {},
      },
      test: {
        status: 'not_started',
        validation: { passed: false },
        outputs: {},
      },
    },
  });
  writeText(
    path.join(root, 'package.json'),
    JSON.stringify(
      {
        name: 'tl-gate-int-tree-fixture',
        private: true,
        scripts: { test: 'node tests/integration/ping.cjs' },
      },
      null,
      2
    ) + '\n'
  );
  writeText(path.join(root, 'tests', 'integration', 'ping.cjs'), `'use strict';\nprocess.exit(0);\n`);
  writeText(path.join(root, 'contracts', 'feature.types.ts'), 'export type X = string;\n');
  writeText(path.join(root, 'contracts', 'feature.api.yaml'), 'openapi: 3.0.0\n');
  writeText(path.join(root, 'contracts', 'feature.schema.sql'), '-- schema\n');
  writeJson(path.join(root, 'contracts', 'feature.design.snapshot.json'), { file_plan: {} });
  return root;
}

function runTestStage(projectRoot) {
  return spawnSync(process.execPath, [runScript, 'test', `--project=${projectRoot}`], {
    cwd: skillRoot,
    encoding: 'utf8',
  });
}

function readStages(projectRoot) {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, '.pipeline', 'stages.json'), 'utf8'));
}

function assertWarnModePasses() {
  const root = buildProject('warn');
  const r = runTestStage(root);
  assert.strictEqual(r.status, 0, `warn mode should pass, stderr=${r.stderr || ''}`);
  const doc = readStages(root);
  assert.strictEqual(doc.stages.test.validation.passed, true, 'warn mode validation.passed should be true');
  const row = (doc.stages.test.features || doc.stages.test.outputs?.per_feature || [])[0] || {};
  assert.ok(row.test_level_gate, 'warn mode should record test_level_gate detail');
  assert.deepStrictEqual(row.test_level_gate.required_levels, ['unit', 'integration']);
  assert.ok(
    Array.isArray(row.test_level_gate.missing_levels) && row.test_level_gate.missing_levels.includes('integration'),
    'warn mode should report missing integration level'
  );
}

function assertEnforceModeFails() {
  const root = buildProject('enforce');
  const r = runTestStage(root);
  assert.strictEqual(r.status, 4, `enforce mode should fail with exit 4, stderr=${r.stderr || ''}`);
  const doc = readStages(root);
  assert.strictEqual(doc.stages.test.validation.passed, false, 'enforce mode validation.passed should be false');
  const row = (doc.stages.test.features || doc.stages.test.outputs?.per_feature || [])[0] || {};
  assert.ok(row.test_level_gate, 'enforce mode should record test_level_gate detail');
  assert.ok(
    Array.isArray(row.test_level_gate.missing_levels) && row.test_level_gate.missing_levels.includes('integration'),
    'enforce mode should report missing integration level'
  );
  assert.strictEqual(
    row.test_result || row.result,
    'failed',
    'enforce mode test_result should be failed, not failed_max_attempts'
  );
}

function assertOffModePassesWithoutGateFailure() {
  const root = buildProject('off');
  const r = runTestStage(root);
  assert.strictEqual(r.status, 0, `off mode should pass, stderr=${r.stderr || ''}`);
  const doc = readStages(root);
  assert.strictEqual(doc.stages.test.validation.passed, true);
}

function assertFallbackRequiredLevelsEnforced() {
  const root = buildProjectWithFallback('enforce');
  const r = runTestStage(root);
  assert.strictEqual(r.status, 4, `fallback enforce should fail, stderr=${r.stderr || ''}`);
  const doc = readStages(root);
  const row = (doc.stages.test.features || doc.stages.test.outputs?.per_feature || [])[0] || {};
  assert.ok(row.test_level_gate, 'fallback branch should record test_level_gate detail');
  assert.strictEqual(row.test_level_gate.source, 'config.fallback_required_test_levels');
  assert.ok(
    Array.isArray(row.test_level_gate.missing_levels) && row.test_level_gate.missing_levels.includes('integration'),
    'fallback branch should report missing integration level'
  );
}

function assertIntegrationTreeWithoutDotTestIsRecognized() {
  const root = buildProjectIntegrationTreeOnly();
  const r = runTestStage(root);
  assert.strictEqual(r.status, 0, `integration tree fixture should pass, stderr=${r.stderr || ''}`);
  const doc = readStages(root);
  const row = (doc.stages.test.features || doc.stages.test.outputs?.per_feature || [])[0] || {};
  assert.ok(row.test_level_gate, 'integration tree case should include test_level_gate info');
  assert.deepStrictEqual(row.test_level_gate.missing_levels, [], 'integration tree file should be recognized');
}

assertWarnModePasses();
assertEnforceModeFails();
assertOffModePassesWithoutGateFailure();
assertFallbackRequiredLevelsEnforced();
assertIntegrationTreeWithoutDotTestIsRecognized();
console.log('ai-code3 self-test-test-level-gate: ok');
