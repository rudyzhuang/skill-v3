import { DashOpenApiError, dashOpenApiErrorFromResponse } from "./errors.js";

function assertHttpsBaseUrl(baseURL: string): URL {
  const u = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
  if (u.protocol !== "https:") {
    throw new DashOpenApiError("validation", 0, "dash_base_url_must_be_https_only");
  }
  return u;
}

export interface PendingProjectItem {
  project_id: string;
  repository_url?: string;
  git_ref?: string;
  workspace_hint?: string;
  raw: unknown;
}

export interface ListPendingProjectsOptions {
  baseURL: string;
  bearerToken: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

function pickString(obj: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

function normalizePendingItem(obj: Record<string, unknown>): PendingProjectItem {
  const id = pickString(obj, ["project_id", "projectId", "id"]);
  if (!id?.length) {
    throw new DashOpenApiError("validation", 200, "pending_item_missing_stable_project_id");
  }

  return {
    project_id: id,
    repository_url: pickString(obj, ["repository_url", "repo_url", "git_url", "remote_url"]),
    git_ref: pickString(obj, ["git_ref", "ref", "branch", "default_branch"]),
    workspace_hint: pickString(obj, ["workspace_hint", "workspace_path_hint", "path_hint"]),
    raw: obj,
  };
}

function parsePendingList(json: unknown): PendingProjectItem[] {
  if (Array.isArray(json)) {
    const out: PendingProjectItem[] = [];
    for (const it of json) {
      if (typeof it === "object" && it !== null) {
        out.push(normalizePendingItem(it as Record<string, unknown>));
      }
    }
    return out;
  }

  const root = typeof json === "object" && json !== null ? (json as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : undefined;

  const rawItems =
    Array.isArray(root.items) ? root.items
    : Array.isArray(root.projects) ? root.projects
    : data && Array.isArray(data.items) ? data.items
    : data && Array.isArray(data.projects) ? data.projects
    : [];

  const out: PendingProjectItem[] = [];
  for (const it of rawItems) {
    if (typeof it === "object" && it !== null) {
      out.push(normalizePendingItem(it as Record<string, unknown>));
    }
  }
  return out;
}

/** GET `/open-api/v1/projects/pending` — 200 + JSON 列表（可空）。 */
export async function listPendingProjects(api: ListPendingProjectsOptions): Promise<PendingProjectItem[]> {
  if (!api.bearerToken || !api.bearerToken.trim()) {
    throw new DashOpenApiError("validation", 0, "dash_bearer_missing");
  }

  const root = assertHttpsBaseUrl(api.baseURL);
  const pathJoined = `${root.pathname.replace(/\/*$/, "")}/open-api/v1/projects/pending`;
  const url = new URL(pathJoined, root.origin);

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), api.timeoutMs ?? 60_000);

  try {
    const fetchFn = api.fetchImpl ?? fetch;
    const resp = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${api.bearerToken.trim()}`,
      },
      signal: ctl.signal,
    });

    const buf = new Uint8Array(await resp.arrayBuffer());

    if (!resp.ok) {
      throw await dashOpenApiErrorFromResponse(resp.status, buf);
    }

    let parsedJson: unknown;
    try {
      const textStr = new TextDecoder().decode(buf);
      parsedJson = textStr.trim().length ? JSON.parse(textStr) : [];
    } catch {
      parsedJson = [];
    }

    return parsePendingList(parsedJson);
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
