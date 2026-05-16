#!/usr/bin/env node
'use strict';

/**
 * ai-dash3 — 只读看板。见 docs/spec/dash3.md
 */

const fs = require('fs');
const path = require('path');
const {
  requireAbsoluteProject,
  readStages,
  buildJsonSummary,
  formatStatus,
  toMarkdown,
} = require('./lib/summary.cjs');

function parseArgs(argv) {
  const rest = argv.slice(2);
  const out = { subcommand: 'status', project: null, out: null, open: false };
  const known = new Set(['status', 'json', 'write-md', 'serve']);
  if (rest.length && known.has(rest[0])) {
    out.subcommand = rest.shift();
  }
  for (const a of rest) {
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--out=')) out.out = a.slice('--out='.length);
    else if (a.startsWith('--port=')) out.port = a.slice('--port='.length);
    else if (a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a === '--open') out.open = true;
  }
  return out;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  if (args.subcommand === 'serve') {
    const serveArgv = ['node', path.join(__dirname, 'serve.cjs')];
    if (args.port) serveArgv.push(`--port=${args.port}`);
    if (args.host) serveArgv.push(`--host=${args.host}`);
    if (args.project) serveArgv.push(`--project=${args.project}`);
    if (args.open) serveArgv.push('--open');
    const { main: serveMain } = require('./serve.cjs');
    return serveMain(serveArgv);
  }

  let projectRoot;
  try {
    projectRoot = requireAbsoluteProject(args.project);
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }

  const read = readStages(projectRoot);
  if (!read.ok) {
    console.error(`stages.json 非法 JSON (${read.path}): ${read.error}`);
    process.exit(1);
  }

  if (args.subcommand === 'json') {
    const summary = buildJsonSummary(projectRoot, read);
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    process.exit(0);
  }

  if (args.subcommand === 'write-md') {
    let rel = args.out || '.pipeline/reports/dash-status.md';
    const outAbs = path.isAbsolute(rel) ? rel : path.join(projectRoot, rel);
    try {
      fs.mkdirSync(path.dirname(outAbs), { recursive: true });
      fs.writeFileSync(outAbs, toMarkdown(projectRoot, read), 'utf8');
      process.stdout.write(`wrote ${outAbs}\n`);
    } catch (e) {
      console.error(`write-md failed: ${e.message || e}`);
      process.exit(1);
    }
    process.exit(0);
  }

  process.stdout.write(`${formatStatus(projectRoot, read)}\n`);
  process.exit(0);
}

main();
