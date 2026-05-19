import { BRIDGE_EVENTS_VERSION } from "../../feishu/contracts/bridge-events.js";
import type { ClawTransport } from "./claw-transport.js";

export interface IdleHeartbeatOptions {
  transport: ClawTransport;
  intervalMs?: number;
  log?: (line: string) => void;
}

export class FeishuIdleHeartbeat {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: IdleHeartbeatOptions) {}

  start(): void {
    this.stop();
    const ms = this.opts.intervalMs ?? 60_000;
    this.timer = setInterval(() => {
      this.opts.transport.enqueue({
        v: BRIDGE_EVENTS_VERSION,
        kind: "heartbeat",
        emitted_at: new Date().toISOString(),
        payload: { idle: true, note: "idle-heartbeat" },
      });
      this.opts.log?.(`[feishu-idle-heartbeat] ping`);
    }, ms);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
