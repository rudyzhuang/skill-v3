#!/usr/bin/env node
'use strict';

/**
 * 停止指定业务项目上的流水线后台进程（autorun / ai-code3 / cursor-agent 等）
 * 用法: node stop-pipeline.cjs --project=<absolute path>
 */

const { requireAbsoluteProject } = require('./lib/paths.cjs');
const { stopProjectPipeline } = require('./lib/stop-pipeline-lib.cjs');

function parseArgs(argv) {
  let project = null;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--project=')) project = a.slice('--project='.length);
  }
  return { project };
}

function main() {
  const opts = parseArgs(process.argv);
  let projectRoot;
  try {
    projectRoot = requireAbsoluteProject(opts.project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  try {
    const result = stopProjectPipeline(projectRoot);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.ok ? 0 : 2);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main };
