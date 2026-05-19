import { DashOpenApiError, dashOpenApiErrorFromResponse } from "./errors.js";

function assertHttpsBaseUrl(baseURL: string): URL {
  const u = new URL(baseURL.endsWith("/") ? baseURL : `${baseURL}/`);
  if (u.protocol !== "https:") {
    throw new DashOpenApiError("validation", 0, "dash_base_url_must_be_https_only");
  }
  return u;
}

export interface PostIdleHeartbeatOptions {
  baseURL: string;
  bearerToken: string;
  /** 可选实例标识（不含秘密）；服务端未要求时可省略。 */
  instanceLabel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** POST `/open-api/v1/cli/heartbeat` — 空闲保活；body 保持极小且不包含密钥。 */
export async function postIdleHeartbeat(api: PostIdleHeartbeatOptions): Promise<void> {
  if (!api.bearerToken || !api.bearerToken.trim()) {
    throw new DashOpenApiError("validation", 0, "dash_bearer_missing");
  }

  const root = assertHttpsBaseUrl(api.baseURL);
  const pathJoined = `${root.pathname.replace(/\/*$/, "")}/open-api/v1/cli/heartbeat`;
  const url = new URL(pathJoined, root.origin);

  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), api.timeoutMs ?? 60_000);

  const body = api.instanceLabel?.trim()?.length ? { instance: api.instanceLabel.trim() } : {};

  try {
    const fetchFn = api.fetchImpl ?? fetch;
    const resp = await fetchFn(url.toString(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${api.bearerToken.trim()}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const buf = new Uint8Array(await resp.arrayBuffer());

    if (!resp.ok) {
      throw await dashOpenApiErrorFromResponse(resp.status, buf);
    }
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
