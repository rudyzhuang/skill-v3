import assert from 'node:assert/strict';
import test from 'node:test';

import { scrubSecrets, putProjectPipeline } from './dash-pipeline-client.js';

test('scrubSecrets removes common secret patterns', () => {
  const s = scrubSecrets(
    'x DASH_STD4_API_KEY=secret CURSOR_API_KEY=abc Authorization: Bearer tok',
  );
  assert.ok(!s.includes('secret'));
  assert.ok(!s.includes('tok'));
  assert.ok(s.includes('<redacted>'));
});

test('putProjectPipeline maps HTTP statuses (401) without echoing api key in error fields', async () => {
  const fetchFn = async (_url: RequestInfo | URL, _init?: RequestInit) =>
    new Response('{"error":"nope"}', { status: 401 });

  const r = await putProjectPipeline(
    'proj',
    {
      current_stage: null,
      stages: [],
      features: [],
      blocking_issues: [],
      log_tail: '',
      correlation_id: 'c1',
    },
    { apiBaseUrl: 'https://example.invalid', apiKey: 'SUPER_SECRET', fetchFn },
  );

  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.error.status, 401);
    assert.ok(!String(r.error.message).includes('SUPER_SECRET'));
    assert.ok(!String(r.error.bodySnippet).includes('SUPER_SECRET'));
  }
});
