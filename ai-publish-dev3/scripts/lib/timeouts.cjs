'use strict';

const DEFAULT_STAGE = {
  deploy_s: 1800,
  smoke_s: 300,
};

/**
 * @param {object} config  docs/config.dev.json
 * @param {'deploy_s'|'smoke_s'} stageKey
 */
function stageTimeoutSeconds(config, stageKey) {
  const t = (config && config.timeouts) || {};
  const st = t.stages || {};
  const v = st[stageKey];
  if (typeof v === 'number' && v > 0) return v;
  return DEFAULT_STAGE[stageKey] || 600;
}

/**
 * @param {object} config
 * @returns {number} milliseconds
 */
function heartbeatIntervalMs(config) {
  const t = (config && config.timeouts) || {};
  const sc = t.subcommand || {};
  const s =
    typeof sc.heartbeat_interval_s === 'number' && sc.heartbeat_interval_s > 0
      ? sc.heartbeat_interval_s
      : 30;
  return s * 1000;
}

module.exports = { stageTimeoutSeconds, heartbeatIntervalMs };
