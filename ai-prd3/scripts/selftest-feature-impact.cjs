#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { classifyFeatureImpacts } = require('./lib/feature-impact.cjs');

function testBrandNewFeature() {
  const req = '## 功能需求\n应用中文名：真实笔记\n英文名：RealNotes\n';
  const r = classifyFeatureImpacts(req, {
    functionalChange: true,
    driftChanged: true,
    specFeatures: [],
    parsed: {},
  });
  assert(r.new_feature_ids.includes('MOB-BRAND-001') || r.run_feature_ids.length > 0);
  assert(r.feature_impacts.some((x) => x.type === 'N' || x.type === 'I'));
}

function testConfigOnly() {
  const req = '## 部署\n域名 notes.example.com\n';
  const r = classifyFeatureImpacts(req, {
    functionalChange: false,
    driftChanged: true,
    specFeatures: [{ featureId: 'X', name: 'x', relatedTargets: [], description: '' }],
    parsed: { domain_host: 'notes.example.com' },
  });
  assert.strictEqual(r.config_only, true);
  assert(r.feature_impacts.some((x) => x.type === 'C'));
}

function main() {
  testBrandNewFeature();
  testConfigOnly();
  console.error('selftest-feature-impact: OK');
}

main();
