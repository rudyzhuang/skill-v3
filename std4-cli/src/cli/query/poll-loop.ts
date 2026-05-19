import process from "node:process";

import { DashOpenApiError, formatCliDashErrorLine } from "../../dash/open-api/errors.js";
import { listPendingProjects, type PendingProjectItem } from "../../dash/open-api/list-pending-projects.js";
import { postIdleHeartbeat } from "../../dash/open-api/post-idle-heartbeat.js";
import { materializeProjectForQuery } from "../workflows/project-materialize.js";
import {
  resolveRunPipelineBundle,
  spawnRunPipelineOnce,
  type ResolvedRunPipeline,
} from "./spawn-run-pipeline.js";

export type PollLoopLogger = Pick<Console, "log" | "error">;

export interface QueryPollLoopOptions {
  baseURL: string;
  bearerToken: string;
  workspaceRootAbs: string;
  cliInstallRoot: string;
  pollIntervalMs: number;
  /** 空队列时 POST 心跳的最小间隔（须 ≤ dash-std4 上限；由 CLI flag 配置）。 */
  heartbeatIdleMs: number;
  fetchImpl?: typeof fetch;
  log?: PollLoopLogger;
  instanceLabel?: string;
  focusProjectId?: string;
  anchor?: {
    projectId: string;
    projectRootAbs: string;
  };
  /** 单测注入：覆盖 bundle 解析 */
  resolveBundle?: (root: string) => ResolvedRunPipeline;
  spawnPipeline?: typeof spawnRunPipelineOnce;
  /** 单测可强制尽快退出 */
  shouldStop?: () => boolean;
  dryRunPipeline?: boolean;
}

function isAuthish(err: DashOpenApiError): boolean {
  return err.category === "auth" || err.category === "forbidden";
}

async function sleep(ms: number, shouldStop?: () => boolean): Promise<void> {
  const step = 200;
  let left = ms;
  while (left > 0) {
    if (shouldStop?.()) return;
    const chunk = Math.min(step, left);
    await new Promise((r) => setTimeout(r, chunk));
    left -= chunk;
  }
}

function filterItems(items: readonly PendingProjectItem[], focus?: string): PendingProjectItem[] {
  if (!focus?.trim().length) return [...items];
  return items.filter((it) => it.project_id === focus.trim());
}

export async function runQueryPollLoop(opts: QueryPollLoopOptions): Promise<number> {
  const log = opts.log ?? console;
  const resolveBundle = opts.resolveBundle ?? resolveRunPipelineBundle;
  const spawnPipeline = opts.spawnPipeline ?? spawnRunPipelineOnce;

  let cachedBundle: ResolvedRunPipeline | undefined;
  const getBundle = (): ResolvedRunPipeline => {
    cachedBundle ??= resolveBundle(opts.cliInstallRoot);
    return cachedBundle;
  };

  let lastHeartbeatAt = 0;

  while (!(opts.shouldStop?.() ?? false)) {
    let httpLine = "http=0";
    let pendingCount = 0;

    try {
      const items = await listPendingProjects({
        baseURL: opts.baseURL,
        bearerToken: opts.bearerToken,
        fetchImpl: opts.fetchImpl,
      });

      pendingCount = items.length;
      httpLine = "http=200";

      const filtered = filterItems(items, opts.focusProjectId);
      log.log(`[std4-cli] dash_pending_poll ${httpLine} pending_count=${pendingCount} filtered_count=${filtered.length}`);

      if (filtered.length === 0) {
        const now = Date.now();
        if (now - lastHeartbeatAt >= opts.heartbeatIdleMs) {
          await postIdleHeartbeat({
            baseURL: opts.baseURL,
            bearerToken: opts.bearerToken,
            instanceLabel: opts.instanceLabel,
            fetchImpl: opts.fetchImpl,
          });
          lastHeartbeatAt = Date.now();
          log.log(`[std4-cli] dash_cli_heartbeat_ok http=200 reason=idle_queue`);
        }

        await sleep(opts.pollIntervalMs, opts.shouldStop);
        continue;
      }

      for (const item of filtered) {
        if (opts.shouldStop?.()) break;

        const materializedAbs = await materializeProjectForQuery({
          workspaceRootAbs: opts.workspaceRootAbs,
          item,
          anchor: opts.anchor?.projectId === item.project_id ? opts.anchor : undefined,
        });

        log.log(
          `[std4-cli] query_materialized project_id=${item.project_id} path_hint=${materializedAbs.replace(/\\/g, "/")}`,
        );

        if (opts.dryRunPipeline) {
          log.log(`[std4-cli] run_pipeline_skipped dry_run=true`);
        } else {
          const bundle = getBundle();
          const code = await spawnPipeline({
            nodeExecutable: process.execPath,
            scriptPath: bundle.scriptPath,
            projectRootAbs: materializedAbs,
            env: {
              ...process.env,
              CURSOR_SKILLS_ROOT: bundle.cursorSkillsRoot,
              AI_STD4_PROJECT: materializedAbs,
            },
            extraArgs: ["--no-dash", "--no-teardown"],
          });

          log.log(`[std4-cli] run_pipeline_exit code=${code}`);

          if (code !== 0 && code !== 5) {
            log.error(`[std4-cli] error_kind=run_pipeline_nonzero code=${code} project_id=${item.project_id}`);
          }
        }
      }

      await sleep(opts.pollIntervalMs, opts.shouldStop);
    } catch (e) {
      const err =
        e instanceof DashOpenApiError ? e : new DashOpenApiError("unknown", 0, "dash_poll_unknown_failure");

      if (isAuthish(err)) {
        log.error(formatCliDashErrorLine(err));
        return 4;
      }

      log.error(formatCliDashErrorLine(err));
      await sleep(Math.min(opts.pollIntervalMs, 10_000), opts.shouldStop);
    }
  }

  log.log(`[std4-cli] query_poll_loop_stop requested=true`);
  return 0;
}
