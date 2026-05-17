#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { bodyExpectFailed } = require('./http-smoke.cjs');

const fails = bodyExpectFailed(
  { path: '/', body_contains: '我的笔记', body_not_contains: 'TiddlyWiki' },
  '<html><title>笔记</title>欢迎</html>',
  '笔记'
);
assert.strictEqual(fails.length, 1);

const ok = bodyExpectFailed(
  { path: '/', body_contains: '我的笔记' },
  '<html>我的笔记</html>',
  ''
);
assert.strictEqual(ok.length, 0);

console.error('http-smoke.selftest: OK');
