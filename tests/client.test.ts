import { test } from "node:test";
import assert from "node:assert/strict";
import { ClientDeps, OuraClient, REFRESH_LOCK_TIMEOUT_MS } from "../src/client.js";
import { TOKEN_TIMEOUT_MS } from "../src/token.js";
import type { AppConfig, Tokens } from "../src/config.js";

const cfg: AppConfig = { client_id: "id", client_secret: "secret", redirect_uri: "https://127.0.0.1:3000/callback", scopes: "daily" };
const inOneHour = () => new Date(Date.now() + 3_600_000).toISOString();
const expiredAt = () => new Date(Date.now() - 1000).toISOString();
const live = (): Tokens => ({ access_token: "A1", refresh_token: "R1", expires_at: inOneHour() });

type Call = { url: string; auth?: string; body?: string };

/** A scripted fetch: each entry answers one call in order. */
function fakeFetch(script: ((call: Call) => Response | Promise<Response>)[]) {
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
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
const tokenJson = (n: number) => json({ access_token: `A${n}`, refresh_token: `R${n}`, expires_in: 3600 });

/** Deps that make tests deterministic: no real waits, no disk, no lock file. */
function deps(fetchImpl: ClientDeps["fetch"], extra: Partial<ClientDeps> = {}): ClientDeps {
  return { fetch: fetchImpl, wait: async () => {}, persistTokens: () => {}, reloadTokens: () => null, lock: (fn) => fn(), ...extra };
}

// ---------------------------------------------------------------- pagination

test("pagination follows next_token until exhausted", async () => {
  const f = fakeFetch([
    () => json({ data: [{ day: "2026-03-01", score: 80 }], next_token: "p2" }),
    () => json({ data: [{ day: "2026-03-02", score: 81 }], next_token: null }),
  ]);
  const rows = await new OuraClient(cfg, live(), deps(f.impl)).dailySleep("2026-03-01", "2026-03-02");
  assert.equal(rows.length, 2);
  assert.match(f.calls[0].url, /daily_sleep\?start_date=2026-03-01&end_date=2026-03-02$/);
  assert.match(f.calls[1].url, /next_token=p2/);
});

test("a repeated next_token is an error, not an infinite loop", async () => {
  const f = fakeFetch([
    () => json({ data: [], next_token: "same" }),
    () => json({ data: [], next_token: "same" }),
  ]);
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).dailySleep("2026-03-01", "2026-03-02"), /repeated next_token/);
});

test("pagination is capped", async () => {
  const f = fakeFetch(Array.from({ length: 60 }, (_, i) => () => json({ data: [], next_token: `t${i}` })));
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).dailySleep("2026-03-01", "2026-03-02"), /more than 50 pages/);
});

// ---------------------------------------------------------------- validation

test("a malformed response fails with the endpoint and field named", async () => {
  const f = fakeFetch([() => json({ data: [{ id: "x", day: "2026-03-01", type: "long_sleep", bedtime_start: "2026-03-01T01:00:00+02:00" }] })]);
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).sleep("2026-03-01", "2026-03-01"), /Oura sleep: unexpected response shape at data\.0\.bedtime_end/);
});

test("enhanced tags use the spec's start_day/end_day, with day tolerated", async () => {
  const f = fakeFetch([() => json({ data: [
    { id: "t1", start_day: "2026-03-01", end_day: "2026-03-02", start_time: "2026-03-01T22:00:00+02:00", end_time: null, tag_type_code: "tag_generic_travel", comment: null, custom_name: null },
    { id: "t2", start_day: "2026-03-03", end_day: null, start_time: "2026-03-03T09:00:00+02:00", end_time: null, tag_type_code: null, comment: "note", custom_name: "Sauna" },
  ] })]);
  const rows = await new OuraClient(cfg, live(), deps(f.impl)).tags("2026-03-01", "2026-03-03");
  assert.equal(rows.length, 2);
  assert.equal(rows[0].start_day, "2026-03-01");
  assert.equal(rows[0].end_day, "2026-03-02");
  assert.equal(rows[1].custom_name, "Sauna");
});

test("a tag with none of day/start_day/end_day is rejected", async () => {
  const f = fakeFetch([() => json({ data: [{ id: "t1", start_time: "2026-03-01T22:00:00+02:00" }] })]);
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).tags("2026-03-01", "2026-03-03"), /enhanced_tag: unexpected response shape/);
});

test("unknown fields are stripped, optional fields may be absent", async () => {
  const f = fakeFetch([() => json({ data: [{ day: "2026-03-01", score: null, temperature_deviation: 0.1, temperature_trend_deviation: null, brand_new_field: 1 }] })]);
  const rows = await new OuraClient(cfg, live(), deps(f.impl)).dailyReadiness("2026-03-01", "2026-03-01");
  assert.deepEqual(Object.keys(rows[0]).sort(), ["day", "score", "temperature_deviation", "temperature_trend_deviation"]);
});

// ---------------------------------------------------------------- retries

test("429 with Retry-After is retried after the stated delay", async () => {
  const waits: number[] = [];
  const f = fakeFetch([
    () => json({}, 429, { "Retry-After": "2" }),
    () => json({ data: [] }),
  ]);
  await new OuraClient(cfg, live(), deps(f.impl, { wait: async (ms) => { waits.push(ms); } })).dailySleep("2026-03-01", "2026-03-01");
  assert.deepEqual(waits, [2000]);
  assert.equal(f.calls.length, 2);
});

test("5xx and network failures back off with jitter and then succeed", async () => {
  const waits: number[] = [];
  const f = fakeFetch([
    () => new Response("down", { status: 503 }),
    () => { throw new Error("socket hang up"); },
    () => json({ data: [] }),
  ]);
  await new OuraClient(cfg, live(), deps(f.impl, { wait: async (ms) => { waits.push(ms); } })).dailySleep("2026-03-01", "2026-03-01");
  assert.equal(waits.length, 2);
  assert.ok(waits[0] >= 250 && waits[0] < 500, `first backoff ${waits[0]}`);
  assert.ok(waits[1] >= 500 && waits[1] < 1000, `second backoff ${waits[1]}`);
});

test("retries are bounded: persistent 429 surfaces a clear error after three attempts", async () => {
  const f = fakeFetch([() => json({}, 429), () => json({}, 429), () => json({}, 429)]);
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).dailySleep("2026-03-01", "2026-03-01"), /rate limit on daily_sleep persisted through 3 attempts/);
  assert.equal(f.calls.length, 3);
});

test("4xx other than 401/429 is not retried", async () => {
  const f = fakeFetch([() => new Response("nope", { status: 400 })]);
  await assert.rejects(new OuraClient(cfg, live(), deps(f.impl)).tags("2026-03-01", "2026-03-01"), /enhanced_tag 400: nope/);
  assert.equal(f.calls.length, 1);
});

test("in-flight requests are capped by the semaphore", async () => {
  let inFlight = 0, peak = 0;
  const f = fakeFetch(Array.from({ length: 6 }, () => async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return json({ data: [] });
  }));
  const c = new OuraClient(cfg, live(), deps(f.impl, { maxConcurrent: 2 }));
  await Promise.all(Array.from({ length: 6 }, () => c.dailySleep("2026-03-01", "2026-03-01")));
  assert.equal(peak, 2);
});

// ---------------------------------------------------------------- refresh

test("a 401 triggers one refresh, persists the new tokens, and retries the request", async () => {
  const persisted: Tokens[] = [];
  const f = fakeFetch([
    () => new Response("expired", { status: 401 }),
    (call) => { assert.match(call.body ?? "", /grant_type=refresh_token&refresh_token=R1/); return tokenJson(2); },
    (call) => { assert.equal(call.auth, "Bearer A2"); return json({ data: [{ day: "2026-03-01", score: 1 }] }); },
  ]);
  const rows = await new OuraClient(cfg, live(), deps(f.impl, { persistTokens: (t) => persisted.push(t) })).dailyReadiness("2026-03-01", "2026-03-01");
  assert.equal(rows.length, 1);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].refresh_token, "R2");
});

test("concurrent requests with an expired token share a single refresh", async () => {
  let refreshes = 0;
  const f = fakeFetch([
    () => { refreshes++; return tokenJson(2); },
    () => json({ data: [] }),
    () => json({ data: [] }),
  ]);
  const c = new OuraClient(cfg, { access_token: "A1", refresh_token: "R1", expires_at: expiredAt() }, deps(f.impl));
  await Promise.all([c.dailySleep("2026-03-01", "2026-03-01"), c.dailyActivity("2026-03-01", "2026-03-01")]);
  assert.equal(refreshes, 1);
  assert.ok(f.calls.slice(1).every((call) => call.auth === "Bearer A2"));
});

/** Two clients sharing one token store, as two server processes would share the token file. */
function sharedStore(initial: Tokens) {
  const store = { tokens: initial };
  let chain = Promise.resolve();
  const lock = <T>(fn: () => Promise<T>): Promise<T> => { const run = chain.then(fn); chain = run.then(() => {}, () => {}); return run; };
  const forClient = (): Partial<ClientDeps> => ({ persistTokens: (t) => { store.tokens = t; }, reloadTokens: () => store.tokens, lock });
  return { store, forClient };
}

test("a second process adopts tokens another process already refreshed instead of spending its own", async () => {
  const stale: Tokens = { access_token: "A1", refresh_token: "R1", expires_at: expiredAt() };
  const shared = sharedStore(stale);
  let refreshes = 0;
  const fA = fakeFetch([() => { refreshes++; return tokenJson(2); }, () => json({ data: [] })]);
  const fB = fakeFetch([(call) => { assert.equal(call.auth, "Bearer A2"); return json({ data: [] }); }]);
  const a = new OuraClient(cfg, { ...stale }, deps(fA.impl, shared.forClient()));
  const b = new OuraClient(cfg, { ...stale }, deps(fB.impl, shared.forClient()));
  await a.dailySleep("2026-03-01", "2026-03-01");
  await b.dailySleep("2026-03-01", "2026-03-01");
  assert.equal(refreshes, 1);
  assert.equal(shared.store.tokens.refresh_token, "R2");
});

test("if Oura rejects a refresh token but the file has moved on, the newer tokens are adopted", async () => {
  const shared = sharedStore({ access_token: "A9", refresh_token: "R9", expires_at: inOneHour() });
  const f = fakeFetch([
    () => new Response('{"error":"invalid_grant"}', { status: 400 }),   // our stale R1 is refused
    (call) => { assert.equal(call.auth, "Bearer A9"); return json({ data: [] }); },
  ]);
  const c = new OuraClient(cfg, { access_token: "A1", refresh_token: "R1", expires_at: expiredAt() },
    deps(f.impl, { ...shared.forClient(), reloadTokens: (() => { let n = 0; return () => (n++ === 0 ? null : shared.store.tokens); })() }));
  await c.dailySleep("2026-03-01", "2026-03-01");
});

test("if Oura rejects the refresh token and nothing newer exists, the error says to re-authorise", async () => {
  const f = fakeFetch([() => new Response('{"error":"invalid_grant"}', { status: 400 })]);
  const c = new OuraClient(cfg, { access_token: "A1", refresh_token: "R1", expires_at: expiredAt() }, deps(f.impl));
  await assert.rejects(c.dailySleep("2026-03-01", "2026-03-01"), /rejected the refresh token.*Run: node dist\/index\.js auth/);
});

test("a process waits for a sibling's refresh at least as long as a refresh can take", () => {
  assert.ok(REFRESH_LOCK_TIMEOUT_MS >= 2 * TOKEN_TIMEOUT_MS, `${REFRESH_LOCK_TIMEOUT_MS} < 2 × ${TOKEN_TIMEOUT_MS}`);
});
