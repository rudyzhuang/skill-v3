'use strict';

/** ai-code3 build.cjs 写入 completed；历史/契约亦允许 success */
const DEPLOYABLE_STATUSES = new Set(['success', 'completed']);

/**
 * deploy / build 对齐用的 sub_platform：未声明或空串视为 default（input-spec §8 单平台端）
 * @param {string|undefined|null} sub
 * @returns {string}
 */
function effectiveSubPlatform(sub) {
  const s = sub == null ? '' : String(sub).trim();
  return s || 'default';
}

/**
 * @param {object|undefined|null} a
 * @returns {boolean}
 */
function isDeployableArtifact(a) {
  return !!(
    a &&
    a.client_target &&
    a.artifact_path &&
    DEPLOYABLE_STATUSES.has(String(a.status || ''))
  );
}

/**
 * @param {object} svc
 * @param {object[]} arts
 * @returns {object[]}
 */
function matchArtifactsForService(svc, arts) {
  if (!svc || !svc.client_target) return [];
  if (svc.artifact_ref != null && String(svc.artifact_ref).trim() !== '') {
    const ref = String(svc.artifact_ref).trim();
    return (arts || []).filter(
      (a) =>
        a &&
        a.artifact_path &&
        isDeployableArtifact(a) &&
        (a.artifact_path === ref || a.artifact_path.endsWith(ref))
    );
  }
  const sub = effectiveSubPlatform(svc.sub_platform);
  return (arts || []).filter(
    (a) =>
      a &&
      a.client_target === svc.client_target &&
      effectiveSubPlatform(a.sub_platform) === sub &&
      isDeployableArtifact(a)
  );
}

/**
 * @param {object} svc
 * @param {object[]} arts
 * @returns {string}
 */
function formatArtifactMappingFailure(svc, arts) {
  const ct = svc?.client_target || '?';
  const subRaw = svc?.sub_platform;
  const subShown = subRaw == null || String(subRaw).trim() === '' ? '' : String(subRaw);
  const matches = matchArtifactsForService(svc, arts);
  const lines = [
    `artifact 一对一映射失败: (${ct},${subShown}) artifact_ref=${svc?.artifact_ref || 'n/a'} → ${matches.length} 条`,
  ];

  const list = arts || [];
  const forTarget = list.filter((a) => a && a.client_target === ct);
  const deployable = forTarget.filter(isDeployableArtifact);

  if (forTarget.length === 0) {
    lines.push(
      `（build 未登记 ${ct} 产物：stages.build.outputs.artifacts[] 无 client_target="${ct}"；若刚 skip build 请重跑 build 或 --force-rerun）`
    );
  } else if (deployable.length === 0) {
    const statuses = [...new Set(forTarget.map((a) => a.status || '(empty)'))];
    lines.push(
      `（build 有 ${ct} 记录但不可部署：须 status 为 success/completed 且 artifact_path 非空；当前 status: ${statuses.join(', ')}）`
    );
  } else if (deployable.length > 1 && matches.length !== 1) {
    const subs = [...new Set(deployable.map((a) => effectiveSubPlatform(a.sub_platform)))];
    lines.push(`（${ct} 存在多条可部署产物，sub_platform: ${subs.join(', ')}；请用 deploy.services[].sub_platform 或 artifact_ref 区分）`);
  }

  if (String(subRaw ?? '').trim() === '' && deployable.some((a) => effectiveSubPlatform(a.sub_platform) === 'default')) {
    lines.push('（建议在 deploy.services[] 显式写 "sub_platform": "default" 与 ai-code3 产物对齐）');
  }

  return lines.join(' ');
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
      throw new Error(formatArtifactMappingFailure(svc, arts));
    }
    consumed.push(matches[0]);
  }
  return consumed;
}

module.exports = {
  DEPLOYABLE_STATUSES,
  effectiveSubPlatform,
  isDeployableArtifact,
  matchArtifactsForService,
  formatArtifactMappingFailure,
  collectConsumedArtifacts,
};
