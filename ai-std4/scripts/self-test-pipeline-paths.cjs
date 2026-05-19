'use strict';

/**
 *   node ai-std4/scripts/self-test-pipeline-paths.cjs
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPipelinePaths } = require('./libs/pipeline-paths.cjs');

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
assert(paths.codegenWorkersDir().includes('output-stages/codegen'), 'codegen workers under stage output');

paths.writeStagesJson({ pipeline: {}, stages: {} });
assert(fs.existsSync(paths.stagesJsonPath), 'writeStagesJson creates file');

if (failed > 0) process.exit(1);
console.log('\nAll tests passed.');
