'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const {
  applyDeployInference,
  auditDeployResources,
} = require('./libs/infer-deploy-services.cjs');

const skillsRoot = process.env.CURSOR_SKILLS_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-audit-'));
const docs = path.join(tmp, 'docs');
fs.mkdirSync(docs, { recursive: true });

const prdBackend = {
  client_target: 'backend',
  project_name: 'Audit-Test',
  tech_stack: { language: 'TypeScript', framework: 'Hono', db: 'Cloudflare D1' },
  features: [
    {
      feature_id: 'BCK-NODES-001',
      name: 'nodes',
      priority: 'P0',
      phase: 'mvp',
      description: 'nodes',
      acceptance: ['支持图片上传到 R2', '异步任务写入队列'],
      endpoints: ['GET /admin/nodes'],
      db_tables: ['vpn_nodes'],
    },
  ],
  deploy: {
    platform: 'cloudflare',
    service_type: 'workers',
    resources: [
      { role: 'db', kind: 'd1', reason: 'vpn_nodes', status: 'active' },
    ],
  },
};

fs.writeFileSync(path.join(docs, 'prd-backend.json'), JSON.stringify(prdBackend, null, 2));
fs.writeFileSync(path.join(docs, 'config.dev.json'), JSON.stringify({
  deploy: { provider: 'cloudflare', services: [] },
  project: { name: 'Audit-Test' },
}, null, 2));

const audit = auditDeployResources({
  prdBackend,
  clientTargets: ['backend'],
  allPrdDocs: [prdBackend],
});

const warnText = audit.warnings.join('\n');
const needKinds = ['r2', 'queues'];
for (const k of needKinds) {
  if (!warnText.includes(k)) {
    console.error('FAIL audit should warn missing kind', k, audit.warnings);
    process.exit(1);
  }
}

if (!audit.gaps.some(g => g.kind === 'r2') || !audit.gaps.some(g => g.kind === 'queues')) {
  console.error('FAIL audit gaps', audit.gaps);
  process.exit(1);
}

const r = applyDeployInference({
  projectRoot: tmp,
  skillsRoot,
  clientTargets: ['backend'],
  log: null,
});

if (!r.resource_audit || r.resource_audit.gap_count < 2) {
  console.error('FAIL applyDeployInference resource_audit', r.resource_audit);
  process.exit(1);
}

const cfg = JSON.parse(fs.readFileSync(path.join(docs, 'config.dev.json'), 'utf8'));
const types = new Set((cfg.deploy.services || []).map(s => s.type));
for (const k of ['d1', 'r2', 'queues', 'workers']) {
  if (!types.has(k)) {
    console.error('FAIL config missing type after auto-complete', k, [...types]);
    process.exit(1);
  }
}

console.log('OK infer-deploy-audit', {
  warnings: audit.warnings.length,
  gap_count: r.resource_audit.gap_count,
  types: [...types],
});
fs.rmSync(tmp, { recursive: true, force: true });
