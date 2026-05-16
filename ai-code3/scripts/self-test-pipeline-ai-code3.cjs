#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { applyHealthFullScaffold } = require('./lib/codegen-health-full-scaffold.cjs');
const {
  pipelineAiCode3Dir,
  hasToolingPackageJson,
  resolveDefaultTestCommand,
  defaultNpmBuildCommand,
} = require('./lib/pipeline-ai-code3.cjs');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-code3-pipeline-'));
const worktree = path.join(projectRoot, '.pipeline', 'worktrees', 'v3-fc-DEMO');
fs.mkdirSync(worktree, { recursive: true });

const touched = applyHealthFullScaffold(worktree, {
  projectRoot,
  clientTargets: ['backend', 'website'],
});
assert(touched > 0, 'scaffold should touch files');

const toolingPkg = path.join(pipelineAiCode3Dir(projectRoot), 'package.json');
const buildScript = path.join(pipelineAiCode3Dir(projectRoot), 'scripts', 'build.cjs');
assert(fs.existsSync(toolingPkg), 'tooling package.json missing');
assert(fs.existsSync(buildScript), 'tooling build.cjs missing');
assert(!fs.existsSync(path.join(projectRoot, 'package.json')), 'must not write project root package.json');
assert(!fs.existsSync(path.join(worktree, 'package.json')), 'must not write worktree root package.json');
assert(fs.existsSync(path.join(worktree, 'src', 'backend', 'server.cjs')), 'feature src missing');

assert(hasToolingPackageJson(projectRoot), 'hasToolingPackageJson');
const testCmd = resolveDefaultTestCommand(projectRoot, [{ worktree_path: worktree, feature_id: 'DEMO' }]);
assert(testCmd.includes('health.test.cjs'), `expected health test cmd, got ${testCmd}`);
const buildCmd = defaultNpmBuildCommand(projectRoot);
assert(buildCmd.includes('.pipeline/ai-code3'), `build cmd should use prefix: ${buildCmd}`);

console.log('ai-code3 self-test-pipeline-ai-code3: ok');
