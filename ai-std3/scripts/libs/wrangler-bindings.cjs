'use strict';

const fs   = require('fs');
const path = require('path');

const RESOURCE_TYPE_ORDER = { d1: 0, r2: 1, kv: 2, queues: 3, durable_objects: 4 };

/**
 * 在业务仓内查找 wrangler.toml（优先 build 产物目录）
 */
function findWranglerTomlPath(projectRoot, artifactPath) {
  const candidates = [];
  if (artifactPath) {
    candidates.push(path.join(artifactPath, 'wrangler.toml'));
    candidates.push(path.join(path.dirname(artifactPath), 'wrangler.toml'));
  }
  candidates.push(path.join(projectRoot, 'src', 'backend', 'wrangler.toml'));
  candidates.push(path.join(projectRoot, 'wrangler.toml'));

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function hasD1Block(content, { binding, database_name, database_id }) {
  return content.includes(`database_id = "${database_id}"`) ||
    (database_name && content.includes(`database_name = "${database_name}"`)) ||
    (binding && new RegExp(`binding\\s*=\\s*["']${binding}["']`).test(content));
}

function hasR2Block(content, { binding, bucket_name }) {
  return (bucket_name && content.includes(`bucket_name = "${bucket_name}"`)) ||
    (binding && new RegExp(`binding\\s*=\\s*["']${binding}["']`).test(content));
}

function hasKvBlock(content, { binding }) {
  return binding && new RegExp(`binding\\s*=\\s*["']${binding}["']`).test(content);
}

function hasQueueProducerBlock(content, { binding, queue_name }) {
  if (binding && new RegExp(`binding\\s*=\\s*["']${binding}["']`).test(content)) return true;
  return queue_name && content.includes(`queue = "${queue_name}"`);
}

function hasDurableObjectBlock(content, { binding, class_name }) {
  if (class_name && content.includes(`class_name = "${class_name}"`)) return true;
  return binding && new RegExp(`name\\s*=\\s*["']${binding}["']`).test(content);
}

function hasMigrationTag(content, tag, className) {
  if (!content.includes(`tag = "${tag}"`)) return false;
  return !className || content.includes(`"${className}"`);
}

/**
 * @param {string} wranglerPath
 * @param {{ d1,r2,kv,queues,durable_objects }} bindings
 */
function applyWranglerBindings(wranglerPath, bindings) {
  if (!wranglerPath || !fs.existsSync(wranglerPath)) {
    return { ok: false, error: 'wrangler.toml not found', path: wranglerPath };
  }

  let content = fs.readFileSync(wranglerPath, 'utf8');
  const added = [];

  for (const d1 of bindings.d1 || []) {
    if (hasD1Block(content, d1)) continue;
    const binding = d1.binding || 'DB';
    const block = [
      '',
      '[[d1_databases]]',
      `binding = "${binding}"`,
      `database_name = "${d1.database_name}"`,
      `database_id = "${d1.database_id}"`,
      '',
    ].join('\n');
    content += block;
    added.push(`d1:${d1.database_name}`);
  }

  for (const r2 of bindings.r2 || []) {
    if (hasR2Block(content, r2)) continue;
    const binding = r2.binding || 'R2_BUCKET';
    const block = [
      '',
      '[[r2_buckets]]',
      `binding = "${binding}"`,
      `bucket_name = "${r2.bucket_name}"`,
      '',
    ].join('\n');
    content += block;
    added.push(`r2:${r2.bucket_name}`);
  }

  for (const kv of bindings.kv || []) {
    if (hasKvBlock(content, kv)) continue;
    const binding = kv.binding || 'KV';
    const block = [
      '',
      '[[kv_namespaces]]',
      `binding = "${binding}"`,
      `id = "${kv.namespace_id}"`,
      '',
    ].join('\n');
    content += block;
    added.push(`kv:${binding}`);
  }

  for (const q of bindings.queues || []) {
    if (hasQueueProducerBlock(content, q)) continue;
    const binding = q.binding || 'QUEUE';
    const block = [
      '',
      '[[queues.producers]]',
      `binding = "${binding}"`,
      `queue = "${q.queue_name}"`,
      '',
    ].join('\n');
    content += block;
    added.push(`queues:${q.queue_name}`);

    if (q.consumer_enabled) {
      const consumerBlock = [
        '',
        '[[queues.consumers]]',
        `queue = "${q.queue_name}"`,
        'max_batch_size = 10',
        'max_batch_timeout = 30',
        '',
      ].join('\n');
      if (!content.includes(`[[queues.consumers]]`) || !content.includes(`queue = "${q.queue_name}"`)) {
        content += consumerBlock;
        added.push(`queues-consumer:${q.queue_name}`);
      }
    }
  }

  for (const dObj of bindings.durable_objects || []) {
    const migTag = dObj.migrations_tag || 'v1';
    if (hasDurableObjectBlock(content, dObj) && hasMigrationTag(content, migTag, dObj.class_name)) {
      continue;
    }
    const bindingName = dObj.binding || dObj.class_name;
    const block = [
      '',
      '[[durable_objects.bindings]]',
      `name = "${bindingName}"`,
      `class_name = "${dObj.class_name}"`,
      '',
    ].join('\n');
    content += block;
    added.push(`do-bind:${dObj.class_name}`);

    if (!hasMigrationTag(content, migTag, dObj.class_name)) {
      const migBlock = [
        '',
        '[[migrations]]',
        `tag = "${migTag}"`,
        `new_classes = [ "${dObj.class_name}" ]`,
        '',
      ].join('\n');
      content += migBlock;
      added.push(`do-migration:${migTag}`);
    }
  }

  if (added.length > 0) {
    fs.writeFileSync(wranglerPath, content, 'utf8');
  }

  return { ok: true, path: wranglerPath, added };
}

function sortDeployServices(services) {
  return [...services].sort((a, b) => {
    const ta = RESOURCE_TYPE_ORDER[(a.type || '').toLowerCase()];
    const tb = RESOURCE_TYPE_ORDER[(b.type || '').toLowerCase()];
    const oa = ta != null ? ta : (a.type === 'workers' ? 10 : a.type === 'pages' ? 11 : 50);
    const ob = tb != null ? tb : (b.type === 'workers' ? 10 : b.type === 'pages' ? 11 : 50);
    if (oa !== ob) return oa - ob;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

module.exports = {
  findWranglerTomlPath,
  applyWranglerBindings,
  sortDeployServices,
  RESOURCE_TYPE_ORDER,
};
