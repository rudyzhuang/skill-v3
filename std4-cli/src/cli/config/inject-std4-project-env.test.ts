import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  injectStd4ProjectEnv,
  STD4_PROJECT_ENV_INJECT_MODE,
} from './inject-std4-project-env.js';
import { finalizeMaterializedProjectStd4Env } from '../workflows/project-materialize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const worktreeRoot = path.resolve(__dirname, '../../..');
const pipelineConfigCjs = path.join(
  worktreeRoot,
  'ai-std4',
  'scripts',
  'libs',
  'pipeline-config.cjs'
);

function parseEnvKeys(content: string): string[] {
  const keys: string[] = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    keys.push(t.slice(0, eq).trim());
  }
  return keys.sort();
}

const requirePc = createRequire(import.meta.url);
const { loadProjectEnv } = requirePc(pipelineConfigCjs) as {
  loadProjectEnv: (root: string) => { loaded: boolean; path: string | null };
};

/** 含典型敏感键名与**假**明文，用于断言日志/异常绝不回显这些值 */
const sampleBundled = Buffer.from(
  [
    '# sample bundled — 测试占位，不含真实密钥',
    'PIPELINE_MODEL=test-model-placeholder',
    'CLOUD_PROVIDER=noop',
    'MY_PROBE_KEY=probe-value-placeholder',
    'CURSOR_API_KEY=fake-cursor-secret-xyz',
    'DASH_STD4_API_KEY=fake-dash-secret-uvw',
    '',
  ].join('\n'),
  'utf8'
);

const SECRET_SUBSTRINGS = ['fake-cursor-secret-xyz', 'fake-dash-secret-uvw'] as const;

function makeLayout(tmp: string): { cliRoot: string; project: string } {
  const cliRoot = path.join(tmp, 'cli');
  const bundledPath = path.join(cliRoot, 'bundled', 'std4-config.env');
  mkdirSync(path.dirname(bundledPath), { recursive: true });
  writeFileSync(bundledPath, sampleBundled);
  const project = path.join(tmp, 'project');
  mkdirSync(project, { recursive: true });
  return { cliRoot, project };
}

test('STD4_PROJECT_ENV_INJECT_MODE is documented always overwrite', () => {
  assert.equal(STD4_PROJECT_ENV_INJECT_MODE, 'always_overwrite_from_bundled');
});

test('inject writes docs/config.env bytes equal to bundled; idempotent on repeat', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    injectStd4ProjectEnv({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: false,
    });
    const docsPath = path.join(project, 'docs', 'config.env');
    assert.deepEqual(readFileSync(docsPath), sampleBundled);
    injectStd4ProjectEnv({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: false,
    });
    assert.deepEqual(readFileSync(docsPath), sampleBundled);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('finalizeMaterializedProjectStd4Env wires inject', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    finalizeMaterializedProjectStd4Env({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: false,
    });
    assert.deepEqual(
      readFileSync(path.join(project, 'docs', 'config.env')),
      sampleBundled
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('missing bundled std4-config.env fails before writing project files', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const cliRoot = path.join(tmp, 'cli');
    mkdirSync(cliRoot, { recursive: true });
    const project = path.join(tmp, 'project');
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    assert.throws(
      () =>
        injectStd4ProjectEnv({
          cliInstallRoot: cliRoot,
          projectRoot: project,
          syncInputsConfigEnv: false,
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/bundled std4 config missing or unreadable/.test(msg)) return false;
        for (const s of SECRET_SUBSTRINGS) {
          if (msg.includes(s)) return false;
        }
        return true;
      }
    );
    assert.equal(existsSync(path.join(project, 'docs')), true);
    assert.throws(
      () => readFileSync(path.join(project, 'docs', 'config.env')),
      /ENOENT/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('syncInputsConfigEnv writes both docs and inputs', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    injectStd4ProjectEnv({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: true,
    });
    assert.deepEqual(
      readFileSync(path.join(project, 'docs', 'config.env')),
      sampleBundled
    );
    assert.deepEqual(
      readFileSync(path.join(project, 'inputs', 'config.env')),
      sampleBundled
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('logger output never echoes bundled secret values', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    const captured: string[] = [];
    const logger = {
      info: (message: string, meta?: Record<string, unknown>) => {
        captured.push(JSON.stringify({ message, meta }));
      },
    };
    injectStd4ProjectEnv({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: false,
      logger,
    });
    const blob = captured.join('\n');
    for (const s of SECRET_SUBSTRINGS) {
      assert.equal(
        blob.includes(s),
        false,
        `logger must not include plaintext value fragment: ${s}`
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('read-only inputs directory fails with EACCES and does not create inputs file (posix)', {
  skip: os.platform() === 'win32',
}, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    mkdirSync(path.join(project, 'docs'), { recursive: true });
    const inputsDir = path.join(project, 'inputs');
    mkdirSync(inputsDir, { recursive: true });
    chmodSync(inputsDir, 0o555);
    assert.throws(
      () =>
        injectStd4ProjectEnv({
          cliInstallRoot: cliRoot,
          projectRoot: project,
          syncInputsConfigEnv: true,
        }),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        return (
          msg.includes('inject inputs/config.env') &&
          msg.includes('EACCES')
        );
      }
    );
    chmodSync(inputsDir, 0o755);
    assert.throws(
      () => readFileSync(path.join(inputsDir, 'config.env')),
      /ENOENT/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('read-only docs directory yields failure without destination file (posix)', {
  skip: os.platform() === 'win32',
}, () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  try {
    const { cliRoot, project } = makeLayout(tmp);
    const docsDir = path.join(project, 'docs');
    mkdirSync(docsDir, { recursive: true });
    chmodSync(docsDir, 0o555);
    assert.throws(
      () =>
        injectStd4ProjectEnv({
          cliInstallRoot: cliRoot,
          projectRoot: project,
          syncInputsConfigEnv: false,
        }),
      /inject docs\/config.env/
    );
    chmodSync(docsDir, 0o755);
    assert.throws(
      () => readFileSync(path.join(docsDir, 'config.env')),
      /ENOENT/
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('loadProjectEnv reads same key set as bundled after inject', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-inject-'));
  const keysInFile = parseEnvKeys(sampleBundled.toString('utf8'));
  const prev: Record<string, string | undefined> = {};
  for (const k of keysInFile) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const { cliRoot, project } = makeLayout(tmp);
    injectStd4ProjectEnv({
      cliInstallRoot: cliRoot,
      projectRoot: project,
      syncInputsConfigEnv: false,
    });
    const res = loadProjectEnv(project);
    assert.equal(res.loaded, true);
    for (const k of keysInFile) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(process.env, k) &&
          process.env[k] !== undefined &&
          process.env[k] !== '',
        `expected ${k} to be populated by loadProjectEnv`
      );
    }
  } finally {
    for (const k of keysInFile) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('copy-std4-config.mjs produces bundled file (bytes match)', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'std4-copy-'));
  try {
    const inputsDir = path.join(tmp, 'inputs');
    mkdirSync(inputsDir, { recursive: true });
    const srcEnv = path.join(inputsDir, 'config.env');
    writeFileSync(srcEnv, sampleBundled);
    const script = path.join(worktreeRoot, 'scripts', 'build', 'copy-std4-config.mjs');
    execFileSync(process.execPath, [script, tmp], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    const dest = path.join(tmp, 'bundled', 'std4-config.env');
    assert.deepEqual(readFileSync(dest), readFileSync(srcEnv));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
