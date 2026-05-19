import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { BRIDGE_EVENTS_VERSION } from "../../feishu/contracts/bridge-events.js";
import type { StageUpdatePayload } from "../../feishu/contracts/bridge-events.js";
import { ClawTransport } from "./claw-transport.js";
import { subscribeStagesJsonChanges } from "../runtime/pipeline-dash-reporter.js";

interface StagesJsonSnapshot {
  pipeline?: { current_stage?: string | null };
  stages?: Record<string, { status?: string }>;
}

export interface StageReporterOptions {
  projectRoot: string;
  transport: ClawTransport;
  log?: (line: string) => void;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function readStages(
  projectRoot: string,
): Promise<{ raw: StagesJsonSnapshot; text: string } | null> {
  const p = path.join(projectRoot, ".pipeline", "stages.json");
  try {
    const text = await fsp.readFile(p, "utf8");
    const raw = JSON.parse(text) as StagesJsonSnapshot;
    return { raw, text };
  } catch {
    return null;
  }
}

function readStagesSync(
  projectRoot: string,
): { raw: StagesJsonSnapshot; text: string } | null {
  const p = path.join(projectRoot, ".pipeline", "stages.json");
  try {
    const text = fs.readFileSync(p, "utf8");
    const raw = JSON.parse(text) as StagesJsonSnapshot;
    return { raw, text };
  } catch {
    return null;
  }
}

function summarizeDiff(prev: StagesJsonSnapshot | null, next: StagesJsonSnapshot): {
  messages: StageUpdatePayload[];
} {
  const messages: StageUpdatePayload[] = [];
  const prevStages = prev?.stages ?? {};
  const nextStages = next.stages ?? {};
  const names = new Set([
    ...Object.keys(prevStages),
    ...Object.keys(nextStages),
  ]);
  for (const name of names) {
    const a = prevStages[name]?.status ?? null;
    const b = nextStages[name]?.status ?? null;
    if (a !== b && b !== undefined && b !== null) {
      messages.push({
        stage_name: name,
        previous_status: a,
        next_status: b,
        pipeline_current_stage: next.pipeline?.current_stage ?? null,
        summary: `stage ${name}: ${a ?? "∅"} -> ${b}`,
      });
    }
  }

  const pc = prev?.pipeline?.current_stage ?? null;
  const nc = next.pipeline?.current_stage ?? null;
  if (pc !== nc) {
    messages.push({
      stage_name: "__pipeline__",
      previous_status: pc,
      next_status: nc ?? "∅",
      pipeline_current_stage: nc ?? null,
      summary: `pipeline.current_stage: ${pc ?? "∅"} -> ${nc ?? "∅"}`,
    });
  }

  return { messages };
}

/**
 * 监听 `.pipeline/stages.json`，去抖后异步投递 stage_update（经 ClawTransport）。
 */
export function attachFeishuStageReporter(opts: StageReporterOptions): () => void {
  const log = opts.log ?? (() => {});
  const primed = readStagesSync(opts.projectRoot);
  let last: StagesJsonSnapshot | null = primed?.raw ?? null;

  const tick = async () => {
    const snap = await readStages(opts.projectRoot);
    if (!snap) return;
    const { messages } = summarizeDiff(last, snap.raw);
    last = snap.raw;
    if (messages.length === 0) return;
    for (const payload of messages) {
      opts.transport.enqueue({
        v: BRIDGE_EVENTS_VERSION,
        kind: "stage_update",
        emitted_at: isoNow(),
        payload,
      });
      log(`[feishu-stage-reporter] queued ${payload.summary}`);
    }
  };

  const unsub = subscribeStagesJsonChanges(opts.projectRoot, () => {
    void tick();
  });
  return unsub;
}
