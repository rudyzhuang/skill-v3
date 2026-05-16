'use strict';

const crypto = require('crypto');

function sha256Stable(obj) {
  const json = JSON.stringify(obj, Object.keys(obj).sort());
  return crypto.createHash('sha256').update(json).digest('hex');
}

function uiE2eSummaryInput({ scenarios, sources, baseUrls }) {
  return {
    scenarios: (scenarios || []).map((s) => ({
      id: s.id,
      client_target: s.client_target,
      platform: s.platform,
    })),
    sources,
    baseUrls,
  };
}

module.exports = { sha256Stable, uiE2eSummaryInput };
