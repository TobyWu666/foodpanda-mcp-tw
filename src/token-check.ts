/**
 * Checks on a saved session token before the server uses it.
 *
 * The token file records which API host it was captured from. A token saved by
 * another region's server (say the HK build sharing ~/.foodpanda-mcp) must not
 * be sent to this region's API, and an expired token should send the user to
 * refresh_token up front instead of failing later at the cart.
 */

export interface PersistedToken {
  token: string;
  savedAt: string;
  /** API base the token was captured from, e.g. https://tw.fd-api.com. */
  region?: string;
}

/** Decode a JWT payload without verifying it. Returns null if it is not a JWT. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    let payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    while (payload.length % 4 !== 0) payload += "=";
    const decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf-8"));
    return decoded && typeof decoded === "object" ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * When the token expires, in seconds since epoch, or null if it does not say.
 * `exp` is the standard JWT claim. The TW token has no `exp` but an `expires` claim in
 * seconds (live run 2026-10-13, about an hour after login); it is used only when it reads
 * as a timestamp, so a value that might be a duration is never misread as a date.
 */
export function tokenExpiry(payload: Record<string, unknown>): number | null {
  for (const claim of ["exp", "expires"]) {
    const value = payload[claim];
    if (typeof value === "number" && Number.isFinite(value) && value >= 1e9) return value;
  }
  return null;
}

/**
 * Why this token should not be used, or null if it is fine.
 * A token without a readable expiry is accepted and left for the API to judge.
 */
export function tokenProblem(token: string, nowMs: number = Date.now()): string | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return "not a JWT";
  const expiry = tokenExpiry(payload);
  if (expiry !== null && expiry * 1000 <= nowMs) {
    return `expired at ${new Date(expiry * 1000).toISOString()}`;
  }
  return null;
}

/**
 * Why a persisted token file should not be used for `apiBase`, or null if it is fine.
 * A file without a region (written by an older build) is rejected: there is no
 * way to tell which country it belongs to.
 */
export function persistedTokenProblem(
  data: unknown,
  apiBase: string,
  nowMs: number = Date.now()
): string | null {
  if (!data || typeof data !== "object") return "unreadable token file";
  const record = data as Partial<PersistedToken>;
  if (typeof record.token !== "string" || record.token.length === 0) return "no token in file";
  if (!record.region) return "token file does not record its region";
  if (record.region.replace(/\/+$/, "") !== apiBase.replace(/\/+$/, "")) {
    return `token was saved for ${record.region}, not ${apiBase}`;
  }
  return tokenProblem(record.token, nowMs);
}
