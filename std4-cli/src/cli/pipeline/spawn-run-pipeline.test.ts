import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { spawnRunPipeline } from './spawn-run-pipeline.ts';

test('spawnRunPipeline argv 与 cwd 正确（含空格路径）', async () => {
  const tmpInstall = fs.mkdtempSync(path.join(os.tmpdir(), 'std4 spawn')); // 空格
  const project = path.join(tmpInstall, 'my project');
  try {
    fs.mkdirSync(project, { recursive: true });
    const script = path.join(tmpInstall, 'vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      `
'use strict';
const fs = require('fs');
const out = {
  argv: process.argv,
  cwd: process.cwd(),
  skills: process.env.CURSOR_SKILLS_ROOT,
};
fs.writeFileSync(process.env.STD4_SPAWN_PROBE_OUT, JSON.stringify(out), 'utf8');
process.exit(0);
`,
      'utf8',
    );

    const probeOut = path.join(tmpInstall, 'probe-out.json');
    const code = await spawnRunPipeline({
      skillsRoot: path.join(tmpInstall, 'vendor'),
      projectRoot: project,
      pipelineArgs: ['--probe-arg=1'],
      env: { ...process.env, STD4_SPAWN_PROBE_OUT: probeOut },
    });
    assert.equal(code, 0);
    const parsed = JSON.parse(fs.readFileSync(probeOut, 'utf8')) as {
      argv: string[];
      cwd: string;
      skills: string;
    };
    assert.equal(fs.realpathSync(parsed.cwd), fs.realpathSync(project));
    assert.equal(fs.realpathSync(parsed.skills), fs.realpathSync(path.join(tmpInstall, 'vendor')));
    assert.ok(parsed.argv.some((a) => a.includes('run-pipeline.cjs')));
    assert.ok(parsed.argv.some((a) => a === '--probe-arg=1'));
  } finally {
    fs.rmSync(tmpInstall, { recursive: true, force: true });
  }
});

test('spawnRunPipeline 不向子进程透传禁用环境变量（含父进程或 opts.env 注入）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-strip-'));
  try {
    const script = path.join(tmp, 'vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(
      script,
      `'use strict';\n` +
        `const bad = !!(process.env.DASH_STD4_API_KEY || process.env.OPENAI_API_KEY);\n` +
        `process.exit(bad ? 9 : 0);\n`,
      'utf8',
    );

    const prevDash = process.env.DASH_STD4_API_KEY;
    const prevOpen = process.env.OPENAI_API_KEY;
    process.env.DASH_STD4_API_KEY = 'parent-leak-check';
    process.env.OPENAI_API_KEY = 'parent-leak-check-2';

    try {
      const code = await spawnRunPipeline({
        skillsRoot: path.join(tmp, 'vendor'),
        projectRoot: tmp,
        pipelineArgs: [],
        env: { DASH_STD4_API_KEY: 'opts-leak-check', NPM_CONFIG_FAKE: 'ok' },
      });
      assert.equal(code, 0);
    } finally {
      if (prevDash === undefined) delete process.env.DASH_STD4_API_KEY;
      else process.env.DASH_STD4_API_KEY = prevDash;
      if (prevOpen === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevOpen;
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('spawnRunPipeline 子进程非零退出向上透出', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-exit-'));
  try {
    const script = path.join(tmp, 'vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs');
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, `'use strict'; process.exit(7);\n`, 'utf8');

    const code = await spawnRunPipeline({
      skillsRoot: path.join(tmp, 'vendor'),
      projectRoot: tmp,
      pipelineArgs: [],
    });
    assert.equal(code, 7);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
