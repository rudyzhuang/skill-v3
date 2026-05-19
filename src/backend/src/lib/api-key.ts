export async function hashApiKey(plainKey: string): Promise<string> {
  const data = new TextEncoder().encode(plainKey);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Reads API key from Authorization: Bearer or X-API-Key. */
export function extractApiKey(
  authorization: string | undefined,
  xApiKey: string | undefined,
): string | null {
  if (xApiKey?.trim()) {
    return xApiKey.trim();
  }

  if (!authorization?.trim()) {
    return null;
  }

  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match?.[1]?.trim()) {
    return null;
  }

  return match[1].trim();
}
