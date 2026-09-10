import type { AppConfig, Tokens } from "./config.js";

export const TOKEN_URL = "https://api.ouraring.com/oauth/token";
/** Upper bound on one token-endpoint call. Anything that waits on a refresh must allow for at least this. */
export const TOKEN_TIMEOUT_MS = 30_000;

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/** POST to Oura's token endpoint. Used for the initial code exchange and for refreshes. */
export async function exchangeToken(
  cfg: AppConfig,
  body: Record<string, string>,
  fetchImpl: FetchLike = fetch,
  now: () => number = Date.now,
): Promise<Tokens> {
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({ ...body, client_id: cfg.client_id, client_secret: cfg.client_secret }),
    signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Token endpoint ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = (await res.json()) as TokenResponse;
  if (!j.access_token) throw new Error("Token response had no access_token.");
  return {
    access_token: j.access_token,
    // Oura rotates refresh tokens; fall back to the one we sent only if none is returned.
    refresh_token: j.refresh_token ?? body.refresh_token ?? "",
    expires_at: new Date(now() + (j.expires_in ?? 86_400) * 1000).toISOString(),
    scope: j.scope,
    token_type: j.token_type,
  };
}
