import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OuraClient } from "./client.js";
import { resolveExportDir } from "./export.js";
import { addDays, parseLocal } from "./time.js";

/** Collection endpoints readable with scopes `daily heartrate tag spo2 stress`. */
export const COLLECTIONS = [
  "sleep", "daily_sleep", "daily_readiness", "daily_activity", "daily_stress", "daily_spo2",
  "daily_resilience", "sleep_time", "rest_mode_period", "enhanced_tag",
] as const;

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

function csv(rows: Row[], columns?: string[]): string {
  if (!rows.length) return "";
  const cols = columns ?? Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const esc = (v: unknown) => { const s = str(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/** Expand a sleep period's 5-minute sample series (heart_rate / hrv) into one row per sample. */
export function seriesRows(period: Row, field: "heart_rate" | "hrv"): Row[] {
  const series = period[field] as { interval?: number; items?: (number | null)[]; timestamp?: string } | null | undefined;
  if (!series?.items?.length || !series.timestamp || !series.interval) return [];
  const start = parseLocal(series.timestamp);
  const offMs = offsetMs(start.offset);
  return series.items.map((v, i) => {
    const epoch = start.epochMs + i * (series.interval as number) * 1000;
    return {
      sleep_id: period.id, day: period.day, sample: i,
      timestamp_local: new Date(epoch + offMs).toISOString().slice(0, 19).replace("T", " "),
      offset: start.offset, value: v,
    };
  });
}

function offsetMs(off: string): number {
  const m = off.match(/^([+-])(\d{2}):(\d{2})$/);
  return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000 : 0;
}

/** Flatten a sleep period to the scalar columns (nested series and phase strings go to their own files). */
export function nightRow(p: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(p)) {
    if (k === "heart_rate" || k === "hrv") continue;
    if (v != null && typeof v === "object" && !Array.isArray(v)) {
      for (const [k2, v2] of Object.entries(v as Row)) if (v2 == null || typeof v2 !== "object") out[`${k}.${k2}`] = v2;
      continue;
    }
    out[k] = v;
  }
  const b = parseLocal(String(p.bedtime_start)), w = parseLocal(String(p.bedtime_end));
  out.bedtime_local = `${b.date} ${b.hhmm}`; out.wake_local = `${w.date} ${w.hhmm}`; out.offset = b.offset;
  return out;
}

export interface ArchiveOpts { since: string; until: string; dir: string; log?: (line: string) => void }

/**
 * Pull everything the token can read, for the whole range, and write it under `dir`:
 * raw/<endpoint>.json (untouched API records) and flattened CSVs for spreadsheet use.
 */
export async function archive(client: OuraClient, opts: ArchiveOpts): Promise<{ dir: string; counts: Record<string, number> }> {
  const dir = resolveExportDir(opts.dir);
  const raw = join(dir, "raw");
  mkdirSync(raw, { recursive: true, mode: 0o700 });
  const log = opts.log ?? (() => {});
  const counts: Record<string, number> = {};
  const write = (name: string, text: string) => writeFileSync(join(dir, name), text, { mode: 0o600 });
  const writeRaw = (name: string, rows: unknown[]) => writeFileSync(join(raw, `${name}.json`), JSON.stringify(rows, null, 1) + "\n", { mode: 0o600 });

  const data: Record<string, Row[]> = {};
  for (const path of COLLECTIONS) {
    try {
      data[path] = await client.rawCollection(path, opts.since, opts.until);
    } catch (e) {
      // An endpoint the account or scopes don't cover is not fatal to the archive.
      log(`  ${path}: skipped (${e instanceof Error ? e.message.split("\n")[0].slice(0, 100) : e})`);
      data[path] = [];
      continue;
    }
    counts[path] = data[path].length;
    writeRaw(path, data[path]);
    log(`  ${path}: ${data[path].length}`);
  }

  // Daytime heart-rate series, fetched in 7-day windows to stay well under page limits.
  const hr: Row[] = [];
  for (let d = opts.since; d < opts.until; d = addDays(d, 7)) {
    const to = addDays(d, 7) < opts.until ? addDays(d, 7) : opts.until;
    hr.push(...(await client.rawHeartrate(`${d}T00:00:00`, `${to}T23:59:59`)));
  }
  counts.heartrate = hr.length;
  writeRaw("heartrate", hr);
  log(`  heartrate: ${hr.length}`);

  // Flattened CSVs
  const sleep = data.sleep ?? [];
  write("nights.csv", csv(sleep.map(nightRow)));
  write("sleep_hr_curves.csv", csv(sleep.flatMap((p) => seriesRows(p, "heart_rate")), ["sleep_id", "day", "sample", "timestamp_local", "offset", "value"]));
  write("sleep_hrv_curves.csv", csv(sleep.flatMap((p) => seriesRows(p, "hrv")), ["sleep_id", "day", "sample", "timestamp_local", "offset", "value"]));
  write("heartrate.csv", csv(hr.map((r) => ({ timestamp: r.timestamp, bpm: r.bpm, source: r.source })), ["timestamp", "bpm", "source"]));
  for (const path of COLLECTIONS) {
    if (path === "sleep") continue;
    const rows = (data[path] ?? []).map((r) => {
      const flat: Row = {};
      for (const [k, v] of Object.entries(r)) {
        if (v != null && typeof v === "object" && !Array.isArray(v)) { for (const [k2, v2] of Object.entries(v as Row)) flat[`${k}.${k2}`] = v2; }
        else flat[k] = v;
      }
      return flat;
    });
    write(`${path}.csv`, csv(rows));
  }
  write("ARCHIVE.txt", [
    `Oura archive ${opts.since} → ${opts.until}, written ${new Date().toISOString()}`,
    "raw/*.json are the API records untouched; *.csv are flattened for spreadsheets.",
    "sleep_hr_curves.csv / sleep_hrv_curves.csv: one row per 5-minute sample per night. heartrate.csv: daytime 5-minute series.",
    ...Object.entries(counts).map(([k, v]) => `${k}: ${v}`),
  ].join("\n") + "\n");
  return { dir, counts };
}
