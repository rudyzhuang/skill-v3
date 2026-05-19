import type { BridgeOutboundEvent } from "../../feishu/contracts/bridge-events.js";

/** 文档化：出站队列单条发送在 JS 主线程上的预算上限（毫秒） */
export const FEISHU_TRANSPORT_MAIN_THREAD_BUDGET_MS = 50;

export type BridgeTransportSender = (
  jsonLine: string,
) => Promise<void> | void;

export interface ClawTransportOptions {
  /** 自定义投递函数（HTTP loopback / 管道等）；默认打印到 bridgeLog */
  sender?: BridgeTransportSender;
  bridgeLog?: (line: string) => void;
}

/**
 * 异步背压队列：enqueue 立即返回，不在调用线程执行真实 IO。
 * 连续 flush 使用 queueMicrotask/setImmediate 避免阻塞 run-pipeline。
 */
export class ClawTransport {
  private readonly sender: BridgeTransportSender;
  private readonly bridgeLog?: (line: string) => void;
  private readonly queue: string[] = [];
  private scheduled = false;
  /** flushSoon 异步链路仍在执行时为 true */
  private flushing = false;

  constructor(opts: ClawTransportOptions = {}) {
    this.sender =
      opts.sender ??
      ((line: string) => {
        this.bridgeLog?.(`[feishu-bridge-out] ${line}`);
      });
    this.bridgeLog = opts.bridgeLog;
  }

  enqueue(event: BridgeOutboundEvent): void {
    const line = JSON.stringify(event);
    this.queue.push(line);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    const run = () => {
      this.scheduled = false;
      void this.flushSoon();
    };
    if (typeof queueMicrotask === "function") queueMicrotask(run);
    else Promise.resolve().then(run);
  }

  private async flushSoon(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.splice(0, this.queue.length);
        for (const line of batch) {
          const started = Date.now();
          try {
            await Promise.resolve(this.sender(line));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.bridgeLog?.(`[feishu-bridge-out:error] ${msg}`);
          }
          const elapsed = Date.now() - started;
          if (elapsed > FEISHU_TRANSPORT_MAIN_THREAD_BUDGET_MS) {
            this.bridgeLog?.(
              `[feishu-bridge-out:slow] sender exceeded budget ms=${elapsed}`,
            );
          }
          await new Promise<void>((resolve) =>
            typeof setImmediate === "function"
              ? setImmediate(() => resolve())
              : setTimeout(() => resolve(), 0),
          );
        }
      }
    } finally {
      this.flushing = false;
      if (this.queue.length > 0) this.scheduleFlush();
    }
  }

  /** 测试/关停：等待队列与异步 flush 结束 */
  async drainForTests(): Promise<void> {
    for (let i = 0; i < 20_000; i++) {
      if (!this.scheduled && !this.flushing && this.queue.length === 0) return;
      await new Promise((r) => setTimeout(r, 2));
    }
  }
}
