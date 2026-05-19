import type { RemoteCommandEnvelope } from "../../feishu/contracts/remote-commands.js";
import { REMOTE_COMMANDS_VERSION } from "../../feishu/contracts/remote-commands.js";

export type RunMode = "query" | "create";

export interface CommandRouterHooks {
  log: (line: string) => void;
  getStatusSummary: () => Promise<string> | string;
  requestStop: (reason: string) => void | Promise<void>;
  setMode: (mode: RunMode) => void | Promise<void>;
  getMode: () => RunMode;
}

function normalize(raw: string): string {
  return raw.trim().toLowerCase();
}

function parseModeArgs(text: string): RunMode | null {
  const t = normalize(text);
  if (/\bquery\b/.test(t)) return "query";
  if (/\bcreate\b/.test(t)) return "create";
  if (t.includes("切换") && t.includes("查询")) return "query";
  if (t.includes("切换") && (t.includes("创建") || t.includes("创意")))
    return "create";
  return null;
}

export function parseRemoteText(raw: string, correlationId: string): RemoteCommandEnvelope {
  const t = normalize(raw);
  if (t === "status" || t.startsWith("status ") || t.includes("状态")) {
    return {
      v: REMOTE_COMMANDS_VERSION,
      command: "status",
      args: [],
      raw_text: raw,
      correlation_id: correlationId,
    };
  }
  if (t === "stop" || t.includes("停止") || t.includes("取消流水线")) {
    return {
      v: REMOTE_COMMANDS_VERSION,
      command: "stop",
      args: [],
      raw_text: raw,
      correlation_id: correlationId,
    };
  }
  const mode = parseModeArgs(raw);
  if (mode) {
    return {
      v: REMOTE_COMMANDS_VERSION,
      command: "mode",
      args: [mode],
      raw_text: raw,
      correlation_id: correlationId,
    };
  }
  return {
    v: REMOTE_COMMANDS_VERSION,
    command: "unknown",
    args: [],
    raw_text: raw,
    correlation_id: correlationId,
  };
}

export async function dispatchRemoteCommand(
  env: RemoteCommandEnvelope,
  hooks: CommandRouterHooks,
): Promise<void> {
  hooks.log(
    `[feishu-command-router] command=${env.command} correlation_id=${env.correlation_id}`,
  );
  switch (env.command) {
    case "status": {
      const summary = await hooks.getStatusSummary();
      hooks.log(`[feishu-command-router:status-receipt] ${summary}`);
      return;
    }
    case "stop": {
      await hooks.requestStop("remote_stop");
      return;
    }
    case "mode": {
      const prev = hooks.getMode();
      const next = env.args[0] === "create" ? "create" : "query";
      await hooks.setMode(next);
      hooks.log(
        `[feishu-command-router:mode] switched ${prev} -> ${next}`,
      );
      return;
    }
    default: {
      hooks.log(
        `[feishu-command-router:warn] unknown command raw=${JSON.stringify(env.raw_text)}`,
      );
      hooks.log(
        `[feishu-command-router:help] supported: status | stop | mode query|create`,
      );
      return;
    }
  }
}
