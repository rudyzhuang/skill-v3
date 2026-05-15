'use strict';

/**
 * @param {object} svc
 * @param {object[]} arts
 * @returns {object[]}
 */
function matchArtifactsForService(svc, arts) {
  if (!svc || !svc.client_target) return [];
  if (svc.artifact_ref != null && String(svc.artifact_ref).trim() !== '') {
    const ref = String(svc.artifact_ref).trim();
    return arts.filter(
      (a) =>
        a &&
        a.artifact_path &&
        (a.artifact_path === ref || a.artifact_path.endsWith(ref))
    );
  }
  const sub = svc.sub_platform || '';
  return arts.filter(
    (a) =>
      a &&
      a.client_target === svc.client_target &&
      (a.sub_platform || '') === sub &&
      a.status === 'success' &&
      a.artifact_path
  );
}

/**
 * @param {object[]} services
 * @param {object[]} arts
 * @returns {object[]}
 */
function collectConsumedArtifacts(services, arts) {
  const consumed = [];
  for (const svc of services || []) {
    if (!svc || !svc.client_target) continue;
    const matches = matchArtifactsForService(svc, arts);
    if (matches.length !== 1) {
      throw new Error(
        `artifact 一对一映射失败: (${svc.client_target},${svc.sub_platform || ''}) artifact_ref=${svc.artifact_ref || 'n/a'} → ${matches.length} 条`
      );
    }
    consumed.push(matches[0]);
  }
  return consumed;
}

module.exports = { matchArtifactsForService, collectConsumedArtifacts };
