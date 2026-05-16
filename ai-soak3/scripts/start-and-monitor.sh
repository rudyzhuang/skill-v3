#!/usr/bin/env bash
# start-and-monitor.sh  —  ai-soak3 辅助脚本
# 规范真源：~/.cursor/skills/ai-soak3/docs/spec/soak3.md §7.4
#
# 启动 autorun 并持续监控 codegen 会话健康状态；
# 检测到卡住后自动停止 autorun 并输出诊断，由 agent 介入修复。
#
# 用法:
#   bash ~/.cursor/skills/ai-soak3/scripts/start-and-monitor.sh \
#        <PROJECT_ROOT> [CHECK_INTERVAL_SEC] [STUCK_MIN]
#
# 参数:
#   PROJECT_ROOT        业务项目根目录（必填）
#   CHECK_INTERVAL_SEC  每隔多少秒检查一次（默认: 180，即 3 分钟）
#   STUCK_MIN           卡住阈值（分钟，默认: 15）
#
# 退出码:
#   0 = autorun 成功完成
#   1 = autorun 失败（非卡住）
#   2 = 检测到卡住，autorun 已被强制停止，需要 agent 介入

set -euo pipefail

PROJECT_ROOT="${1:?必须提供 PROJECT_ROOT 参数}"
CHECK_INTERVAL="${2:-180}"
STUCK_MIN="${3:-15}"

# 从脚本自身位置推导 skill 目录（不依赖 PROJECT_ROOT）
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
SKILL_DIR="$(cd "$SKILL_DIR" && pwd)"

AUTORUN_SCRIPT="$HOME/.cursor/skills/ai-auto3/scripts/autorun.cjs"
HEALTH_SCRIPT="$SKILL_DIR/scripts/check-session-health.cjs"
DIAGNOSE_SCRIPT="$SKILL_DIR/scripts/diagnose-run.cjs"

# ──────────────────── 代理检查 ─────────────────────────────────
if [[ -z "${http_proxy:-}" ]]; then
  echo "[monitor] ⚠️  http_proxy 未设置，外网命令可能失败。"
  echo "[monitor]    建议先: export http_proxy=http://127.0.0.1:1087 https_proxy=http://127.0.0.1:1087"
fi

# ──────────────────── 脚本存在性检查 ──────────────────────────
if [[ ! -f "$AUTORUN_SCRIPT" ]]; then
  echo "[monitor] ❌ 未找到 autorun 脚本: $AUTORUN_SCRIPT"
  exit 1
fi

if [[ ! -f "$HEALTH_SCRIPT" ]]; then
  echo "[monitor] ❌ 未找到健康检查脚本: $HEALTH_SCRIPT"
  exit 1
fi

if [[ ! -f "$DIAGNOSE_SCRIPT" ]]; then
  echo "[monitor] ❌ 未找到诊断脚本: $DIAGNOSE_SCRIPT"
  exit 1
fi

# ──────────────────── 启动 autorun ────────────────────────────
echo "[monitor] ============================================"
echo "[monitor] 启动 autorun"
echo "[monitor]   项目:           $PROJECT_ROOT"
echo "[monitor]   skill 目录:     $SKILL_DIR"
echo "[monitor]   健康检查间隔:   ${CHECK_INTERVAL}s"
echo "[monitor]   卡住阈值:       ${STUCK_MIN}min"
echo "[monitor] ============================================"

node "$AUTORUN_SCRIPT" --project="$PROJECT_ROOT" &
AUTORUN_PID=$!
echo "[monitor] autorun 已启动，PID=$AUTORUN_PID"
echo ""

STUCK_DETECTED=0

# ──────────────────── 监控循环 ────────────────────────────────
while kill -0 "$AUTORUN_PID" 2>/dev/null; do
  sleep "$CHECK_INTERVAL"

  if ! kill -0 "$AUTORUN_PID" 2>/dev/null; then
    break
  fi

  echo ""
  echo "[monitor] $(date -u '+%Y-%m-%dT%H:%M:%SZ') 执行健康检查..."

  HEALTH_EXIT=0
  node "$HEALTH_SCRIPT" \
    --project="$PROJECT_ROOT" \
    --stuck-min="$STUCK_MIN" || HEALTH_EXIT=$?

  if [[ "$HEALTH_EXIT" -eq 2 ]]; then
    echo ""
    echo "[monitor] ⚠️  ============================================"
    echo "[monitor] ⚠️  检测到卡住的 codegen 会话！"
    echo "[monitor] ⚠️  正在停止 autorun (PID=$AUTORUN_PID)..."
    echo "[monitor] ⚠️  ============================================"

    kill "$AUTORUN_PID" 2>/dev/null || true
    sleep 3
    kill -9 "$AUTORUN_PID" 2>/dev/null || true

    STUCK_DETECTED=1
    break
  fi
done

# ──────────────────── 获取退出码 ──────────────────────────────
AUTORUN_EXIT=0
wait "$AUTORUN_PID" 2>/dev/null || AUTORUN_EXIT=$?

echo ""
echo "[monitor] ============================================"
echo "[monitor] autorun 结束，退出码: $AUTORUN_EXIT"
echo "[monitor] ============================================"

# ──────────────────── 结果处理 ────────────────────────────────
if [[ "$STUCK_DETECTED" -eq 1 ]]; then
  echo ""
  echo "[monitor] 运行诊断分析..."
  node "$DIAGNOSE_SCRIPT" --project="$PROJECT_ROOT" || true
  echo ""
  echo "[monitor] ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★"
  echo "[monitor] ★  autorun 因卡住被停止，需要 agent 介入！  ★"
  echo "[monitor] ★                                             ★"
  echo "[monitor] ★  请 agent 执行以下操作:                     ★"
  echo "[monitor] ★    1. 阅读上方诊断输出，归因 skill 问题      ★"
  echo "[monitor] ★    2. 修复 ~/.cursor/skills/ 对应 skill      ★"
  echo "[monitor] ★    3. smoke 2 轮 → commit+push              ★"
  echo "[monitor] ★    4. 重新从 §4.A 开始 Round N+1            ★"
  echo "[monitor] ★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★★"
  exit 2
elif [[ "$AUTORUN_EXIT" -ne 0 ]]; then
  echo ""
  echo "[monitor] ❌ autorun 失败（退出码 $AUTORUN_EXIT），运行诊断..."
  node "$DIAGNOSE_SCRIPT" --project="$PROJECT_ROOT" || true
  echo ""
  echo "[monitor] 请 agent 按 §2.2 流程处理失败：归因 skill → 修复 → Round N+1"
  exit 1
else
  echo ""
  echo "[monitor] ✓ autorun 成功完成！"
  echo "[monitor] echo \"autorun exit: 0\""
  exit 0
fi
