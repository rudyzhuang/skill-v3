#!/usr/bin/env node
'use strict';

/**
 * 只读导出 registry.sqlite → 单行 JSON（供 ai-dash3 web 等多项目看板消费）
 * schema: ai-auto3.registry-export.v1
 */

const { buildRegistryExportShape } = require('./lib/runtime-io.cjs');

function main() {
  const payload = buildRegistryExportShape();
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main();
