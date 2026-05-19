'use strict';

const assert = require('assert');
const path = require('path');
const { resolveSkillGitRoot } = require('./libs/skill-prompt-publish.cjs');

const skillsRoot = path.resolve(__dirname, '..', '..');
const gitRoot = resolveSkillGitRoot(skillsRoot);
assert.ok(gitRoot, 'git root resolved');
assert.ok(
  require('fs').existsSync(path.join(gitRoot, '.git')) ||
    require('fs').existsSync(path.join(gitRoot, 'ai-std3')),
  'expected skill repo layout'
);

console.log('self-test-skill-prompt-publish: ok');
