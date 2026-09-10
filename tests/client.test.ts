import { test } from "node:test";
import assert from "node:assert/strict";
import { OuraClient } from "../src/client.js";
import type { AppConfig, Tokens } from "../src/config.js";

const cfg: AppConfig = { client_id: "id", client_secret: "secret", redirect_uri: "https://127.0.0.1:3000/callback", scopes: "daily" };
const future = new Date(Date.now() + 3_600_000).toISOString();
const tokens = (): Tokens => ({ access_token: "A1", refresh_token: "R1", expires_at: future });

type Call = { url: string; auth?: string; body?: string };

/** A scripted fetch: each entry answers one call in order. */
function fakeFetch(script: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const impl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const call = { url: String(input), auth: headers.Authorization, body: init?.body ? String(init.body) : undefined };
    calls.push(call);
    const step = script.shift();
    if (!step) throw new Error(`Unexpected call: ${call.url}`);
    return step(call);
  };
  return { impl, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("pagination follows next_token until exhausted", async () => {
  const f = fakeFetch([
    () => json({ data: [{ day: "2026-03-01" }], next_token: "p2" }),
    () => json({ data: [{ day: "2026-03-02" }], next_token: null }),
  ]);
  const c = new OuraClient(cfg, tokens(), { fetch: f.impl, persistTokens: () => {} });
  const rows = await c.dailySleep("2026-03-01", "2026-03-02");
  assert.equal(rows.length, 2);
  assert.match(f.calls[0].url, /daily_sleep\?start_date=2026-03-01&end_date=2026-03-02$/);
  assert.match(f.calls[1].url, /next_token=p2/);
});

test("a 401 triggers one refresh, persists the new tokens, and retries the request", async () => {
  const persisted: Tokens[] = [];
  const f = fakeFetch([
    () => new Response("expired", { status: 401 }),
    (call) => { assert.match(call.body ?? "", /grant_type=refresh_token&refresh_token=R1/); return json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }); },
    (call) => { assert.equal(call.auth, "Bearer A2"); return json({ data: [{ day: "2026-03-01" }] }); },
  ]);
  const c = new OuraClient(cfg, tokens(), { fetch: f.impl, persistTokens: (t) => persisted.push(t) });
  const rows = await c.dailyReadiness("2026-03-01", "2026-03-01");
  assert.equal(rows.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].refresh_token, "R2");
  assert.equal(f.calls.length, 3);
});

test("concurrent requests with an expired token share a single refresh", async () => {
  const expired: Tokens = { access_token: "A1", refresh_token: "R1", expires_at: new Date(Date.now() - 1000).toISOString() };
  let refreshes = 0;
  const f = fakeFetch([
    () => { refreshes++; return json({ access_token: "A2", refresh_token: "R2", expires_in: 3600 }); },
    () => json({ data: [] }),
    () => json({ data: [] }),
  ]);
  const c = new OuraClient(cfg, expired, { fetch: f.impl, persistTokens: () => {} });
  await Promise.all([c.dailySleep("2026-03-01", "2026-03-01"), c.dailyActivity("2026-03-01", "2026-03-01")]);
  assert.equal(refreshes, 1);
  assert.ok(f.calls.slice(1).every((call) => call.auth === "Bearer A2"));
});

test("non-OK responses surface as errors with the endpoint and status", async () => {
  const f = fakeFetch([() => new Response("nope", { status: 500 })]);
  const c = new OuraClient(cfg, tokens(), { fetch: f.impl, persistTokens: () => {} });
  await assert.rejects(c.tags("2026-03-01", "2026-03-01"), /enhanced_tag 500: nope/);
});
