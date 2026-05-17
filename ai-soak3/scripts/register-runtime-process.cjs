#!/usr/bin/env node
'use strict';

/**
 * 登记后台进程到 <skills_root>/_projects/<config.dev.json project.name>/runtime.json
 * 用法: node register-runtime-process.cjs --project=<abs> --kind=... --pid=... [--command=] [--log-path=]
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    project: null,
    kind: 'unknown',
    pid: null,
    command: '',
    logPath: '',
    cwd: '',
    markExited: false,
    exitCode: 0,
  };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--project=')) out.project = a.slice('--project='.length);
    else if (a.startsWith('--kind=')) out.kind = a.slice('--kind='.length);
    else if (a.startsWith('--pid=')) out.pid = parseInt(a.slice('--pid='.length), 10);
    else if (a.startsWith('--command=')) out.command = a.slice('--command='.length);
    else if (a.startsWith('--log-path=')) out.logPath = a.slice('--log-path='.length);
    else if (a.startsWith('--cwd=')) out.cwd = a.slice('--cwd='.length);
    else if (a === '--mark-exited') out.markExited = true;
    else if (a.startsWith('--exit-code=')) out.exitCode = parseInt(a.slice('--exit-code='.length), 10);
  }
  return out;
}

function stagesPath(projectRoot) {
  return path.join(projectRoot, '.pipeline', 'stages.json');
}

function main() {
  const opts = parseArgs(process.argv);
  if (!opts.project) {
    console.error('missing --project=');
    process.exit(1);
  }
  const abs = path.resolve(opts.project);
  if (!fs.existsSync(stagesPath(abs))) {
    console.error(`no stages.json: ${stagesPath(abs)}`);
    process.exit(1);
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(stagesPath(abs), 'utf8'));
  } catch (e) {
    console.error(String(e.message || e));
    process.exit(1);
  }
  const projectId = doc?.project?.project_id;
  if (!projectId) {
    console.error('stages.json missing project.project_id');
    process.exit(1);
  }

  const runtimeIo = require('../../ai-auto3/scripts/lib/runtime-io.cjs');
  runtimeIo.ensureProjectFromStages(abs, doc, 'ai-soak3');
  if (opts.kind === 'soak-orchestrator') {
    runtimeIo.updateProjectRuntimeState(
      projectId,
      { orchestrator: 'ai-soak3', active: true },
      'ai-soak3',
      abs,
      doc
    );
  }
  if (opts.markExited && opts.pid) {
    runtimeIo.markProcessExited(projectId, opts.pid, Number.isFinite(opts.exitCode) ? opts.exitCode : 1);
    process.stdout.write(`runtime: marked exited pid=${opts.pid} project_id=${projectId}\n`);
    return;
  }
  if (opts.pid) {
    runtimeIo.registerProcess(
      projectId,
      {
        kind: opts.kind,
        pid: opts.pid,
        command: opts.command,
        log_path: opts.logPath,
        cwd: opts.cwd || abs,
        updated_by: 'ai-soak3',
      },
      abs,
      doc
    );
  }
  process.stdout.write(`runtime: registered kind=${opts.kind} pid=${opts.pid || '—'} project_id=${projectId}\n`);
}

main();
