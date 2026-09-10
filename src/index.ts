#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { z } from "zod";
import { runAuth, runInit } from "./auth.js";
import { MAX_RANGE_DAYS, OuraClient } from "./client.js";
import { filePermissions, loadConfig, loadTokens, paths } from "./config.js";
import { addDays, daysBetween, isValidDate, parseLocal, todayLocal } from "./time.js";
import { baselineDrift, buildDailyTable, chronotype, eventContext, mainSleeps, summariseNight, temperatureShifts } from "./analysis.js";
import { writeCsvs } from "./export.js";

// ---------------------------------------------------------------- schemas

const DATE = z.string().refine(isValidDate, "Expected a real calendar date, YYYY-MM-DD");
const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected HH:MM, 24-hour");
const RANGE = { start: DATE, end: DATE };

function assertRange(start: string, end: string, maxDays = MAX_RANGE_DAYS): void {
  const n = daysBetween(start, end);
  if (n < 0) throw new Error("end is before start");
  if (n > maxDays) throw new Error(`Range capped at ${maxDays} days`);
}

// ---------------------------------------------------------------- server

function buildServer(): McpServer {
  const server = new McpServer({ name: "oura-mcp-local", version: "0.3.0" });
  let client: OuraClient | null = null;
  const oura = () => (client ??= OuraClient.load());

  /** Register a tool whose handler returns a JSON-serialisable value; thrown errors become MCP error results. */
  function tool<S extends ZodRawShapeCompat>(name: string, description: string, inputSchema: S, run: (args: ShapeOutput<S>) => Promise<unknown>): void {
    const callback = async (args: ShapeOutput<S>): Promise<CallToolResult> => {
      try {
        const value = await run(args);
        return { content: [{ type: "text", text: JSON.stringify(value, null, 1) }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
      }
    };
    // ToolCallback<S> is a conditional type over the generic S, which TypeScript cannot resolve
    // inside this function; the shapes are identical once S is concrete at each call site.
    server.registerTool(name, { description, inputSchema }, callback as unknown as ToolCallback<S>);
  }

  tool("oura_status",
    "Connection status: token expiry, granted scopes, config file permissions. Returns no health data.",
    {},
    async () => {
      const cfg = loadConfig(), tokens = loadTokens();
      return {
        configured: !!cfg, authorised: !!tokens,
        scopes: tokens?.scope ?? cfg?.scopes ?? null, token_expires_at: tokens?.expires_at ?? null,
        files: { ...paths, permissions: filePermissions() }, host: "api.ouraring.com",
      };
    });

  tool("oura_event_context",
    "Sleep and physiology context for a timed event on a given day (a test, a flight, a race): the preceding night (bedtime, wake, duration, lowest HR and when), hours awake at the event, hours since the nightly HR trough, sleep vs 30-day median, readiness and temperature deviation.",
    { date: DATE.describe("Event date, YYYY-MM-DD"), time: HHMM.describe("Local clock time of the event, HH:MM") },
    async ({ date, time }) => {
      const [nights, baseline, readiness] = await Promise.all([
        oura().sleep(addDays(date, -2), date),
        oura().sleep(addDays(date, -31), addDays(date, -1)),
        oura().dailyReadiness(date, date),
      ]);
      return eventContext(date, time, nights, baseline, readiness);
    });

  tool("oura_chronotype",
    "Computed chronotype from main sleep periods: median/IQR bedtime, wake and midpoint; weekday vs weekend; regularity (SD of midpoint); midpoint shift vs a ~03:30 population reference; day-by-day phase series (useful across travel).",
    { days: z.number().int().min(14).max(MAX_RANGE_DAYS).default(90).describe("Look-back window in days") },
    async ({ days }) => {
      const end = todayLocal();
      return chronotype(await oura().sleep(addDays(end, -days), end));
    });

  tool("oura_sleep_periods",
    "Per-night summaries (main sleep and naps): bedtime, wake, midpoint, hours, efficiency, latency, lowest HR and its time, average HR/HRV/respiratory rate, temperature deviation. Optional 5-min HR curve (limits range to 31 days).",
    { ...RANGE, include_hr_curve: z.boolean().default(false), main_sleep_only: z.boolean().default(true) },
    async ({ start, end, include_hr_curve, main_sleep_only }) => {
      assertRange(start, end, include_hr_curve ? 31 : MAX_RANGE_DAYS);
      const periods = await oura().sleep(start, end);
      return (main_sleep_only ? mainSleeps(periods) : periods)
        .sort((a, b) => a.bedtime_start.localeCompare(b.bedtime_start))
        .map((p) => summariseNight(p, include_hr_curve));
    });

  tool("oura_temperature_shifts",
    "Nightly temperature deviation with a sustained-shift detector: baseline mean, shift day, elevated-phase mean, amplitude, duration, and a flag when the current elevation has outlasted the expected duration. Heuristic; parameters exposed and the raw series returned so the decision is auditable.",
    {
      ...RANGE,
      threshold: z.number().min(0.05).max(1).default(0.2).describe("°C above baseline mean to count as elevated"),
      confirm_days: z.number().int().min(2).max(5).default(3).describe("Consecutive days required above threshold"),
      baseline_days: z.number().int().min(4).max(14).default(6).describe("Days before a candidate shift used as baseline"),
      expected_elevated_days: z.number().int().min(3).max(30).default(14).describe("Expected length of an elevated phase; the flag fires beyond this + 2"),
    },
    async ({ start, end, ...opts }) => {
      assertRange(start, end);
      return temperatureShifts(await oura().dailyReadiness(start, end), opts);
    });

  tool("oura_daily",
    "Compact daily table: readiness score, sleep score, activity score and steps, stress summary, SpO2 average, nightly lowest HR, average HRV, temperature deviation.",
    RANGE,
    async ({ start, end }) => {
      assertRange(start, end);
      const [readiness, sleepScores, activity, stress, spo2, sleep] = await Promise.all([
        oura().dailyReadiness(start, end), oura().dailySleep(start, end), oura().dailyActivity(start, end),
        oura().dailyStress(start, end), oura().dailySpo2(start, end), oura().sleep(start, end),
      ]);
      return buildDailyTable({ readiness, sleepScores, activity, stress, spo2, sleep });
    });

  tool("oura_tags",
    "User-entered tags (e.g. alcohol, travel, illness, custom) with day, times and comments.",
    RANGE,
    async ({ start, end }) => {
      assertRange(start, end);
      return (await oura().tags(start, end)).map((t) => ({
        day: t.day, tag: t.tag_type_code ?? t.custom_name,
        start: t.start_time ? parseLocal(t.start_time).hhmm : null, end: t.end_time ? parseLocal(t.end_time).hhmm : null,
        comment: t.comment,
      }));
    });

  tool("oura_baseline_drift",
    "Baseline drift: nightly lowest HR, average HR, HRV, respiratory rate and temperature deviation over the last `window` nights vs the preceding baseline, with deltas, z-scores and flags. Interpretation is left to the caller.",
    { days: z.number().int().min(14).max(180).default(30), window: z.number().int().min(3).max(14).default(7) },
    async ({ days, window }) => {
      const end = todayLocal(), start = addDays(end, -days);
      const [sleep, readiness] = await Promise.all([oura().sleep(start, end), oura().dailyReadiness(start, end)]);
      return baselineDrift(sleep, readiness, days, window);
    });

  tool("oura_export",
    "Write CSVs (sleep, daily, temperature, tags) for a date range into a directory under your home folder. Local disk only.",
    { ...RANGE, dir: z.string().describe("Target directory under your home folder, e.g. ~/oura-data") },
    async ({ start, end, dir }) => {
      assertRange(start, end);
      const [sleep, readiness, sleepScores, activity, tags] = await Promise.all([
        oura().sleep(start, end), oura().dailyReadiness(start, end), oura().dailySleep(start, end),
        oura().dailyActivity(start, end), oura().tags(start, end),
      ]);
      const files = {
        sleep: mainSleeps(sleep).map((p) => ({ ...summariseNight(p) })),
        daily: buildDailyTable({ readiness, sleepScores, activity }),
        temperature: readiness.map((r) => ({ day: r.day, temp_deviation: r.temperature_deviation, temp_trend_deviation: r.temperature_trend_deviation })),
        tags: tags.map((t) => ({ day: t.day, tag: t.tag_type_code ?? t.custom_name, comment: t.comment })),
      };
      const written = writeCsvs(dir, files);
      return { written, rows: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.length])) };
    });

  return server;
}

// ---------------------------------------------------------------- CLI

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "serve";
  switch (cmd) {
    case "init": return runInit();
    case "auth": return runAuth();
    case "status": {
      const cfg = loadConfig(), tokens = loadTokens();
      console.log(JSON.stringify({
        configured: !!cfg, authorised: !!tokens,
        scopes: tokens?.scope ?? cfg?.scopes ?? null, token_expires_at: tokens?.expires_at ?? null,
        files: { ...paths, permissions: filePermissions() },
      }, null, 2));
      return;
    }
    case "serve":
      await buildServer().connect(new StdioServerTransport());
      return;
    default:
      console.error("Usage: oura-mcp-local [init|auth|status|serve]");
      process.exit(2);
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
