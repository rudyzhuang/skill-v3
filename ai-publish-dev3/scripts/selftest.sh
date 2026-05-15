#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FX="$ROOT/test-fixtures/minimal"
SK="$ROOT/scripts"
REPO="$(cd "$ROOT/.." && pwd)"
SNAP="$FX/.pipeline/stages.snapshot.json"
if [[ -f "$SNAP" ]]; then
  cp "$SNAP" "$FX/.pipeline/stages.json"
elif git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$REPO" restore "$FX/.pipeline/stages.json" 2>/dev/null || true
fi

echo "== npm ci (js-yaml) =="
( cd "$ROOT" && npm ci )

echo "== node --check =="
for f in "$SK"/*.cjs "$SK"/lib/*.cjs "$SK"/lib/providers/*.cjs; do
  [[ -f "$f" ]] || continue
  node --check "$f"
done

echo "== init.cjs =="
node "$SK/init.cjs" --project="$FX"

echo "== run.cjs dry-run =="
node "$SK/run.cjs" --project="$FX" --dry-run

echo "== run.cjs full (manual deploy + HTTP smoke) =="
node "$SK/run.cjs" --project="$FX" --explicit-confirm

echo "== idempotent second run (skip deploy/smoke when hash unchanged) =="
node "$SK/run.cjs" --project="$FX" --explicit-confirm

echo "== force-rerun =="
node "$SK/run.cjs" --project="$FX" --explicit-confirm --force-rerun

echo "== smoke exit 4: expect failure =="
set +e
mkdir -p "$FX/tmp-bad-smoke/docs" "$FX/tmp-bad-smoke/.pipeline"
cp "$FX/docs/config.dev.json" "$FX/tmp-bad-smoke/docs/config.dev.json"
cp "$FX/docs/config.env" "$FX/tmp-bad-smoke/docs/config.env"
node -e "
const fs=require('fs');
const p='$FX/tmp-bad-smoke/docs/config.dev.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.smoke.checks=[{name:'nope',method:'GET',path:'/this-path-should-not-exist-404-ai-publish-dev3',expected_status:200}];
fs.writeFileSync(p, JSON.stringify(j,null,2));
"
cp "$FX/.pipeline/stages.json" "$FX/tmp-bad-smoke/.pipeline/stages.json"
node "$SK/run.cjs" --project="$FX/tmp-bad-smoke" --explicit-confirm --force-rerun
EC=$?
set -e
if [[ "$EC" -eq 4 ]]; then
  echo "smoke failed with exit 4 as expected"
else
  echo "unexpected exit $EC (want 4)" >&2
  exit 1
fi

echo "== deploy exit 8 (exit8-test + AI_PUBLISH_DEV3_SELFTEST) =="
set +e
TMP_EXIT8="$(mktemp -d)"
cp -R "$FX/." "$TMP_EXIT8/"
node -e "
const fs=require('fs');
const p='$TMP_EXIT8/docs/config.dev.json';
const j=JSON.parse(fs.readFileSync(p,'utf8'));
j.deploy.provider='exit8-test';
fs.writeFileSync(p, JSON.stringify(j,null,2));
"
export AI_PUBLISH_DEV3_SELFTEST=1
node "$SK/run.cjs" --project="$TMP_EXIT8" --explicit-confirm --force-rerun
EC8=$?
unset AI_PUBLISH_DEV3_SELFTEST
set -e
rm -rf "$TMP_EXIT8"
if [[ "$EC8" -eq 8 ]]; then
  echo "deploy exit 8 as expected"
else
  echo "unexpected exit $EC8 (want 8)" >&2
  exit 1
fi

echo "ALL SELFTESTS PASSED"

rm -rf "$FX/tmp-bad-smoke"
if [[ -f "$SNAP" ]]; then
  cp "$SNAP" "$FX/.pipeline/stages.json"
elif git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git -C "$REPO" restore "$FX/.pipeline/stages.json" 2>/dev/null || true
fi
