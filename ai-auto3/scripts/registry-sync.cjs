#!/usr/bin/env node
'use strict';

/** 等价于 `autorun.cjs sync-registry`（auto3.md §4.1） */
const { requireAbsoluteProject } = require('./lib/paths.cjs');
const { readStages } = require('./lib/stages-io.cjs');
const { upsertProjectFromStages } = require('./lib/registry-db.cjs');

function main() {
  let project = null;
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--project=')) project = a.slice('--project='.length);
  }
  let root;
  try {
    root = requireAbsoluteProject(project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  try {
    upsertProjectFromStages(root, readStages(root));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  console.error('registry-sync.cjs: OK');
  process.exit(0);
}

main();
