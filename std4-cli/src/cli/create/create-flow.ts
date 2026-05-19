import fs from "node:fs/promises";
import path from "node:path";

import { DashOpenApiError, formatCliDashErrorLine } from "../../dash/open-api/errors.js";
import type { QueryAssociateFields } from "../../dash/open-api/register-project.js";
import { registerProject } from "../../dash/open-api/register-project.js";

import type { Std4UserConfig } from "../config/load-user-config.js";
import { loadStd4UserConfigFromHome } from "../config/load-user-config.js";

import type { ScaffoldInputs } from "./project-scaffold.js";
import { writeStd4BusinessScaffold } from "./project-scaffold.js";

import { enterQueryAfterCreate } from "../query/handoff.js";

export type CreateFlowLogger = Pick<Console, "log" | "error">;

export interface CreateFlowDeps {
  log?: CreateFlowLogger;
  loadUserConfig?: () => Promise<Std4UserConfig>;
  /** 测试钩子：可选覆盖 Dash 注册请求的 fetch 行为（生产路径不得注入）。 */
  dashRegisterFetchImpl?: typeof fetch;
}

export interface CreateFlowOptions extends CreateFlowDeps {
  interactive: boolean;
  nonInteractiveFlag: boolean;
  /** Display/business project name used in req scaffold + Dash registration hint. */
  displayName?: string;

  /** Target directory absolute or relative (resolved against cwd inside flow). */
  targetPath?: string;

  /** Explicit yes/no for Dash registration; undefined means obey config heuristic. */
  registerDash?: boolean;

  repositoryUrl?: string;
  gitRef?: string;

  /** Skip invoking Query bootstrap / stderr command equivalence. */
  skipQuery?: boolean;

  cwd?: string;
}

/** Resolve config + scaffold + registration + persisted context + Query hand-off. */

export async function runCreateFlow(opts: CreateFlowOptions): Promise<number> {
  const log = opts.log ?? console;

  const cwd = opts.cwd ? path.resolve(opts.cwd) : process.cwd();

  if (opts.nonInteractiveFlag) {
    const missing: string[] = [];
    if (!opts.displayName || !opts.displayName.trim()) missing.push("--name");
    if (!opts.targetPath || !opts.targetPath.trim()) missing.push("--target");
    if (missing.length) {
      log.error(`[std4-cli] error_kind=missing_non_interactive_params missing=${missing.join(",")}`);
      return 2;
    }
  }

  const displayName = (opts.displayName ?? "").trim() || "(unnamed-project)";
  const projectRootAbs = path.resolve(cwd, (opts.targetPath ?? ".").trim() || ".");

  const loader = opts.loadUserConfig ?? loadStd4UserConfigFromHome;
  let userCfg = await loader();

  const registerChosen =
    typeof opts.registerDash === "boolean" ?
      opts.registerDash
    : Boolean(userCfg.dashStd4ApiBase?.trim()?.length && userCfg.dashStd4ApiKey?.trim()?.length);

  if (registerChosen) {
    userCfg = await loader();
    if (!userCfg.dashStd4ApiBase?.trim()) {
      log.error("[std4-cli] error_kind=dash_registration_enabled_missing_base");
      return 2;
    }
    try {
      new URL(userCfg.dashStd4ApiBase);
    } catch {
      log.error("[std4-cli] error_kind=invalid_config dash_base_url_invalid");
      return 2;
    }

    try {
      if (new URL(userCfg.dashStd4ApiBase!).protocol !== "https:") {
        log.error("[std4-cli] error_kind=config dash_base_must_be_https");
        return 2;
      }
    } catch {
      log.error("[std4-cli] error_kind=invalid_config dash_base_url_invalid");
      return 2;
    }

    if (!userCfg.dashStd4ApiKey?.trim()) {
      log.error("[std4-cli] error_kind=dash_registration_enabled_missing_api_key_file");
      return 2;
    }
  }

  const scaffoldInputs: ScaffoldInputs = { displayName, projectRoot: projectRootAbs };
  await writeStd4BusinessScaffold(scaffoldInputs);
  await fs.mkdir(path.join(projectRootAbs, ".std4-cli"), { recursive: true });

  /** Baseline Associate used when Dash registration skipped (AC3 / offline). */
  const localAssociate: QueryAssociateFields = synthesizeLocalAssociate({
    rootAbs: projectRootAbs,
    displayName,
    repositoryUrl: opts.repositoryUrl?.trim()?.length ? opts.repositoryUrl!.trim() : undefined,
    gitRef: opts.gitRef?.trim()?.length ? opts.gitRef!.trim() : undefined,
  });

  let associateEffective: QueryAssociateFields = localAssociate;

  if (registerChosen) {
    const body = buildRegisterPayload({
      displayName,
      projectRootAbs,
      repositoryUrl: opts.repositoryUrl?.trim()?.length ? opts.repositoryUrl!.trim() : undefined,
      gitRef: opts.gitRef?.trim()?.length ? opts.gitRef!.trim() : undefined,
    });

    try {
      const registration = await registerProject({
        baseURL: userCfg.dashStd4ApiBase!.trim(),
        bearerToken: userCfg.dashStd4ApiKey!.trim(),
        body,
        fetchImpl: opts.dashRegisterFetchImpl,
      });

      associateEffective = mergeAssociatesPreferServer(localAssociate, registration.associate);

      // AC1 structured stdout/log line (never secrets)
      log.log(`[std4-cli] dash_register_ok registered_project_id=${associateEffective.project_id}`);
    } catch (e) {
      const mapped =
        e instanceof DashOpenApiError ? e : new DashOpenApiError("unknown", 0, "dash_register_unknown_failure");
      log.error(formatCliDashErrorLine(mapped));
      return 3;
    }
  }

  const ctxPayload = buildPersistedProjectContext(projectRootAbs, associateEffective);
  await fs.writeFile(
    path.join(projectRootAbs, ".std4-cli", "project-context.json"),
    `${JSON.stringify(ctxPayload, null, 2)}\n`,
    "utf8",
  );

  if (!(opts.skipQuery ?? false)) {
    await enterQueryAfterCreate({
      associate: associateEffective,
      projectRootAbs,
      nonInteractive: opts.nonInteractiveFlag,
    });
  }

  log.log("[std4-cli] create_flow_completed_ok");
  return 0;
}

interface LocalAssociateSynthInput {
  rootAbs: string;
  displayName: string;
  repositoryUrl?: string;
  gitRef?: string;
}

function slugifyStable(input: string): string {
  const lower = input.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 54);
  return lower.length > 0 ? lower : "project";
}

function synthesizeLocalAssociate(inp: LocalAssociateSynthInput): QueryAssociateFields {
  const basename = path.basename(inp.rootAbs);
  const slug = slugifyStable(inp.displayName);
  const project_id = `local:${basename}:${slug}`;

  return {
    project_id,
    workspace_hint: inp.rootAbs.replace(/\\/g, "/"),
    repository_url: inp.repositoryUrl,
    git_ref: inp.gitRef,
  };
}

interface RegisterBodyInput {
  displayName: string;
  projectRootAbs: string;
  repositoryUrl?: string;
  gitRef?: string;
}

function buildRegisterPayload(inp: RegisterBodyInput): import("../../dash/open-api/register-project.js").RegisterProjectRequestBody {
  const idempotency_key = slugifyStable(`${inp.displayName}:${inp.projectRootAbs}`);

  return {
    name: inp.displayName,
    local_path_hint: inp.projectRootAbs.replace(/\\/g, "/"),
    repository_url: inp.repositoryUrl,
    git_ref: inp.gitRef,
    idempotency_key,
    metadata: {
      source: "std4-cli:create",
      workspace_basename: path.basename(inp.projectRootAbs),
    },
  };
}

function mergeAssociatesPreferServer(localBase: QueryAssociateFields, srv: QueryAssociateFields): QueryAssociateFields {
  return {
    project_id: srv.project_id ?? localBase.project_id,
    repository_url: srv.repository_url ?? localBase.repository_url,
    git_ref: srv.git_ref ?? localBase.git_ref,
    workspace_hint: srv.workspace_hint ?? localBase.workspace_hint,
  };
}

interface PersistedContextV1 {
  version: 1;
  schema: "std4.cli.project-context";
  generated_by: "std4-cli.create";
  project_root_abs: string;
  associate: QueryAssociateFields;
}

function buildPersistedProjectContext(projectRootAbs: string, assoc: QueryAssociateFields): PersistedContextV1 {
  return {
    version: 1,
    schema: "std4.cli.project-context",
    generated_by: "std4-cli.create",
    project_root_abs: path.resolve(projectRootAbs),
    associate: assoc,
  };
}

