#!/usr/bin/env bash
# 加载 ai-soak3 skill 目录 config.env（先运行 ensure-agent-env 刷新探测结果）
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENSURE_SCRIPT="$SKILL_DIR/scripts/ensure-agent-env.cjs"
CONFIG_ENV="$SKILL_DIR/config.env"

PROJECT_ARG=()
if [[ -n "${1:-}" && "${1}" != --* ]]; then
  PROJECT_ARG=(--project="$1")
  shift
fi

if [[ ! -f "$ENSURE_SCRIPT" ]]; then
  echo "[load-soak-env] 未找到 $ENSURE_SCRIPT" >&2
  return 1 2>/dev/null || exit 1
fi

node "$ENSURE_SCRIPT" --skill-dir="$SKILL_DIR" "${PROJECT_ARG[@]}" || {
  echo "[load-soak-env] ensure-agent-env 失败" >&2
  return 3 2>/dev/null || exit 3
}

if [[ ! -f "$CONFIG_ENV" ]]; then
  echo "[load-soak-env] 缺少 $CONFIG_ENV" >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CONFIG_ENV"
set +a

unset AI_CODE3_SKIP_AGENT 2>/dev/null || true
unset AI_CODEGEN_SKIP_AGENT 2>/dev/null || true

echo "[load-soak-env] AI_CODE3_AGENT_BIN=${AI_CODE3_AGENT_BIN:-}"
echo "[load-soak-env] AI_E2E3_AGENT_BIN=${AI_E2E3_AGENT_BIN:-}"
echo "[load-soak-env] AI_SOAK3_STRICT=${AI_SOAK3_STRICT:-}"
