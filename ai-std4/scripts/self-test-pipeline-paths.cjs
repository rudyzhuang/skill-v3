'use strict';

/**
 *   node ai-std4/scripts/self-test-pipeline-paths.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipelinePaths } = require('./libs/pipeline-paths.cjs');
const { createArtifactPaths } = require('./libs/artifact-paths.cjs');

let failed = 0;
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  } else {
    console.log(`OK: ${msg}`);
  }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-paths-'));
const paths = createPipelinePaths(root);

assert(paths.stagesJsonPath.endsWith('output-stages/stages.json'), 'stages.json under output-stages');
assert(paths.stageOutputDir('deploy').includes('output-stages/deploy'), 'deploy output dir');
assert(paths.stageOutputDir('merge_push') === paths.pipelineDir, 'merge_push stays in .pipeline');
assert(paths.logsRoot.endsWith('.pipeline/logs'), 'logs under .pipeline');
assert(paths.codegenWorkersDir().endsWith('output-stages/codegen'), 'codegen workers at stage output root');
assert(paths.worktreesDir.endsWith('output-stages/codegen/worktrees'), 'codegen worktrees under stage output');
assert(paths.worktreeDir('AUTH-001').endsWith('output-stages/codegen/worktrees/v3-AUTH-001'), 'worktree path');

paths.writeStagesJson({ pipeline: {}, stages: {} });
assert(fs.existsSync(paths.stagesJsonPath), 'writeStagesJson creates file');

const artifacts = createArtifactPaths(paths);
assert(artifacts.prdSpecPath().includes('output-stages/prd/prd-spec.md'), 'prd-spec under output-stages/prd');
assert(artifacts.designPath('X').includes('output-stages/design/X.design.json'), 'design under output-stages/design');
assert(artifacts.uiScenarioPath('X').includes('output-stages/create-ui-scenarios/X.scenarios.yaml'), 'ui scenario path');
assert(artifacts.prdSpecRel() === 'output-stages/prd/prd-spec.md', 'prd-spec rel path');

if (failed > 0) process.exit(1);
console.log('\nAll tests passed.');
