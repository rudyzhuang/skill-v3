import * as os from "node:os";
import * as path from "node:path";

import { runClawSetup } from "./feishu/claw-setup.js";
import { FeishuBridgeProcess } from "./feishu/claw-process.js";
import { ClawTransport } from "./feishu/claw-transport.js";
import {
  attachFeishuStageReporter,
} from "./feishu/stage-reporter.js";
import { FeishuIdleHeartbeat } from "./feishu/idle-heartbeat.js";
import {
  dispatchRemoteCommand,
  parseRemoteText,
  type RunMode,
} from "./feishu/command-router.js";

export interface CliFeishuRuntime {
  transport: ClawTransport;
  bridge: FeishuBridgeProcess;
  heartbeat: FeishuIdleHeartbeat;
  detachReporter?: () => void;
}

export interface CliEntryOptions {
  installRoot?: string;
  projectRoot?: string;
  feishuEnable?: boolean;
  bridgeLog?: (line: string) => void;
}

const MODE_DEFAULT: RunMode = "query";

function defaultInstallRoot(): string {
  const base =
    process.env.FEISHU_INSTALL_ROOT ??
    path.join(os.homedir(), ".cursor", "feishu-runtime");
  return path.resolve(base);
}

export async function handleSetupFeishuCommand(
  argv: string[],
  log: (line: string) => void = console.log,
): Promise<number> {
  const idx = argv.indexOf("--install-root");
  const installRoot =
    idx >= 0 && argv[idx + 1] ? path.resolve(argv[idx + 1]) : defaultInstallRoot();
  const gitIdx = argv.indexOf("--claw-git-url");
  const clawGitUrl =
    gitIdx >= 0 && argv[gitIdx + 1] ? String(argv[gitIdx + 1]) : undefined;
  await runClawSetup({ installRoot, clawGitUrl, log });
  log(`[cli-entry] setup-feishu complete`);
  return 0;
}

/**
 * 挂载飞书桥 runtime：进程退出时需调用 bridge.stop()。
 */
export function mountFeishuRuntime(opts: CliEntryOptions): CliFeishuRuntime | null {
  if (!opts.feishuEnable) return null;
  const installRoot = opts.installRoot ?? defaultInstallRoot();
  const clawRoot = path.join(installRoot, "feishu-cursor-claw");
  const bridgeLog = opts.bridgeLog ?? ((l: string) => console.log(l));

  const transport = new ClawTransport({ bridgeLog });
  const bridge = new FeishuBridgeProcess({ clawRoot, bridgeLog });
  bridge.start();

  let detachReporter: (() => void) | undefined;
  if (opts.projectRoot) {
    detachReporter = attachFeishuStageReporter({
      projectRoot: opts.projectRoot,
      transport,
      log: bridgeLog,
    });
  }

  const heartbeat = new FeishuIdleHeartbeat({ transport, log: bridgeLog });
  heartbeat.start();

  return { transport, bridge, heartbeat, detachReporter };
}

let sharedMode: RunMode = MODE_DEFAULT;

export function getFeishuRunMode(): RunMode {
  return sharedMode;
}

export function setFeishuRunMode(mode: RunMode): void {
  sharedMode = mode;
}

/** 供宿主嵌入：处理一行飞书遥控文本 */
export async function handleInboundFeishuText(
  raw: string,
  hooks?: Partial<{
    getStatusSummary: () => Promise<string> | string;
    requestStop: (reason: string) => void | Promise<void>;
    log: (line: string) => void;
  }>,
): Promise<void> {
  const log = hooks?.log ?? ((l: string) => console.log(l));
  const env = parseRemoteText(raw, `${Date.now()}`);
  await dispatchRemoteCommand(env, {
    log,
    getStatusSummary:
      hooks?.getStatusSummary ??
      (async () =>
        JSON.stringify({
          mode: getFeishuRunMode(),
          note: "status_placeholder",
        })),
    requestStop:
      hooks?.requestStop ??
      ((reason: string) => {
        log(`[cli-entry:stop] requested reason=${reason}`);
      }),
    setMode: async (m) => {
      setFeishuRunMode(m);
    },
    getMode: () => getFeishuRunMode(),
  });
}

export async function shutdownFeishuRuntime(
  rt: CliFeishuRuntime | null | undefined,
): Promise<void> {
  rt?.detachReporter?.();
  rt?.heartbeat.stop();
  rt?.bridge.stop();
}

async function main(argv: string[]): Promise<number> {
  if (argv.includes("setup-feishu")) {
    return handleSetupFeishuCommand(argv, console.log);
  }
  console.log(
    "skill-v3 feishu helpers loaded. Use setup-feishu or embed mountFeishuRuntime().",
  );
  return 0;
}

const isDirect =
  process.argv[1]?.includes("cli-entry") ||
  process.argv[1]?.endsWith("cli-entry.ts");

if (isDirect) {
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    () => process.exit(1),
  );
}
