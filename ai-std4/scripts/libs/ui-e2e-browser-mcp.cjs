'use strict';

/**
 * Browser MCP 外置 stdio 桥接（可选）
 *
 * 配置 AI_STD4_BROWSER_MCP_CMD 为 JSON：
 *   {"command":"node","args":["path/to/mcp-server.js"]}
 *
 * cursor-ide-browser 通常仅在 Cursor IDE 内可用；流水线终端默认走 http/playwright 驱动。
 */

function parseMcpCommandEnv() {
  const raw = process.env.AI_STD4_BROWSER_MCP_CMD || '';
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.command) return parsed;
  } catch (_) {}
  return null;
}

function isMcpBridgeConfigured() {
  return parseMcpCommandEnv() != null;
}

/**
 * @returns {Promise<{ available: boolean, reason: string }>}
 */
async function probeMcpBridge() {
  const cmd = parseMcpCommandEnv();
  if (!cmd) {
    return { available: false, reason: 'AI_STD4_BROWSER_MCP_CMD 未配置' };
  }
  let sdk;
  try {
    sdk = require('@modelcontextprotocol/sdk/client/index.js');
  } catch (_) {
    return {
      available: false,
      reason: '未安装 @modelcontextprotocol/sdk（npm i @modelcontextprotocol/sdk）',
    };
  }
  void sdk;
  return {
    available: false,
    reason: 'stdio MCP 已配置但 runner 步骤映射尚未实现；请使用 playwright 或 http',
  };
}

/**
 * MCP 驱动占位：完整 JSON-RPC 步骤映射待外置 MCP 服务稳定后扩展
 */
async function runWebScenarioMcp() {
  return {
    passed: false,
    duration_ms: 0,
    error: 'MCP stdio 驱动尚未实现完整步骤映射；请使用 playwright 或 http 驱动',
    step_failed: 'mcp',
    executor: 'mcp',
  };
}

module.exports = {
  parseMcpCommandEnv,
  isMcpBridgeConfigured,
  probeMcpBridge,
  runWebScenarioMcp,
};
