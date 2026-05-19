/** Maps Dash Open API HTTP + JSON envelopes to typed errors without leaking secrets. */

export type DashOpenApiErrorCategory =
  | "validation"
  | "conflict"
  | "auth"
  | "forbidden"
  | "rate_limit"
  | "server"
  | "network"
  | "unknown";

export class DashOpenApiError extends Error {
  readonly category: DashOpenApiErrorCategory;
  readonly status: number;

  readonly bodySnippet?: string;
  /** Parsed server-provided stable code string when present. */
  readonly serverCode?: string;

  constructor(
    category: DashOpenApiErrorCategory,
    status: number,
    message: string,
    options?: {
      /** Short, redacted excerpt for diagnostics (already stripped of bearer-like fragments). */
      bodySnippet?: string;
      serverCode?: string;
    },
  ) {
    super(message);
    this.name = "DashOpenApiError";
    this.category = category;
    this.status = status;
    this.bodySnippet = options?.bodySnippet;
    this.serverCode = options?.serverCode;
  }
}

/** Remove patterns that resemble tokens from free-text snippets. */
export function redactLikelySecrets(text: string): string {
  return text
    .replace(/Bearer\s+[\w._~+/=-]+/gi, "Bearer <redacted>")
    .replace(/\b[Dd]ASH[_\x2D]?STD4[_\x2D]?API[_\x2D]?KEY\s*=\s*\S+/g, "DASH_STD4_API_KEY=<redacted>")
    .replace(/\bAuthorization\s*:\s*[^\n]+/gi, "Authorization: <redacted>");
}

/** Log-friendly line describing error category without stack or secrets. */
export function formatCliDashErrorLine(err: DashOpenApiError): string {
  const code = err.serverCode ? ` code=${err.serverCode}` : "";
  return `[dash_open_api_error] category=${err.category} http=${err.status}${code} message=${err.message}`;
}

function categoryFromHttpStatus(status: number): DashOpenApiErrorCategory {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 409) return "conflict";
  if (status === 422 || status === 400) return "validation";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "server";
  return "unknown";
}

interface ParsedEnvelope {
  message: string;
  serverCode?: string;
}

/** Best-effort parse of Dash-style JSON error payloads; never throws. */
function parseErrorEnvelope(raw: unknown): ParsedEnvelope | undefined {
  if (raw === null || raw === undefined) return undefined;

  try {
    if (typeof raw === "string") {
      const trimmed = raw.slice(0, 512);
      return { message: redactLikelySecrets(trimmed) };
    }

    const obj = typeof raw === "object" ? (raw as Record<string, unknown>) : undefined;
    if (!obj) return undefined;

    const err = typeof obj.error === "object" && obj.error !== null ? (obj.error as Record<string, unknown>) : undefined;
    const topCode = typeof obj.code === "string" ? obj.code : undefined;
    const nestedCode =
      typeof err?.code === "string"
        ? (err.code as string)
        : typeof err?.type === "string"
          ? (err.type as string)
          : topCode;

    const msgCandidates = [
      typeof err?.message === "string" ? (err.message as string) : undefined,
      typeof obj.message === "string" ? (obj.message as string) : undefined,
      typeof obj.detail === "string" ? (obj.detail as string) : undefined,
      Array.isArray(obj.errors)
        ? (obj.errors as unknown[])
            .map((e) => (typeof e === "object" && e && "message" in e ? String((e as Record<string, unknown>).message) : ""))
            .filter(Boolean)
            .slice(0, 3)
            .join("; ")
        : undefined,
    ].filter((s): s is string => !!s?.length);

    const rawMessage = msgCandidates[0] ?? "dash_open_api_request_failed";

    return { message: redactLikelySecrets(rawMessage.slice(0, 512)), serverCode: nestedCode };
  } catch {
    return { message: "dash_open_api_request_failed_parse" };
  }
}

export async function dashOpenApiErrorFromResponse(
  status: number,
  bodyBytes: Uint8Array,
): Promise<DashOpenApiError> {
  let textStr = "";
  try {
    const dec = new TextDecoder();
    textStr = dec.decode(bodyBytes).slice(0, 8192);
  } catch {
    textStr = "";
  }

  let jsonParsed: unknown;
  try {
    jsonParsed = textStr.trim().length ? JSON.parse(textStr) : undefined;
  } catch {
    jsonParsed = undefined;
  }

  const env =
    typeof jsonParsed === "object"
      ? parseErrorEnvelope(jsonParsed)
      : textStr.trim().length
        ? parseErrorEnvelope(textStr)
        : undefined;

  const baselineCategory = categoryFromHttpStatus(status);
  const normalizedMessage = env?.message && env.message.trim().length > 0 ? env.message.trim() : "dash_open_api_request_failed";

  return new DashOpenApiError(baselineCategory, status, normalizedMessage, {
    bodySnippet: redactLikelySecrets(textStr.slice(0, 256)),
    serverCode: env?.serverCode,
  });
}
