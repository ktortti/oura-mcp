import { AppConfig, Tokens, loadConfig, loadTokens, saveTokens } from "./config.js";
import { FetchLike, exchangeToken } from "./token.js";

const BASE = "https://api.ouraring.com/v2/usercollection";
export const MAX_RANGE_DAYS = 366;
const REFRESH_LEEWAY_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;

// ---- Oura v2 shapes (only the fields we use) ----
export interface SleepPeriod {
  id: string; day: string; type: string;
  bedtime_start: string; bedtime_end: string;
  total_sleep_duration: number | null; time_in_bed: number | null; efficiency: number | null; latency: number | null;
  lowest_heart_rate: number | null; average_heart_rate: number | null; average_hrv: number | null; average_breath: number | null;
  heart_rate?: { interval: number; items: (number | null)[]; timestamp: string } | null;
  readiness?: { score?: number | null; temperature_deviation?: number | null } | null;
}
export interface DailySleep { day: string; score: number | null; }
export interface DailyReadiness {
  day: string; score: number | null; temperature_deviation: number | null; temperature_trend_deviation: number | null;
  contributors?: Record<string, number | null>;
}
export interface DailyActivity { day: string; score: number | null; steps: number | null; }
export interface DailyStress { day: string; stress_high: number | null; recovery_high: number | null; day_summary: string | null; }
export interface DailySpo2 { day: string; spo2_percentage: { average: number | null } | null; }
export interface EnhancedTag { id: string; day: string; start_time: string | null; end_time: string | null; tag_type_code: string | null; comment: string | null; custom_name: string | null; }

interface Page<T> { data: T[]; next_token?: string | null }

export interface ClientDeps {
  fetch?: FetchLike;
  now?: () => number;
  persistTokens?: (t: Tokens) => void;
}

export class OuraClient {
  private tokens: Tokens;
  private refreshing: Promise<void> | null = null;
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly persist: (t: Tokens) => void;

  constructor(private readonly cfg: AppConfig, tokens: Tokens, deps: ClientDeps = {}) {
    this.tokens = tokens;
    this.fetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.persist = deps.persistTokens ?? saveTokens;
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

  /** Oura refresh tokens are single-use, so concurrent refreshes must collapse into one request. */
  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      if (!this.tokens.refresh_token) throw new Error("No refresh token. Run: node dist/index.js auth");
      const t = await exchangeToken(this.cfg, { grant_type: "refresh_token", refresh_token: this.tokens.refresh_token }, this.fetch, this.now);
      this.tokens = t;
      this.persist(t);
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private authedGet(url: URL): Promise<Response> {
    return this.fetch(url, {
      headers: { Authorization: `Bearer ${this.tokens.access_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  }

  private async getPage<T>(path: string, params: Record<string, string | undefined>): Promise<Page<T>> {
    if (new Date(this.tokens.expires_at).getTime() - this.now() < REFRESH_LEEWAY_MS) await this.refresh();
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);

    let res = await this.authedGet(url);
    if (res.status === 401) { await this.refresh(); res = await this.authedGet(url); }
    if (res.status === 429) throw new Error("Oura rate limit hit (429). Wait a minute and retry with a smaller range.");
    if (!res.ok) throw new Error(`Oura ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as Page<T>;
  }

  private async getAll<T>(path: string, start: string, end: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null | undefined;
    do {
      const page = await this.getPage<T>(path, { start_date: start, end_date: end, next_token: next ?? undefined });
      out.push(...page.data);
      next = page.next_token;
    } while (next);
    return out;
  }

  sleep(start: string, end: string) { return this.getAll<SleepPeriod>("sleep", start, end); }
  dailySleep(start: string, end: string) { return this.getAll<DailySleep>("daily_sleep", start, end); }
  dailyReadiness(start: string, end: string) { return this.getAll<DailyReadiness>("daily_readiness", start, end); }
  dailyActivity(start: string, end: string) { return this.getAll<DailyActivity>("daily_activity", start, end); }
  dailyStress(start: string, end: string) { return this.getAll<DailyStress>("daily_stress", start, end); }
  dailySpo2(start: string, end: string) { return this.getAll<DailySpo2>("daily_spo2", start, end); }
  tags(start: string, end: string) { return this.getAll<EnhancedTag>("enhanced_tag", start, end); }
}
