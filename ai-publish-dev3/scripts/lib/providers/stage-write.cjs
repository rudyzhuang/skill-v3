'use strict';

const { updateStages } = require('../stages-io.cjs');
const featureStages = require('../../../../ai-auto3/scripts/lib/feature-stages.cjs');

/**
 * @param {object[]} consumed
 * @param {string} summaryHash
 * @param {object} [prevInputs]
 */
function mapConsumedToInputs(consumed, summaryHash, prevInputs) {
  return {
    ...(prevInputs || {}),
    summary_hash: summaryHash,
    requires_stage: 'build',
    config: 'docs/config.dev.json',
    secret_env: 'docs/config.env',
    artifacts: consumed.map((a) => ({
      client_target: a.client_target,
      sub_platform: a.sub_platform || '',
      artifact_path: a.artifact_path,
      status: a.status,
    })),
  };
}

/**
 * @param {string} stPath
 * @param {number} t0
 * @param {string} summaryHash
 * @param {object[]} consumed
 * @param {{
 *   provider: string,
 *   services: object[],
 *   deploy_url: string,
 *   validationSummary?: string,
 * }} p
 */
function finalizeDeploySuccess(stPath, t0, summaryHash, consumed, p) {
  const now = new Date().toISOString();
  const provider = p.provider;
  const validationSummary = p.validationSummary || `deploy（${provider}）`;
  updateStages(stPath, (doc) => {
    doc.stages = doc.stages || {};
    const prev = doc.stages.deploy || {};
    doc.stages.deploy = {
      ...prev,
      status: 'completed',
      environment: 'dev',
      started_at: prev.started_at || now,
      completed_at: now,
      inputs: mapConsumedToInputs(consumed, summaryHash, prev.inputs),
      outputs: {
        ...(prev.outputs || {}),
        environment: 'dev',
        provider,
        services: p.services,
        deploy_url: (p.deploy_url || '').replace(/\/$/, ''),
        commit: '',
        error: '',
        timed_out: false,
        timeout_reason: null,
        duration_ms: Date.now() - t0,
      },
      validation: {
        ...(prev.validation || {}),
        passed: true,
        checked_at: now,
        summary: validationSummary,
      },
    };
    featureStages.backfillFeatureStages(doc);
    const ids = featureStages.collectPhaseFeatureIds(doc);
    return featureStages.markFeaturesCompleted(doc, 'deploy', ids, { message: validationSummary });
  });
}

/**
 * @param {string} stPath
 * @param {number} t0
 * @param {string} summaryHash
 * @param {object[]} consumed
 * @param {{
 *   provider: string,
 *   services?: object[],
 *   errorMsg: string,
 *   validationSummary?: string,
 * }} p
 */
function finalizeDeployFailure(stPath, t0, summaryHash, consumed, p) {
  const now = new Date().toISOString();
  const provider = p.provider;
  const msg = String(p.errorMsg || '').slice(0, 2000);
  const validationSummary = p.validationSummary || `deploy 失败（${provider}）`;
  updateStages(stPath, (doc) => {
    doc.stages = doc.stages || {};
    const prev = doc.stages.deploy || {};
    doc.stages.deploy = {
      ...prev,
      status: 'completed',
      environment: 'dev',
      completed_at: now,
      inputs: mapConsumedToInputs(consumed, summaryHash, prev.inputs),
      outputs: {
        ...(prev.outputs || {}),
        environment: 'dev',
        provider,
        services: p.services || [],
        deploy_url: '',
        error: msg,
        timed_out: false,
        timeout_reason: null,
        duration_ms: Date.now() - t0,
      },
      validation: {
        ...(prev.validation || {}),
        passed: false,
        checked_at: now,
        summary: validationSummary,
      },
    };
    featureStages.backfillFeatureStages(doc);
    const ids = featureStages.collectPhaseFeatureIds(doc);
    return featureStages.markFeaturesFailed(doc, 'deploy', ids, { message: msg || validationSummary });
  });
}

module.exports = { finalizeDeploySuccess, finalizeDeployFailure, mapConsumedToInputs };
