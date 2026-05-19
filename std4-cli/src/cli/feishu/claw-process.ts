import { spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

export interface FeishuBridgeProcessOptions {
  clawRoot: string;
  /** bun 可执行；默认 'bun' */
  bunBin?: string;
  maxAutoRestarts?: number;
  bridgeLog?: (line: string) => void;
  /** 关闭自动重启（验收对比用） */
  disableAutoRestart?: boolean;
}

const SECRET_PATTERNS: Array<{ name: string; re: RegExp }> = [
  {
    name: "feishu_app_secret_kv",
    re: /(?:FEISHU_APP_SECRET|APP_SECRET)\s*=\s*\S+/gi,
  },
  {
    name: "bearer",
    re: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  },
  {
    name: "tenant_token_json",
    re: /"tenant_access_token"\s*:\s*"[^"]+"/gi,
  },
];

export function redactBridgeLogLine(line: string): string {
  let out = line;
  for (const { re } of SECRET_PATTERNS) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

export class FeishuBridgeProcess {
  private proc: ChildProcess | null = null;
  private restarts = 0;
  private stopping = false;

  constructor(private readonly opts: FeishuBridgeProcessOptions) {}

  start(): void {
    this.stopping = false;
    this.spawnOnce();
  }

  private spawnOnce(): void {
    const bun = this.opts.bunBin ?? "bun";
    const cwd = path.resolve(this.opts.clawRoot);
    const bridgeLog = this.opts.bridgeLog ?? (() => {});

    bridgeLog(`[feishu-bridge] spawning bun run server.ts cwd=${cwd}`);
    const child = spawn(bun, ["run", "server.ts"], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    }) as ChildProcess;
    this.proc = child;

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      bridgeLog(`[feishu-bridge:error] missing stdio pipes`);
      return;
    }

    const onChunk = (buf: Buffer, stream: "stdout" | "stderr") => {
      const text = buf.toString("utf8");
      for (const raw of text.split(/\r?\n/)) {
        if (!raw.trim()) continue;
        bridgeLog(`[feishu-bridge:${stream}] ${redactBridgeLogLine(raw)}`);
      }
    };

    stdout.on("data", (b) => onChunk(b, "stdout"));
    stderr.on("data", (b) => onChunk(b, "stderr"));

    child.on("error", (err) => {
      bridgeLog(
        `[feishu-bridge:error] spawn ${err instanceof Error ? err.message : String(err)}`,
      );
    });

    child.on("exit", (code, signal) => {
      bridgeLog(
        `[feishu-bridge:exit] code=${code ?? "null"} signal=${signal ?? "null"}`,
      );
      if (this.stopping) return;
      const max = this.opts.maxAutoRestarts ?? 3;
      if (!this.opts.disableAutoRestart && this.restarts < max) {
        this.restarts += 1;
        bridgeLog(`[feishu-bridge:restart] attempt=${this.restarts}/${max}`);
        setTimeout(() => this.spawnOnce(), 500 * this.restarts);
      }
    });
  }

  stop(): void {
    this.stopping = true;
    if (!this.proc) return;
    try {
      this.proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    this.proc = null;
  }
}
