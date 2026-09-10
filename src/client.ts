import { z } from "zod";
import { AppConfig, Tokens, loadConfig, loadTokens, paths, saveTokens } from "./config.js";
import { withFileLock } from "./lock.js";
import { FetchLike, exchangeToken } from "./token.js";
import {
  DailyActivitySchema, DailyReadinessSchema, DailySleepSchema, DailySpo2Schema, DailyStressSchema,
  EnhancedTagSchema, SleepPeriodSchema, pageOf,
} from "./schemas.js";

export type { SleepPeriod, DailySleep, DailyReadiness, DailyActivity, DailyStress, DailySpo2, EnhancedTag } from "./schemas.js";

const BASE = "https://api.ouraring.com/v2/usercollection";
export const MAX_RANGE_DAYS = 366;
const MAX_PAGES = 50;
const REFRESH_LEEWAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RETRY = { attempts: 3, baseMs: 500, maxMs: 10_000 };
const MAX_CONCURRENT = 4;

export interface ClientDeps {
  fetch?: FetchLike;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  persistTokens?: (t: Tokens) => void;
  reloadTokens?: () => Tokens | null;
  /** Cross-process mutual exclusion around refresh. Default: an O_EXCL lock file next to the token file. */
  lock?: <T>(fn: () => Promise<T>) => Promise<T>;
  maxConcurrent?: number;
}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class OuraClient {
  private tokens: Tokens;
  private refreshing: Promise<void> | null = null;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly persist: (t: Tokens) => void;
  private readonly reload: () => Tokens | null;
  private readonly lock: <T>(fn: () => Promise<T>) => Promise<T>;
  private readonly gate: Semaphore;

  constructor(private readonly cfg: AppConfig, tokens: Tokens, deps: ClientDeps = {}) {
    this.tokens = tokens;
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.wait = deps.wait ?? defaultWait;
    this.persist = deps.persistTokens ?? saveTokens;
    this.reload = deps.reloadTokens ?? loadTokens;
    this.lock = deps.lock ?? ((fn) => withFileLock(paths.LOCK_FILE, fn));
    this.gate = new Semaphore(deps.maxConcurrent ?? MAX_CONCURRENT);
  }

  /** Build from the config and token files on disk. */
  static load(): OuraClient {
    const cfg = loadConfig();
    if (!cfg) throw new Error("Not configured. Run: node dist/index.js init");
    const tokens = loadTokens();
    if (!tokens) throw new Error("Not authorised. Run: node dist/index.js auth");
    return new OuraClient(cfg, tokens);
  }

  tokenInfo() { return { expires_at: this.tokens.expires_at, scope: this.tokens.scope ?? this.cfg.scopes }; }

  // ---------------------------------------------------------------- tokens

  private isUsable(t: Tokens): boolean {
    return new Date(t.expires_at).getTime() - this.now() >= REFRESH_LEEWAY_MS;
  }

  /** In-process: concurrent callers share one refresh. Cross-process: see refreshUnderLock. */
  private refresh(): Promise<void> {
    this.refreshing ??= this.refreshUnderLock().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  /**
   * Oura refresh tokens are single-use. Another server process sharing the token file may
   * have refreshed already, so: take the lock, re-read the file, adopt newer tokens if present,
   * and only then spend our refresh token. If Oura rejects it, re-read once more before giving up.
   */
  private refreshUnderLock(): Promise<void> {
    return this.lock(async () => {
      const onDisk = this.reload();
      if (onDisk && onDisk.access_token !== this.tokens.access_token && this.isUsable(onDisk)) {
        this.tokens = onDisk;
        return;
      }
      if (!this.tokens.refresh_token) throw new Error("No refresh token. Run: node dist/index.js auth");
      try {
        const fresh = await exchangeToken(this.cfg, { grant_type: "refresh_token", refresh_token: this.tokens.refresh_token }, this.fetch, this.now);
        this.tokens = fresh;
        this.persist(fresh);
      } catch (e) {
        const again = this.reload();
        if (again && again.refresh_token !== this.tokens.refresh_token) { this.tokens = again; return; }
        throw new Error(`Oura rejected the refresh token (${e instanceof Error ? e.message : String(e)}). Run: node dist/index.js auth`);
      }
    });
  }

  // ---------------------------------------------------------------- HTTP

  private authedGet(url: URL): Promise<Response> {
    return this.fetch(url, {
      headers: { Authorization: `Bearer ${this.tokens.access_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  /**
   * GET with bounded retries: 429 honours Retry-After, 5xx and network/timeout failures back off
   * with jitter, a 401 triggers exactly one refresh. Anything else is returned to the caller.
   */
  private async getWithRetry(url: URL): Promise<Response> {
    let refreshed = false;
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null;
      let failure: unknown = null;
      try { res = await this.authedGet(url); } catch (e) { failure = e; }

      if (res?.status === 401 && !refreshed) { refreshed = true; await this.refresh(); continue; }
      const retryable = failure != null || res!.status === 429 || res!.status >= 500;
      if (!retryable) return res!;
      if (attempt >= RETRY.attempts) {
        if (res) return res;
        throw new Error(`Oura request failed after ${attempt} attempts: ${failure instanceof Error ? failure.message : String(failure)}`);
      }
      await this.wait(retryAfterMs(res) ?? backoffMs(attempt));
    }
  }

  private async getPage<T extends z.ZodTypeAny>(path: string, item: T, params: Record<string, string | undefined>): Promise<z.infer<ReturnType<typeof pageOf<T>>>> {
    if (!this.isUsable(this.tokens)) await this.refresh();
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);

    const res = await this.gate.run(() => this.getWithRetry(url));
    if (res.status === 429) throw new Error(`Oura rate limit on ${path} persisted through ${RETRY.attempts} attempts. Wait a minute and retry with a smaller range.`);
    if (!res.ok) throw new Error(`Oura ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);

    const parsed = pageOf(item).safeParse(await res.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`Oura ${path}: unexpected response shape at ${issue.path.join(".") || "root"} — ${issue.message}`);
    }
    return parsed.data;
  }

  private async getAll<T extends z.ZodTypeAny>(path: string, item: T, start: string, end: string): Promise<z.infer<T>[]> {
    const out: z.infer<T>[] = [];
    const seen = new Set<string>();
    let next: string | null | undefined;
    for (let page = 1; ; page++) {
      if (page > MAX_PAGES) throw new Error(`Oura ${path}: more than ${MAX_PAGES} pages for one range; narrow the dates.`);
      const result = await this.getPage(path, item, { start_date: start, end_date: end, next_token: next ?? undefined });
      out.push(...result.data);
      next = result.next_token;
      if (!next) return out;
      if (seen.has(next)) throw new Error(`Oura ${path}: pagination returned a repeated next_token.`);
      seen.add(next);
    }
  }

  // ---------------------------------------------------------------- endpoints

  sleep(start: string, end: string) { return this.getAll("sleep", SleepPeriodSchema, start, end); }
  dailySleep(start: string, end: string) { return this.getAll("daily_sleep", DailySleepSchema, start, end); }
  dailyReadiness(start: string, end: string) { return this.getAll("daily_readiness", DailyReadinessSchema, start, end); }
  dailyActivity(start: string, end: string) { return this.getAll("daily_activity", DailyActivitySchema, start, end); }
  dailyStress(start: string, end: string) { return this.getAll("daily_stress", DailyStressSchema, start, end); }
  dailySpo2(start: string, end: string) { return this.getAll("daily_spo2", DailySpo2Schema, start, end); }
  tags(start: string, end: string) { return this.getAll("enhanced_tag", EnhancedTagSchema, start, end); }
}

// ---------------------------------------------------------------- helpers

function retryAfterMs(res: Response | null): number | null {
  const h = res?.headers.get("retry-after");
  if (!h) return null;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : new Date(h).getTime() - Date.now();
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, RETRY.maxMs) : null;
}

function backoffMs(attempt: number): number {
  const base = Math.min(RETRY.baseMs * 2 ** (attempt - 1), RETRY.maxMs);
  return base / 2 + Math.random() * base / 2; // jitter in [base/2, base)
}

/** Caps in-flight requests so a tool that fans out to several endpoints doesn't burst. */
class Semaphore {
  private active = 0;
  private readonly queue: (() => void)[] = [];
  constructor(private readonly limit: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.queue.shift()?.(); }
  }
}
