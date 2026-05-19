import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveInstallRoot } from './resolve-install-root.ts';

test('resolveInstallRoot 自嵌套入口向上解析到安装根', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-root-'));
  try {
    const root = path.join(tmp, 'with space', 'app');
    const marker = path.join(root, 'vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '// stub\n');

    const nestedFile = path.join(root, 'dist', 'cli', 'cli-entry.js');
    fs.mkdirSync(path.dirname(nestedFile), { recursive: true });
    fs.writeFileSync(nestedFile, '');

    const resolved = resolveInstallRoot(pathToFileURL(nestedFile));
    assert.equal(path.resolve(resolved), path.resolve(root));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('resolveInstallRoot 缺失 marker 时抛错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-nomarker-'));
  try {
    const f = path.join(tmp, 'src', 'x.ts');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, '');
    assert.throws(() => resolveInstallRoot(pathToFileURL(f)), /std4_cli_resolve_install_root_failed/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
