import { AppConfig, Tokens, loadConfig, loadTokens, saveTokens } from "./config.js";
import { exchange } from "./auth.js";

const BASE = "https://api.ouraring.com/v2/usercollection";
export const MAX_RANGE_DAYS = 366;

// ---- Oura v2 shapes (only the fields we use) ----
export interface SleepPeriod {
  id: string; day: string; type: string;
  bedtime_start: string; bedtime_end: string;
  total_sleep_duration: number | null; time_in_bed: number | null; efficiency: number | null; latency: number | null;
  awake_time?: number | null; deep_sleep_duration?: number | null; rem_sleep_duration?: number | null; light_sleep_duration?: number | null;
  lowest_heart_rate: number | null; average_heart_rate: number | null; average_hrv: number | null; average_breath: number | null;
  heart_rate?: { interval: number; items: (number | null)[]; timestamp: string } | null;
  hrv?: { interval: number; items: (number | null)[]; timestamp: string } | null;
  readiness?: { score?: number | null; temperature_deviation?: number | null; temperature_trend_deviation?: number | null } | null;
}
export interface DailySleep { day: string; score: number | null; contributors?: Record<string, number | null>; }
export interface DailyReadiness {
  day: string; score: number | null; temperature_deviation: number | null; temperature_trend_deviation: number | null;
  contributors?: Record<string, number | null>;
}
export interface DailyActivity { day: string; score: number | null; steps: number | null; active_calories?: number | null; total_calories?: number | null; }
export interface DailyStress { day: string; stress_high: number | null; recovery_high: number | null; day_summary: string | null; }
export interface DailySpo2 { day: string; spo2_percentage: { average: number | null } | null; breathing_disturbance_index?: number | null; }
export interface EnhancedTag { id: string; day: string; start_time: string | null; end_time: string | null; tag_type_code: string | null; comment: string | null; custom_name: string | null; }

export class OuraClient {
  private cfg: AppConfig;
  private tokens: Tokens;
  private refreshing: Promise<void> | null = null;

  private constructor(cfg: AppConfig, tokens: Tokens) { this.cfg = cfg; this.tokens = tokens; }

  static load(): OuraClient {
    const cfg = loadConfig();
    if (!cfg) throw new Error("Not configured. Run: node dist/index.js init");
    const tokens = loadTokens();
    if (!tokens) throw new Error("Not authorised. Run: node dist/index.js auth");
    return new OuraClient(cfg, tokens);
  }

  tokenInfo() { return { expires_at: this.tokens.expires_at, scope: this.tokens.scope ?? this.cfg.scopes }; }

  /** Refresh tokens are single-use: serialise so concurrent 401s don't race. */
  private async refresh(): Promise<void> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        if (!this.tokens.refresh_token) throw new Error("No refresh token. Run: node dist/index.js auth");
        const t = await exchange(this.cfg, { grant_type: "refresh_token", refresh_token: this.tokens.refresh_token });
        this.tokens = t;
        saveTokens(t);
      })().finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<{ data: T[]; next_token?: string | null }> {
    if (new Date(this.tokens.expires_at).getTime() - Date.now() < 60_000) await this.refresh();
    const url = new URL(`${BASE}/${path}`);
    for (const [k, v] of Object.entries(params)) if (v) url.searchParams.set(k, v);
    const doFetch = () => fetch(url, { headers: { Authorization: `Bearer ${this.tokens.access_token}`, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    let res = await doFetch();
    if (res.status === 401) { await this.refresh(); res = await doFetch(); }
    if (res.status === 429) throw new Error("Oura rate limit hit (429). Wait a minute and retry with a smaller range.");
    if (!res.ok) throw new Error(`Oura ${path} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as { data: T[]; next_token?: string | null };
  }

  private async all<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const out: T[] = [];
    let next: string | null | undefined;
    do {
      const page = await this.get<T>(path, { ...params, ...(next ? { next_token: next } : {}) });
      out.push(...page.data);
      next = page.next_token;
    } while (next);
    return out;
  }

  sleep(start: string, end: string) { return this.all<SleepPeriod>("sleep", { start_date: start, end_date: end }); }
  dailySleep(start: string, end: string) { return this.all<DailySleep>("daily_sleep", { start_date: start, end_date: end }); }
  dailyReadiness(start: string, end: string) { return this.all<DailyReadiness>("daily_readiness", { start_date: start, end_date: end }); }
  dailyActivity(start: string, end: string) { return this.all<DailyActivity>("daily_activity", { start_date: start, end_date: end }); }
  dailyStress(start: string, end: string) { return this.all<DailyStress>("daily_stress", { start_date: start, end_date: end }); }
  dailySpo2(start: string, end: string) { return this.all<DailySpo2>("daily_spo2", { start_date: start, end_date: end }); }
  tags(start: string, end: string) { return this.all<EnhancedTag>("enhanced_tag", { start_date: start, end_date: end }); }
}
