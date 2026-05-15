#!/usr/bin/env node
'use strict';

/** 等价于 `autorun.cjs preflight-only`（auto3.md §4.1） */
const { requireAbsoluteProject } = require('./lib/paths.cjs');
const { runAutorunChecklist } = require('./lib/checklist.cjs');
const { readStages } = require('./lib/stages-io.cjs');
const { upsertProjectFromStages } = require('./lib/registry-db.cjs');

function parse(argv) {
  let project = null;
  let features = null;
  for (const a of argv.slice(2)) {
    if (a.startsWith('--project=')) project = a.slice('--project='.length);
    if (a.startsWith('--features=')) features = a.slice('--features='.length);
  }
  return { project, features };
}

function main() {
  const { project, features } = parse(process.argv);
  let root;
  try {
    root = requireAbsoluteProject(project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const ck = runAutorunChecklist(root, { featuresFilter: features });
  if (!ck.ok) {
    console.error(ck.message);
    process.exit(1);
  }
  try {
    upsertProjectFromStages(root, readStages(root));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  console.error('preflight.cjs: OK');
  process.exit(0);
}

main();
