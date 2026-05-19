const API_BASE = import.meta.env.VITE_API_BASE ?? '';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors?: string[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });

  if (!res.ok) {
    let message = res.statusText;
    let errors: string[] | undefined;
    try {
      const body = (await res.json()) as { error?: string; errors?: string[] };
      if (body.errors?.length) {
        errors = body.errors;
        message = body.errors.join('；');
      } else if (body.error) {
        message = body.error;
      }
    } catch {
      // ignore parse errors
    }
    throw new ApiError(message, res.status, errors);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return res.json() as Promise<T>;
}
