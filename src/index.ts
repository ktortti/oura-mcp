#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAuth, runInit } from "./auth.js";
import { MAX_RANGE_DAYS, OuraClient } from "./client.js";
import { filePermissions, loadConfig, loadTokens, paths } from "./config.js";
import { addDays, daysBetween, parseLocal, todayLocal } from "./time.js";
import { baselineDrift, chronotype, eventContext, mainSleeps, summariseNight, temperatureShifts } from "./analysis.js";
import { writeCsvs } from "./export.js";

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD");
const HHMM = z.string().regex(/^\d{2}:\d{2}$/, "HH:MM");

function range(start: string, end: string) {
  const n = daysBetween(start, end);
  if (n < 0) throw new Error("end is before start");
  if (n > MAX_RANGE_DAYS) throw new Error(`Range capped at ${MAX_RANGE_DAYS} days`);
}
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 1) }] });
const fail = (e: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

function buildServer(): McpServer {
  const server = new McpServer({ name: "oura-mcp-local", version: "0.1.0" });
  let client: OuraClient | null = null;
  const c = () => (client ??= OuraClient.load());

  server.registerTool("oura_status", {
    description: "Connection status: token expiry, granted scopes, config file permissions. Returns no health data.",
    inputSchema: {},
  }, async () => {
    try {
      const cfg = loadConfig(), t = loadTokens();
      return text({ configured: !!cfg, authorised: !!t, scopes: t?.scope ?? cfg?.scopes ?? null, token_expires_at: t?.expires_at ?? null,
        files: { ...paths, permissions: filePermissions() }, host: "api.ouraring.com" });
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_event_context", {
    description: "Sleep and physiology context for a timed event on a given day (a test, a flight, a race): the preceding night (bedtime, wake, duration, lowest HR and when), hours awake at the event, hours since the nightly HR trough, sleep vs 30-day median, readiness and temperature deviation.",
    inputSchema: { date: DATE.describe("Event date, YYYY-MM-DD"), time: HHMM.describe("Local clock time of the event, HH:MM") },
  }, async ({ date, time }) => {
    try {
      const [ps, base, rd] = await Promise.all([c().sleep(addDays(date, -2), date), c().sleep(addDays(date, -31), addDays(date, -1)), c().dailyReadiness(date, date)]);
      return text(eventContext(date, time, ps, base, rd));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_chronotype", {
    description: "Computed chronotype from main sleep periods: median/IQR bedtime, wake and midpoint; weekday vs weekend; regularity (SD of midpoint); midpoint shift vs a ~03:30 population reference; day-by-day phase series (useful across travel).",
    inputSchema: { days: z.number().int().min(14).max(MAX_RANGE_DAYS).default(90).describe("Look-back window in days") },
  }, async ({ days }) => {
    try {
      const end = todayLocal(), start = addDays(end, -days);
      return text(chronotype(await c().sleep(start, end)));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_sleep_periods", {
    description: "Per-night summaries (main sleep and naps): bedtime, wake, midpoint, hours, efficiency, latency, lowest HR and its time, average HR/HRV/respiratory rate, temperature deviation. Optional 5-min HR curve (limits range to 31 days).",
    inputSchema: { start: DATE, end: DATE, include_hr_curve: z.boolean().default(false), main_sleep_only: z.boolean().default(true) },
  }, async ({ start, end, include_hr_curve, main_sleep_only }) => {
    try {
      range(start, end);
      if (include_hr_curve && daysBetween(start, end) > 31) throw new Error("HR curve export limited to 31 days");
      const ps = await c().sleep(start, end);
      const sel = main_sleep_only ? mainSleeps(ps) : ps;
      return text(sel.sort((a, b) => a.bedtime_start.localeCompare(b.bedtime_start)).map((p) => summariseNight(p, include_hr_curve)));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_temperature_shifts", {
    description: "Nightly temperature deviation with a sustained-shift detector: baseline mean, shift day, elevated-phase mean, amplitude, duration, and a flag when the current elevation has outlasted the expected duration. Heuristic; parameters exposed and the raw series returned so the decision is auditable.",
    inputSchema: {
      start: DATE, end: DATE,
      threshold: z.number().min(0.05).max(1).default(0.2).describe("°C above baseline mean to count as elevated"),
      confirm_days: z.number().int().min(2).max(5).default(3).describe("Consecutive days required above threshold"),
      baseline_days: z.number().int().min(4).max(14).default(6).describe("Days before a candidate shift used as baseline"),
      expected_elevated_days: z.number().int().min(3).max(30).default(14).describe("Expected length of an elevated phase; the flag fires beyond this + 2"),
    },
  }, async ({ start, end, threshold, confirm_days, baseline_days, expected_elevated_days }) => {
    try {
      range(start, end);
      return text(temperatureShifts(await c().dailyReadiness(start, end), { threshold, confirm_days, baseline_days, expected_elevated_days }));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_daily", {
    description: "Compact daily table: readiness score, sleep score, activity score and steps, stress summary, SpO2 average, nightly lowest HR, average HRV, temperature deviation.",
    inputSchema: { start: DATE, end: DATE },
  }, async ({ start, end }) => {
    try {
      range(start, end);
      const [rd, ds, da, st, sp, ps] = await Promise.all([c().dailyReadiness(start, end), c().dailySleep(start, end), c().dailyActivity(start, end), c().dailyStress(start, end), c().dailySpo2(start, end), c().sleep(start, end)]);
      const days = new Map<string, Record<string, unknown>>();
      const row = (d: string) => days.get(d) ?? (days.set(d, { day: d }), days.get(d)!);
      rd.forEach((r) => Object.assign(row(r.day), { readiness: r.score, temp_deviation: r.temperature_deviation, rhr_contrib: r.contributors?.resting_heart_rate ?? null }));
      ds.forEach((r) => Object.assign(row(r.day), { sleep_score: r.score }));
      da.forEach((r) => Object.assign(row(r.day), { activity: r.score, steps: r.steps }));
      st.forEach((r) => Object.assign(row(r.day), { stress: r.day_summary, stress_high_min: r.stress_high != null ? Math.round(r.stress_high / 60) : null }));
      sp.forEach((r) => Object.assign(row(r.day), { spo2: r.spo2_percentage?.average ?? null }));
      mainSleeps(ps).forEach((p) => Object.assign(row(p.day), { lowest_hr: p.lowest_heart_rate, avg_hrv: p.average_hrv, asleep_h: Math.round((p.total_sleep_duration ?? 0) / 36) / 100 }));
      return text([...days.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_tags", {
    description: "User-entered tags (e.g. alcohol, travel, illness, custom) with day, times and comments.",
    inputSchema: { start: DATE, end: DATE },
  }, async ({ start, end }) => {
    try {
      range(start, end);
      const tags = await c().tags(start, end);
      return text(tags.map((t) => ({ day: t.day, tag: t.tag_type_code ?? t.custom_name, start: t.start_time ? parseLocal(t.start_time).hhmm : null, end: t.end_time ? parseLocal(t.end_time).hhmm : null, comment: t.comment })));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_baseline_drift", {
    description: "Baseline drift: nightly lowest HR, average HR, HRV, respiratory rate and temperature deviation over the last `window` nights vs the preceding baseline, with deltas, z-scores and flags. Interpretation is left to the caller.",
    inputSchema: { days: z.number().int().min(14).max(180).default(30), window: z.number().int().min(3).max(14).default(7) },
  }, async ({ days, window }) => {
    try {
      const end = todayLocal(), start = addDays(end, -days);
      const [ps, rd] = await Promise.all([c().sleep(start, end), c().dailyReadiness(start, end)]);
      return text(baselineDrift(ps, rd, days, window));
    } catch (e) { return fail(e); }
  });

  server.registerTool("oura_export", {
    description: "Write CSVs (sleep, daily, temperature, tags) for a date range into a directory under your home folder. Local disk only.",
    inputSchema: { start: DATE, end: DATE, dir: z.string().describe("Target directory under your home folder, e.g. ~/oura-data") },
  }, async ({ start, end, dir }) => {
    try {
      range(start, end);
      const [ps, rd, ds, da, tg] = await Promise.all([c().sleep(start, end), c().dailyReadiness(start, end), c().dailySleep(start, end), c().dailyActivity(start, end), c().tags(start, end)]);
      const sleep = mainSleeps(ps).map((p) => { const s = summariseNight(p); return { ...s }; });
      const dailyMap = new Map<string, Record<string, unknown>>();
      const row = (d: string) => dailyMap.get(d) ?? (dailyMap.set(d, { day: d }), dailyMap.get(d)!);
      rd.forEach((r) => Object.assign(row(r.day), { readiness: r.score, temp_deviation: r.temperature_deviation }));
      ds.forEach((r) => Object.assign(row(r.day), { sleep_score: r.score }));
      da.forEach((r) => Object.assign(row(r.day), { activity: r.score, steps: r.steps }));
      const temperature = rd.map((r) => ({ day: r.day, temp_deviation: r.temperature_deviation, temp_trend_deviation: r.temperature_trend_deviation }));
      const tags = tg.map((t) => ({ day: t.day, tag: t.tag_type_code ?? t.custom_name, comment: t.comment }));
      const written = writeCsvs(dir, { sleep, daily: [...dailyMap.values()], temperature, tags });
      return text({ written, rows: { sleep: sleep.length, daily: dailyMap.size, temperature: temperature.length, tags: tags.length } });
    } catch (e) { return fail(e); }
  });

  return server;
}

async function main() {
  const cmd = process.argv[2] ?? "serve";
  if (cmd === "init") return runInit();
  if (cmd === "auth") return runAuth();
  if (cmd === "status") {
    const cfg = loadConfig(), t = loadTokens();
    console.log(JSON.stringify({ configured: !!cfg, authorised: !!t, scopes: t?.scope ?? cfg?.scopes ?? null, token_expires_at: t?.expires_at ?? null, files: { ...paths, permissions: filePermissions() } }, null, 2));
    return;
  }
  if (cmd === "serve") {
    const server = buildServer();
    await server.connect(new StdioServerTransport());
    return;
  }
  console.error("Usage: oura-mcp-local [init|auth|status|serve]");
  process.exit(2);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
