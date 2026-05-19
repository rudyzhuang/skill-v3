import { DashOpenApiError, dashOpenApiErrorFromResponse, redactLikelySecrets } from "./errors.js";

function assertHttpsBaseUrl(baseURL: string): URL {
  const u = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
  if (u.protocol !== "https:") {
    throw new DashOpenApiError("validation", 0, "dash_base_url_must_be_https_only");
  }
  return u;
}

export interface RegisterProjectRequestBody {
  name?: string;
  /** Local scaffold path hint (posix-style relative label for dashboards). */
  local_path_hint?: string;
  /** Explicit idempotency key when server documents support. */
  idempotency_key?: string;
  /** Repo URL from scaffold / user intent for Query materialize. */
  repository_url?: string;
  git_ref?: string;
  /** Extension bag for forwards-compatible fields. */
  metadata?: Record<string, string | number | boolean | undefined>;
}

/** Fields needed by Query materialize (PRD-aligned; server may omit and caller may fill defaults). */
export interface QueryAssociateFields {
  project_id: string;
  repository_url?: string;
  git_ref?: string;
  workspace_hint?: string;
}

/** Successful registration payload parsed from permissive Dash JSON shapes. */
export interface RegisterProjectResult {
  associate: QueryAssociateFields;
  raw: unknown;
}

function pickStableProjectId(parsed: Record<string, unknown>): string | undefined {
  const data = parsed.data && typeof parsed.data === "object" ? (parsed.data as Record<string, unknown>) : undefined;
  const candidates = [
    typeof parsed.project_id === "string" ? (parsed.project_id as string) : undefined,
    typeof parsed.id === "string" ? (parsed.id as string) : undefined,
    typeof parsed.projectId === "string" ? (parsed.projectId as string) : undefined,
    typeof data?.project_id === "string" ? (data.project_id as string) : undefined,
    typeof data?.id === "string" ? (data.id as string) : undefined,
  ];
  const hit = candidates.find((x) => x !== undefined && x.trim().length > 0);
  return hit?.trim();
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  const bag = obj.data && typeof obj.data === "object" ? ({ ...obj, ...(obj.data as object) } as Record<string, unknown>) : obj;
  for (const k of keys) {
    const v = bag[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

export function normalizeRegisterSuccess(json: unknown): RegisterProjectResult {
  const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};

  const id = pickStableProjectId(root);
  if (!id) {
    throw new DashOpenApiError("unknown", 200, "register_response_missing_stable_project_id");
  }

  const repository_url =
    pickString(root, "repository_url", "repo_url", "git_url", "remote_url") ??
    undefined;
  const git_ref =
    pickString(root, "git_ref", "ref", "branch", "default_branch") ??
    undefined;
  const workspace_hint = pickString(root, "workspace_hint", "workspace_path_hint", "path_hint");

  const associate: QueryAssociateFields = {
    project_id: id,
    repository_url,
    git_ref,
    workspace_hint,
  };

  return { associate, raw: json };
}

export interface RegisterProjectOptions {
  baseURL: string;
  bearerToken: string;
  /** Optional override for tests — defaults to fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  body?: RegisterProjectRequestBody;
}

/** POST `/open-api/v1/projects` with Bearer auth over HTTPS-only base URL. */
export async function registerProject(api: RegisterProjectOptions): Promise<RegisterProjectResult> {
  if (!api.bearerToken || !api.bearerToken.trim()) {
    throw new DashOpenApiError("validation", 0, "dash_bearer_missing");
  }

  const root = assertHttpsBaseUrl(api.baseURL);
  const pathJoined = `${root.pathname.replace(/\/*$/, "")}/open-api/v1/projects`;
  const url = new URL(pathJoined, root.origin);

  const bodyJson = api.body ?? {};
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), api.timeoutMs ?? 60_000);

  try {
    const fetchFn = api.fetchImpl ?? fetch;
    const resp = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${api.bearerToken.trim()}`,
      },
      body: JSON.stringify(bodyJson),
      signal: ctl.signal,
    });

    const buf = new Uint8Array(await resp.arrayBuffer());

    if (!resp.ok) {
      const err = await dashOpenApiErrorFromResponse(resp.status, buf);
      void redactLikelySecrets;
      throw err;
    }

    let parsedJson: unknown;
    try {
      const textStr = new TextDecoder().decode(buf);
      parsedJson = textStr.trim().length ? JSON.parse(textStr) : {};
    } catch {
      parsedJson = {};
    }

    return normalizeRegisterSuccess(parsedJson);
  } catch (e) {
    if (e instanceof DashOpenApiError) throw e;

    const name = (e as { name?: string } | undefined)?.name;
    if (name === "AbortError") {
      throw new DashOpenApiError("network", 0, "dash_open_api_timeout");
    }
    throw new DashOpenApiError("network", 0, "dash_open_api_network_failure");
  } finally {
    clearTimeout(timeout);
  }
}
