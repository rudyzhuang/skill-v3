'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchArtifactsForService,
  formatArtifactMappingFailure,
  effectiveSubPlatform,
} = require('./artifacts.cjs');

describe('artifacts.cjs', () => {
  it('effectiveSubPlatform defaults empty to default', () => {
    assert.equal(effectiveSubPlatform(''), 'default');
    assert.equal(effectiveSubPlatform(undefined), 'default');
    assert.equal(effectiveSubPlatform('apk'), 'apk');
  });

  it('matches ai-code3 status completed', () => {
    const arts = [
      {
        client_target: 'admin',
        sub_platform: 'default',
        status: 'completed',
        artifact_path: '/proj/dist/admin/default',
      },
    ];
    assert.equal(matchArtifactsForService({ client_target: 'admin', sub_platform: 'default' }, arts).length, 1);
  });

  it('service without sub_platform matches artifact sub_platform default', () => {
    const arts = [
      {
        client_target: 'admin',
        sub_platform: 'default',
        status: 'completed',
        artifact_path: '/proj/dist/admin/default',
      },
    ];
    assert.equal(matchArtifactsForService({ client_target: 'admin' }, arts).length, 1);
  });

  it('does not match failed or not_applicable', () => {
    const arts = [
      { client_target: 'admin', sub_platform: 'default', status: 'failed', artifact_path: '/x' },
      { client_target: 'backend', sub_platform: 'default', status: 'not_applicable', artifact_path: '/y' },
    ];
    assert.equal(matchArtifactsForService({ client_target: 'admin', sub_platform: 'default' }, arts).length, 0);
    assert.equal(matchArtifactsForService({ client_target: 'backend', sub_platform: 'default' }, arts).length, 0);
  });

  it('formatArtifactMappingFailure hints missing build row', () => {
    const msg = formatArtifactMappingFailure({ client_target: 'admin' }, []);
    assert.match(msg, /未登记 admin/);
    assert.match(msg, /0 条/);
  });
});
