'use strict';

/**
 * 统一 Cursor SDK Agent 调用（CURSOR_API_KEY + @cursor/sdk）
 */

const fs   = require('fs');
const path = require('path');
const { getCursorApiKey, resolvePipelineModel } = require('./pipeline-config.cjs');

/**
 * 从 assistant 文本中提取第一个 JSON 对象（兜底）
 * @param {string} text
 */
function extractJsonObject(text) {
  if (!text) return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * @param {object} opts
 * @param {string} opts.skillsRoot
 * @param {string} opts.projectRoot
 * @param {string} opts.promptFile - 相对 ai-std4/prompts/
 * @param {string} opts.agentId
 * @param {string} [opts.cwd]
 * @param {string} [opts.model]
 * @param {number} opts.timeoutMs
 * @param {object} opts.log - logger
 * @param {Record<string,string>} [opts.inject] - 注入 prompt 的键值
 * @param {string} [opts.artifactPath] - 期望 Agent 写入的 JSON 文件（绝对路径）
 * @param {string} [opts.extraPrompt] - 追加在 prompt 末尾的说明
 * @returns {Promise<{success:boolean,timedOut:boolean,error:string|null,agentRunId:string|null,artifact:object|null}>}
 */
async function invokeSdkAgent(opts) {
  const {
    skillsRoot,
    projectRoot,
    promptFile,
    agentId,
    cwd = projectRoot,
    model,
    timeoutMs,
    log,
    inject = {},
    artifactPath = null,
    extraPrompt = '',
  } = opts;

  const promptPath = path.join(skillsRoot, 'ai-std4', 'prompts', promptFile);
  if (!fs.existsSync(promptPath)) {
    return {
      success: false, timedOut: false,
      error: `Prompt not found: ${promptPath}`,
      agentRunId: null, artifact: null,
    };
  }

  let promptContent = fs.readFileSync(promptPath, 'utf8');
  const injectLines = Object.entries(inject)
    .map(([k, v]) => `\n<!-- inject: ${k}=${v} -->`)
    .join('');
  if (artifactPath) {
    promptContent += `\n<!-- inject: artifact_path=${artifactPath} -->`;
    promptContent += `\n<!-- inject: project_root=${projectRoot} -->`;
    promptContent += `\n\n**必须**将符合 schema 的 JSON 写入上述 artifact_path 文件。`;
  }
  const finalPrompt = promptContent + injectLines + (extraPrompt ? `\n\n${extraPrompt}` : '');

  const apiKey = getCursorApiKey();
  if (!apiKey) {
    return {
      success: false, timedOut: false,
      error: 'CURSOR_API_KEY not set — 请在 inputs/config.env 填写并运行 setup',
      agentRunId: null, artifact: null,
    };
  }

  const modelId = model || resolvePipelineModel();

  log.info('agent_start', `启动 SDK Agent: ${agentId}`, {
    agent_id: agentId,
    prompt:   promptFile,
    model:    modelId,
  });

  let agentRunId = null;
  let assistantText = '';

  try {
    const { Agent } = require('@cursor/sdk');
    const runPromise = (async () => {
      const agent = await Agent.create({
        apiKey,
        model: { id: modelId },
        local: { cwd },
      });
      try {
        const run = await agent.send(finalPrompt);
        agentRunId = run.id || null;
        if (run.supports && run.supports('stream')) {
          for await (const event of run.stream()) {
            if (event.type === 'assistant') {
              for (const block of (event.message && event.message.content) || []) {
                if (block.type === 'text') {
                  assistantText += block.text;
                  process.stdout.write(block.text);
                }
              }
            }
          }
        }
        const result = await run.wait();
        return {
          success: result.status === 'finished',
          error:   result.status !== 'finished' ? `Agent status: ${result.status}` : null,
        };
      } finally {
        if (typeof agent[Symbol.asyncDispose] === 'function') {
          await agent[Symbol.asyncDispose]();
        }
      }
    })();

    const timeoutPromise = new Promise(resolve =>
      setTimeout(() => resolve({ timedOut: true }), timeoutMs)
    );
    const outcome = await Promise.race([runPromise, timeoutPromise]);

    if (outcome.timedOut) {
      log.error('agent_failed', `Agent 超时 ${timeoutMs}ms`, { agent_id: agentId });
      return {
        success: false, timedOut: true,
        error: `Agent timeout after ${timeoutMs}ms`,
        agentRunId, artifact: null,
      };
    }

    let artifact = null;
    if (artifactPath && fs.existsSync(artifactPath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        artifact = raw.recovery && raw.recovery.decision ? raw.recovery : raw;
      } catch (e) {
        return {
          success: false, timedOut: false,
          error: `artifact JSON 解析失败: ${e.message}`,
          agentRunId, artifact: null,
        };
      }
    } else if (artifactPath) {
      artifact = extractJsonObject(assistantText);
      if (artifact && artifact.recovery) artifact = artifact.recovery;
    }

    log.info('agent_complete', `SDK Agent 结束: ${agentId}`, {
      agent_id:     agentId,
      success:      outcome.success,
      has_artifact: !!artifact,
    });

    return {
      success:    outcome.success && (!artifactPath || !!artifact),
      timedOut:   false,
      error:      outcome.error || (!artifact && artifactPath ? '未产出 artifact JSON' : null),
      agentRunId,
      artifact,
    };
  } catch (err) {
    const errMsg = err && err.message ? err.message : String(err);
    log.error('agent_failed', errMsg, { agent_id: agentId });
    return {
      success: false, timedOut: false, error: errMsg,
      agentRunId, artifact: null,
    };
  }
}

module.exports = { invokeSdkAgent, extractJsonObject };
