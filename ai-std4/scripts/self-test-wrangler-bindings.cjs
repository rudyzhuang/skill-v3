'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { applyWranglerBindings, findWranglerTomlPath } = require('./libs/wrangler-bindings.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wrangler-bind-'));
const backend = path.join(tmp, 'src', 'backend');
fs.mkdirSync(backend, { recursive: true });
const wrPath = path.join(backend, 'wrangler.toml');
fs.writeFileSync(wrPath, 'name = "test-api"\nmain = "src/index.ts"\n', 'utf8');

const bindings = {
  d1: [{ binding: 'DB', database_name: 'test-d1', database_id: 'aaaa-bbbb' }],
  r2: [{ binding: 'R2_BUCKET', bucket_name: 'test-assets' }],
  queues: [{ binding: 'JOBS', queue_name: 'test-jobs', consumer_enabled: true }],
  durable_objects: [{
    binding: 'ROOM',
    class_name: 'RoomDO',
    migrations_tag: 'v1',
  }],
};

const r = applyWranglerBindings(wrPath, bindings);
if (!r.ok || r.added.length < 4) {
  console.error('FAIL apply bindings', r);
  process.exit(1);
}

const found = findWranglerTomlPath(tmp, null);
if (found !== wrPath) {
  console.error('FAIL find path', found, wrPath);
  process.exit(1);
}

const content = fs.readFileSync(wrPath, 'utf8');
if (!content.includes('database_id = "aaaa-bbbb"') ||
    !content.includes('bucket_name = "test-assets"') ||
    !content.includes('queue = "test-jobs"') ||
    !content.includes('class_name = "RoomDO"') ||
    !content.includes('new_classes = [ "RoomDO" ]')) {
  console.error('FAIL content missing bindings');
  process.exit(1);
}

console.log('OK wrangler-bindings', r.added);
fs.rmSync(tmp, { recursive: true, force: true });
