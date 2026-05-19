import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { resolveCursorSkillsRoot } from './resolve-cursor-skills-root.ts';

test('resolveCursorSkillsRoot 返回 vendor 绝对路径且不回退到家目录', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'std4-skills-'));
  try {
    const root = path.join(tmp, 'rel', 'install');
    const marker = path.join(root, 'vendor', 'ai-std4', 'scripts', 'run-pipeline.cjs');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '// stub\n');

    const entry = path.join(root, 'dist', 'cli', 'cli-entry.js');
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(entry, '');

    const skillsRoot = resolveCursorSkillsRoot(pathToFileURL(entry));
    assert.equal(path.isAbsolute(skillsRoot), true);
    assert.equal(path.resolve(skillsRoot), path.resolve(root, 'vendor'));
    assert.match(skillsRoot, /^([A-Za-z]:)?[\\/]/);
    assert.doesNotMatch(skillsRoot, /\.cursor[\\/]skills/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
