#!/usr/bin/env node
/**
 * ensure-agent-env.cjs — 探测 cursor-agent，写入 skill 目录 config.env，并可输出 shell export。
 *
 * 用法:
 *   node ~/.cursor/skills/ai-soak3/scripts/ensure-agent-env.cjs [--skill-dir=...] [--project=...] [--force]
 *   eval "$(node ~/.cursor/skills/ai-soak3/scripts/ensure-agent-env.cjs --print-shell)"
 *
 * 退出码:
 *   0 = 已写入/更新 config.env，且探测到 AI_CODE3_AGENT_BIN
 *   1 = 参数错误
 *   3 = 未探测到 cursor-agent（strict soak 不可继续）
 */

'use strict';

const fs = require('fs');
const path = require('path');
const {
  detectCursorAgentBin,
  detectE2eAgentBin,
  shellSingleQuote,
} = require('./lib/detect-agent-bin.cjs');

const args = {};
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([^=]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
  else if (arg.startsWith('--')) args[arg.slice(2)] = true;
}

const skillDir = args['skill-dir']
  ? path.resolve(args['skill-dir'])
  : path.resolve(__dirname, '..');
const projectRoot = args.project ? path.resolve(args.project) : '';
const configEnvPath = path.join(skillDir, 'config.env');
const templatePath = path.join(skillDir, 'config.env.template');

function readJsonIfExists(p) {
  if (!p || !fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function parseEnvFile(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq <= 0) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function buildRuntimeVars(cfgDev) {
  const code3 = detectCursorAgentBin(cfgDev);
  const e2e = detectE2eAgentBin(code3);
  const vars = {
    AI_SOAK3_STRICT: '1',
    AI_CODE3_AGENT_BIN: code3,
    AI_E2E3_AGENT_BIN: e2e,
    /** soak 下 codegen 整阶段最短秒数（autorun 子进程墙钟） */
    AI_SOAK3_CODEGEN_MIN_S: process.env.AI_SOAK3_CODEGEN_MIN_S || '7200',
    /** 每个 feature 额外预算秒数（与 feature 数相乘后与 MIN 取 max） */
    AI_SOAK3_CODEGEN_PER_FEATURE_S: process.env.AI_SOAK3_CODEGEN_PER_FEATURE_S || '600',
    /** soak 下 ui_e2e 整阶段最短秒数（含 web agent + 双端 mobile 安装冒烟） */
    AI_SOAK3_UI_E2E_MIN_S: process.env.AI_SOAK3_UI_E2E_MIN_S || '10800',
    /** 每个 UI 场景额外预算秒数（与场景数相乘后与 MIN 取 max） */
    AI_SOAK3_UI_E2E_PER_SCENARIO_S: process.env.AI_SOAK3_UI_E2E_PER_SCENARIO_S || '600',
    AI_CODE3_MERGE_AUTO_THEIRS: '1',
    AI_CODE3_MERGE_CONFIRM: 'yes',
    http_proxy: process.env.http_proxy || 'http://127.0.0.1:1087',
    https_proxy: process.env.https_proxy || 'http://127.0.0.1:1087',
  };
  return { vars, code3, e2e };
}

function formatConfigEnv(vars, meta) {
  const lines = [
    '# ai-soak3 本地运行时环境（由 ensure-agent-env.cjs 自动生成，可手工覆盖）',
    `# ${meta}`,
    '# 加载: eval "$(node scripts/ensure-agent-env.cjs --print-shell)"',
    '# 或: source ~/.cursor/skills/ai-soak3/scripts/load-soak-env.sh',
    '',
  ];
  for (const [k, v] of Object.entries(vars)) {
    if (v === '' || v == null) {
      lines.push(`# ${k}=`);
      continue;
    }
    lines.push(`${k}=${v}`);
  }
  lines.push('');
  return lines.join('\n');
}

function applyToProcessEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === '' || v == null) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  delete process.env.AI_CODE3_SKIP_AGENT;
  delete process.env.AI_CODEGEN_SKIP_AGENT;
}

function printShellExports(vars) {
  const keys = [
    'AI_SOAK3_STRICT',
    'AI_CODE3_AGENT_BIN',
    'AI_E2E3_AGENT_BIN',
    'AI_SOAK3_CODEGEN_MIN_S',
    'AI_SOAK3_CODEGEN_PER_FEATURE_S',
    'AI_SOAK3_UI_E2E_MIN_S',
    'AI_SOAK3_UI_E2E_PER_SCENARIO_S',
    'AI_CODE3_MERGE_AUTO_THEIRS',
    'AI_CODE3_MERGE_CONFIRM',
    'http_proxy',
    'https_proxy',
  ];
  for (const k of keys) {
    const v = vars[k];
    if (v === '' || v == null) continue;
    process.stdout.write(`export ${k}=${shellSingleQuote(v)}\n`);
  }
  process.stdout.write('unset AI_CODE3_SKIP_AGENT 2>/dev/null || true\n');
  process.stdout.write('unset AI_CODEGEN_SKIP_AGENT 2>/dev/null || true\n');
}

function uiE2eEnabled(cfgDev) {
  return !!(cfgDev && cfgDev.ui_e2e && cfgDev.ui_e2e.enabled === true);
}

function main() {
  const cfgDev = projectRoot
    ? readJsonIfExists(path.join(projectRoot, 'docs', 'config.dev.json'))
    : null;
  const { vars, code3, e2e } = buildRuntimeVars(cfgDev);

  if (args['print-shell']) {
    if (!code3) {
      console.error('[ensure-agent-env] 未探测到 cursor-agent，无法 --print-shell');
      process.exit(3);
    }
    printShellExports(vars);
    process.exit(0);
  }

  if (!fs.existsSync(templatePath)) {
    fs.writeFileSync(
      templatePath,
      [
        '# 复制为 config.env 或由 ensure-agent-env.cjs 自动生成',
        'AI_SOAK3_STRICT=1',
        'AI_CODE3_AGENT_BIN=',
        'AI_E2E3_AGENT_BIN=',
        'http_proxy=http://127.0.0.1:1087',
        'https_proxy=http://127.0.0.1:1087',
        '',
      ].join('\n'),
      'utf8'
    );
  }

  let merged = vars;
  if (!args.force && fs.existsSync(configEnvPath)) {
    const existing = parseEnvFile(fs.readFileSync(configEnvPath, 'utf8'));
    merged = { ...vars };
    for (const k of ['AI_CODE3_AGENT_BIN', 'AI_E2E3_AGENT_BIN']) {
      if (existing[k] && fs.existsSync(existing[k])) {
        merged[k] = existing[k];
      }
    }
    if (!merged.AI_E2E3_AGENT_BIN && merged.AI_CODE3_AGENT_BIN) {
      merged.AI_E2E3_AGENT_BIN = merged.AI_CODE3_AGENT_BIN;
    }
  }

  const meta = `updated_at=${new Date().toISOString()} detected_code3=${code3 || 'none'}`;
  fs.writeFileSync(configEnvPath, formatConfigEnv(merged, meta), 'utf8');
  applyToProcessEnv(merged);

  console.log(`[ensure-agent-env] 已写入 ${configEnvPath}`);
  console.log(`[ensure-agent-env] AI_CODE3_AGENT_BIN=${merged.AI_CODE3_AGENT_BIN || '(未探测到)'}`);
  console.log(`[ensure-agent-env] AI_E2E3_AGENT_BIN=${merged.AI_E2E3_AGENT_BIN || '(未探测到)'}`);

  if (projectRoot && uiE2eEnabled(cfgDev) && !merged.AI_E2E3_AGENT_BIN) {
    console.error('[ensure-agent-env] 警告: ui_e2e.enabled=true 但未配置 E2E Agent');
  }

  if (!merged.AI_CODE3_AGENT_BIN) {
    console.error(
      '[ensure-agent-env] 未找到 cursor-agent。请安装 Cursor Agent CLI 或设置 AI_CODE3_AGENT_BIN。'
    );
    process.exit(3);
  }

  process.exit(0);
}

main();
