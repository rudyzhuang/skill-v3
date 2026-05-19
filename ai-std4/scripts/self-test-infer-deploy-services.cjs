'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { applyDeployInference } = require('./libs/infer-deploy-services.cjs');

const skillsRoot = process.env.CURSOR_SKILLS_ROOT ||
  path.join(process.env.HOME || process.env.USERPROFILE, '.cursor', 'skills');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'infer-deploy-'));
const docs = path.join(tmp, 'docs');
fs.mkdirSync(docs, { recursive: true });

fs.writeFileSync(path.join(docs, 'config.dev.json'), JSON.stringify({
  deploy: { provider: 'cloudflare', enabled: false, services: [] },
  project: { name: 'AI-VPN' },
}, null, 2));

fs.writeFileSync(path.join(docs, 'prd-backend.json'), JSON.stringify({
  client_target: 'backend',
  project_name: 'AI-VPN',
  tech_stack: { language: 'TypeScript', framework: 'Hono', db: 'Cloudflare D1' },
  features: [
    {
      feature_id: 'BCK-HEALTH-001',
      name: 'health',
      priority: 'P0',
      phase: 'mvp',
      description: 'health',
      acceptance: ['GET /health'],
      endpoints: ['GET /health'],
      db_tables: [],
    },
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
    domain: 'api.example.com',
    service_type: 'workers',
    resources: [
      { role: 'db', kind: 'd1', reason: 'vpn_nodes', status: 'active' },
      { role: 'storage', kind: 'r2', reason: 'media', status: 'active' },
      { role: 'queue', kind: 'queues', reason: 'async jobs', status: 'optional' },
    ],
  },
}, null, 2));

const r = applyDeployInference({
  projectRoot: tmp,
  skillsRoot,
  clientTargets: ['backend', 'website', 'admin'],
  log: null,
});

const cfg = JSON.parse(fs.readFileSync(path.join(docs, 'config.dev.json'), 'utf8'));
const types = (cfg.deploy.services || []).map(s => s.type).sort();
const need = ['d1', 'pages', 'queues', 'r2', 'workers'];
const missing = need.filter(t => !types.includes(t));

if (missing.length) {
  console.error('FAIL missing types:', missing, 'got', types);
  process.exit(1);
}

const d1 = cfg.deploy.services.find(s => s.type === 'd1');
if (d1.requires_artifact !== false || d1.status !== 'draft') {
  console.error('FAIL d1 should be draft resource', d1);
  process.exit(1);
}

console.log('OK infer-deploy-services', { added: r.added, types });
fs.rmSync(tmp, { recursive: true, force: true });
