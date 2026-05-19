'use strict';

const fs = require('fs');
const { spawnSync } = require('child_process');
const { cfApiCall } = require('./cloudflare-api.cjs');

function wranglerEnv(token, accountId) {
  return {
    ...process.env,
    CLOUDFLARE_API_TOKEN:  token,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  };
}

function runWrangler(args, { cwd, token, accountId, timeoutMs = 120000, stageLogPath, label }) {
  const r = spawnSync('npx', ['wrangler', ...args], {
    cwd:      cwd || process.cwd(),
    encoding: 'utf8',
    timeout:  timeoutMs,
    env:      wranglerEnv(token, accountId),
    stdio:    ['ignore', 'pipe', 'pipe'],
  });
  if (stageLogPath) {
    try {
      fs.appendFileSync(
        stageLogPath,
        `[wrangler ${label || args.join(' ')}]\nSTDOUT:\n${r.stdout}\nSTDERR:\n${r.stderr}\n`
      );
    } catch (_) { /* */ }
  }
  return r;
}

async function findD1ByName({ databaseName, token, accountId }) {
  const list = await cfApiCall({
    method: 'GET',
    path:   `/accounts/${accountId}/d1/database`,
    token,
    accountId,
  });
  if (list.status !== 200 || !list.body || !Array.isArray(list.body.result)) {
    return null;
  }
  return list.body.result.find(db => db.name === databaseName) || null;
}

async function provisionD1({ service, token, accountId, projectRoot, log, stageLogPath }) {
  const rc = service.resource_config || {};
  const databaseName = rc.database_name || `${service.name}-d1`;
  const binding = rc.binding_name || 'DB';

  let existing = await findD1ByName({ databaseName, token, accountId });
  if (!existing) {
    log.info('deploy_provision_start', `[provision] D1 create ${databaseName}`, {
      service_name: service.name, type: 'd1', database_name: databaseName,
    });

    const create = await cfApiCall({
      method: 'POST',
      path:   `/accounts/${accountId}/d1/database`,
      body:   { name: databaseName },
      token,
      accountId,
    });

    if (create.status === 200 || create.status === 201) {
      existing = create.body && create.body.result;
    } else {
      const msg = (create.body && create.body.errors && create.body.errors[0] && create.body.errors[0].message) ||
        `HTTP ${create.status}`;
      if (!/already exists|duplicate/i.test(msg)) {
        throw new Error(`D1 创建失败：${msg}`);
      }
      existing = await findD1ByName({ databaseName, token, accountId });
    }
  }

  if (!existing || !existing.uuid) {
    const wr = runWrangler(['d1', 'create', databaseName], {
      cwd: projectRoot, token, accountId, stageLogPath, label: 'd1 create',
    });
    const idMatch = (wr.stdout || '').match(/database_id\s*=\s*"([^"]+)"/);
    const uuid = idMatch ? idMatch[1] : null;
    if (!uuid && wr.status !== 0) {
      throw new Error(`D1 wrangler create 失败：${(wr.stderr || wr.stdout || '').slice(-400)}`);
    }
    existing = { name: databaseName, uuid: uuid || existing && existing.uuid };
  }

  const databaseId = existing.uuid;
  log.info('deploy_provision_complete', `[provision] D1 就绪 ${databaseName}`, {
    service_name: service.name, database_id: databaseId,
  });

  return {
    type:           'd1',
    database_name:  databaseName,
    database_id:    databaseId,
    binding,
    resource_config: Object.assign({}, rc, {
      database_name: databaseName,
      database_id:   databaseId,
      binding_name:  binding,
    }),
  };
}

async function provisionR2({ service, token, accountId, projectRoot, log, stageLogPath }) {
  const rc = service.resource_config || {};
  const bucketName = rc.bucket_name || rc.bucket || `${service.name}-assets`;
  const binding = rc.binding_name || 'R2_BUCKET';

  log.info('deploy_provision_start', `[provision] R2 bucket ${bucketName}`, {
    service_name: service.name, type: 'r2', bucket_name: bucketName,
  });

  const create = await cfApiCall({
    method: 'PUT',
    path:   `/accounts/${accountId}/r2/buckets/${bucketName}`,
    body:   {},
    token,
    accountId,
  });

  if (create.status !== 200 && create.status !== 201) {
    const msg = (create.body && create.body.errors && create.body.errors[0] && create.body.errors[0].message) ||
      `HTTP ${create.status}`;
    if (!/already exists|already owned|duplicate/i.test(msg)) {
      const wr = runWrangler(['r2', 'bucket', 'create', bucketName], {
        cwd: projectRoot, token, accountId, stageLogPath, label: 'r2 create',
      });
      if (wr.status !== 0 && !/already exists/i.test(wr.stderr || wr.stdout || '')) {
        throw new Error(`R2 创建失败：${msg}; wrangler: ${(wr.stderr || '').slice(-300)}`);
      }
    }
  }

  log.info('deploy_provision_complete', `[provision] R2 就绪 ${bucketName}`, {
    service_name: service.name, bucket_name: bucketName,
  });

  return {
    type:          'r2',
    bucket_name:   bucketName,
    binding,
    resource_config: Object.assign({}, rc, {
      bucket_name:  bucketName,
      binding_name: binding,
    }),
  };
}

async function provisionKv({ service, token, accountId, projectRoot, log, stageLogPath }) {
  const rc = service.resource_config || {};
  const title = rc.namespace_title || `${service.name}-kv`;
  const binding = rc.binding_name || 'KV';

  log.info('deploy_provision_start', `[provision] KV namespace ${title}`, {
    service_name: service.name, type: 'kv',
  });

  const wr = runWrangler(['kv', 'namespace', 'create', title], {
    cwd: projectRoot, token, accountId, stageLogPath, label: 'kv create',
  });

  let namespaceId = rc.namespace_id || null;
  const idMatch = (wr.stdout || '').match(/id\s*=\s*"([^"]+)"/);
  if (idMatch) namespaceId = idMatch[1];

  if (!namespaceId && wr.status !== 0) {
    if (!/already exists/i.test(wr.stderr || wr.stdout || '')) {
      throw new Error(`KV 创建失败：${(wr.stderr || wr.stdout || '').slice(-400)}`);
    }
    const list = runWrangler(['kv', 'namespace', 'list'], {
      cwd: projectRoot, token, accountId, stageLogPath, label: 'kv list',
    });
    try {
      const arr = JSON.parse(list.stdout || '[]');
      const hit = arr.find(n => n.title === title);
      if (hit) namespaceId = hit.id;
    } catch (_) { /* */ }
  }

  if (!namespaceId) {
    throw new Error(`KV namespace 创建后未解析到 id（title=${title}）`);
  }

  log.info('deploy_provision_complete', `[provision] KV 就绪 ${title}`, {
    service_name: service.name, namespace_id: namespaceId,
  });

  return {
    type:           'kv',
    namespace_id:   namespaceId,
    namespace_title: title,
    binding,
    resource_config: Object.assign({}, rc, {
      namespace_id:    namespaceId,
      namespace_title: title,
      binding_name:    binding,
    }),
  };
}

async function findQueueByName({ queueName, token, accountId }) {
  const list = await cfApiCall({
    method: 'GET',
    path:   `/accounts/${accountId}/queues`,
    token,
    accountId,
  });
  if (list.status !== 200 || !list.body) return null;
  const items = list.body.result ||
    (Array.isArray(list.body) ? list.body : []);
  if (!Array.isArray(items)) return null;
  return items.find(q =>
    q.queue_name === queueName || q.name === queueName
  ) || null;
}

async function provisionQueues({ service, token, accountId, projectRoot, log, stageLogPath }) {
  const rc = service.resource_config || {};
  const queueName = rc.queue_name || `${service.name}-queue`;
  const binding = rc.binding_name || 'QUEUE';

  log.info('deploy_provision_start', `[provision] Queue ${queueName}`, {
    service_name: service.name, type: 'queues', queue_name: queueName,
  });

  let existing = await findQueueByName({ queueName, token, accountId });
  if (!existing) {
    const create = await cfApiCall({
      method: 'POST',
      path:   `/accounts/${accountId}/queues`,
      body:   { queue_name: queueName },
      token,
      accountId,
    });
    if (create.status === 200 || create.status === 201) {
      existing = create.body && create.body.result;
    } else {
      const msg = (create.body && create.body.errors && create.body.errors[0] && create.body.errors[0].message) ||
        `HTTP ${create.status}`;
      if (!/already exists|duplicate/i.test(msg)) {
        const wr = runWrangler(['queues', 'create', queueName], {
          cwd: projectRoot, token, accountId, stageLogPath, label: 'queues create',
        });
        if (wr.status !== 0 && !/already exists/i.test(wr.stderr || wr.stdout || '')) {
          throw new Error(`Queue 创建失败：${msg}; wrangler: ${(wr.stderr || '').slice(-300)}`);
        }
        existing = await findQueueByName({ queueName, token, accountId }) || { queue_name: queueName };
      } else {
        existing = await findQueueByName({ queueName, token, accountId }) || { queue_name: queueName };
      }
    }
  }

  const queueId = existing.queue_id || existing.id || null;

  log.info('deploy_provision_complete', `[provision] Queue 就绪 ${queueName}`, {
    service_name: service.name, queue_name: queueName, queue_id: queueId,
  });

  return {
    type:        'queues',
    queue_name:  queueName,
    queue_id:    queueId,
    binding,
    consumer_enabled: !!rc.consumer_enabled,
    resource_config: Object.assign({}, rc, {
      queue_name:   queueName,
      queue_id:     queueId,
      binding_name: binding,
    }),
  };
}

/**
 * Durable Objects：远程资源随 Worker 部署创建；本步仅校验并准备 wrangler 绑定/迁移元数据。
 */
async function provisionDurableObjects({ service, token, accountId, projectRoot, log }) {
  const rc = service.resource_config || {};
  const className = rc.class_name || 'AppDO';
  const binding = rc.binding_name || 'DO';
  const migrationsTag = rc.migrations_tag || 'v1';

  if (!className || !/^[A-Za-z][A-Za-z0-9_]*$/.test(className)) {
    throw new Error(`Durable Object class_name 无效: ${className}`);
  }

  log.info('deploy_provision_start', `[provision] Durable Objects 配置 ${className}`, {
    service_name: service.name,
    type:         'durable_objects',
    class_name:   className,
    migrations_tag: migrationsTag,
  });

  log.info('deploy_provision_complete', `[provision] DO 配置就绪（将在 wrangler deploy 时生效）`, {
    service_name: service.name,
    class_name:   className,
  });

  return {
    type:           'durable_objects',
    class_name:     className,
    binding,
    migrations_tag: migrationsTag,
    resource_config: Object.assign({}, rc, {
      class_name:     className,
      binding_name:   binding,
      migrations_tag: migrationsTag,
    }),
  };
}

/**
 * @returns {Promise<object>} provision 结果（含 resource_config 更新）
 */
async function provisionCloudflareResource(opts) {
  const { service } = opts;
  const type = (service.type || '').toLowerCase();

  if (type === 'd1') return provisionD1(opts);
  if (type === 'r2') return provisionR2(opts);
  if (type === 'kv') return provisionKv(opts);
  if (type === 'queues') return provisionQueues(opts);
  if (type === 'durable_objects') return provisionDurableObjects(opts);

  throw new Error(`provision 未实现类型: ${type}`);
}

module.exports = {
  provisionCloudflareResource,
  provisionD1,
  provisionR2,
  provisionKv,
  provisionQueues,
  provisionDurableObjects,
};
