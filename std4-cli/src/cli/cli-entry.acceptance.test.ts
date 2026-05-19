import { describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const entry = join(root, 'dist/cli/cli-entry.js');

function run(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  options?: { stdin: 'ignore' | 'pipe' },
): { status: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [entry, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...env, NODE_NO_WARNINGS: '1' },
    stdio: options?.stdin === 'ignore' ? ['ignore', 'pipe', 'pipe'] : undefined,
  });
  return { status: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('CLI-OBS-LOG-001 acceptance', () => {
  test('help lists subcommands, log options, and example', () => {
    const { status, out } = run(['--help']);
    expect(status).toBe(0);
    for (const needle of ['query', 'create', '--log-level', '--log-format', '--log-file', 'Example:']) {
      expect(out).toContain(needle);
    }
  });

  test('version matches package.json semver', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
    const { status, out } = run(['--version']);
    expect(status).toBe(0);
    expect(out.trim()).toContain(pkg.version);
  });

  test('structured logs go to stderr when --log-file not set', () => {
    const { status, err } = run(['--log-level', 'info', 'query', '--project', 'p1']);
    expect(status).toBe(0);
    expect(err).toMatch(/\[INFO\]/);
    expect(err).toMatch(/query: start/);
  });

  test('dual sink: console and log file share level/msg', () => {
    const dir = join(root, '_runtime', 'cli-obs-test', 'logs');
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, 'dual.log');
    rmSync(logFile, { force: true });
    const { status, err } = run([
      '--log-level',
      'info',
      '--log-format',
      'text',
      '--log-file',
      logFile,
      'query',
      '--project',
      'p1',
    ]);
    expect(status).toBe(0);
    expect(err).toMatch(/\[INFO\]/);
    expect(err).toMatch(/query: start/);
    const fileText = readFileSync(logFile, 'utf8');
    expect(fileText).toMatch(/\[INFO\]/);
    expect(fileText).toMatch(/query: start/);
  });

  test('redacts secrets in env from log output', () => {
    const dir = join(root, '_runtime', 'cli-obs-test', 'redact');
    mkdirSync(dir, { recursive: true });
    const logFile = join(dir, 'r.log');
    rmSync(logFile, { force: true });
    const secret = 'super-secret-token-xyz';
    const { status, err } = run(
      [
        '--log-level',
        'info',
        '--log-file',
        logFile,
        'query',
        '--simulate-http',
        '200',
      ],
      {
        ...process.env,
        DASH_STD4_API_KEY: secret,
        STD4_CLI_LOG_SELF_TEST: '1',
      },
    );
    expect(status).toBe(0);
    const combined = err + readFileSync(logFile, 'utf8');
    expect(combined).toContain('[REDACTED]');
    expect(combined).not.toContain(secret);
    expect(combined).not.toContain('shadow-secret');
    expect(combined.toLowerCase()).not.toContain('authorization: super-secret');
    expect(combined.toLowerCase()).not.toMatch(/bearer super-secret/i);
  });

  test('create --non-interactive missing title exits 7 and names missing param', () => {
    const { status, err } = run(['create', '--non-interactive'], {
      ...process.env,
      CI: '1',
    });
    expect(status).toBe(7);
    expect(err.toLowerCase()).toMatch(/--title|missing required parameter/);
  });

  test('create --non-interactive missing title does not wait on stdin (stdin ignored)', () => {
    const { status, err } = run(
      ['create', '--non-interactive'],
      { ...process.env, CI: '1' },
      { stdin: 'ignore' },
    );
    expect(status).toBe(7);
    expect(err.toLowerCase()).toMatch(/missing required parameter|--title/);
  });

  test('exit code matrix: usage vs config vs http vs child', () => {
    const missing = join(root, '_runtime', 'cli-obs-test', 'nope-config.json');
    expect(run(['--not-a-real-flag']).status).toBe(2);
    expect(run(['query', '--config', missing]).status).toBe(3);
    expect(run(['query', '--simulate-http', '404']).status).toBe(4);
    expect(run(['query', '--simulate-http', '500']).status).toBe(5);
    expect(run(['query', '--child-exit', '9']).status).toBe(6);
  });

  test('--help with broken log-file path still exits 0 and warns', () => {
    const badPath = join('/no_such_root_dir_std4', 'nope.log');
    const { status, err } = run(['--help', '--log-file', badPath]);
    expect(status).toBe(0);
    expect(err.toLowerCase()).toMatch(/unavailable|stderr only|log file/);
  });
});
