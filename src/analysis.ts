import type { DailyActivity, DailyReadiness, DailySleep, DailySpo2, DailyStress, SleepPeriod } from "./client.js";
import { eveningHours, fromEveningHours, fmtHours, formatInOffset, hoursBetween, isWeekend, parseLocal } from "./time.js";
import { mean, median, quantile, round, sd } from "./stats.js";

// ---------------------------------------------------------------- nights

export interface NightSummary {
  day: string;                 // Oura "day" the sleep is attributed to (the wake date)
  type: string;
  bedtime: string; wake: string; offset: string;
  midpoint: string;
  in_bed_h: number | null; asleep_h: number | null; efficiency: number | null; latency_min: number | null;
  lowest_hr: number | null; lowest_hr_at: string | null;
  avg_hr: number | null; avg_hrv: number | null; resp_rate: number | null;
  temp_deviation: number | null;
  hr_curve?: { start: string; interval_s: number; bpm: (number | null)[] };
}

export interface Instant { epochMs: number; local: string }

/** Time of the lowest value on the 5-minute nightly HR curve, as an absolute instant plus local wall time. */
export function lowestHrInstant(p: SleepPeriod): Instant | null {
  const hr = p.heart_rate;
  if (!hr?.items?.length) return null;
  let best = Infinity, idx = -1;
  hr.items.forEach((v, i) => { if (v != null && v < best) { best = v; idx = i; } });
  if (idx < 0) return null;
  const start = parseLocal(hr.timestamp);
  const epochMs = start.epochMs + idx * hr.interval * 1000;
  return { epochMs, local: formatInOffset(epochMs, start.offset) };
}

export const mainSleeps = (ps: SleepPeriod[]) => ps.filter((p) => p.type === "long_sleep");

const secondsToHours = (s: number | null | undefined) => (s == null ? null : round(s / 3600));

export function summariseNight(p: SleepPeriod, withCurve = false): NightSummary {
  const bed = parseLocal(p.bedtime_start), wake = parseLocal(p.bedtime_end);
  const midH = eveningHours(bed.hours) + hoursBetween(p.bedtime_start, p.bedtime_end) / 2;
  const summary: NightSummary = {
    day: p.day, type: p.type,
    bedtime: `${bed.date} ${bed.hhmm}`, wake: `${wake.date} ${wake.hhmm}`, offset: bed.offset,
    midpoint: fmtHours(fromEveningHours(midH)),
    in_bed_h: secondsToHours(p.time_in_bed), asleep_h: secondsToHours(p.total_sleep_duration),
    efficiency: p.efficiency ?? null, latency_min: p.latency != null ? round(p.latency / 60, 0) : null,
    lowest_hr: p.lowest_heart_rate ?? null, lowest_hr_at: lowestHrInstant(p)?.local ?? null,
    avg_hr: p.average_heart_rate ?? null, avg_hrv: p.average_hrv ?? null, resp_rate: p.average_breath ?? null,
    temp_deviation: p.readiness?.temperature_deviation ?? null,
  };
  if (withCurve && p.heart_rate) {
    summary.hr_curve = { start: p.heart_rate.timestamp, interval_s: p.heart_rate.interval, bpm: p.heart_rate.items };
  }
  return summary;
}

// ---------------------------------------------------------------- chronotype

export const MIN_NIGHTS_FOR_CHRONOTYPE = 7;

export function chronotype(ps: SleepPeriod[]) {
  const nights = mainSleeps(ps);
  if (nights.length < MIN_NIGHTS_FOR_CHRONOTYPE) {
    return { nights: nights.length, insufficient_data: true as const, minimum_nights: MIN_NIGHTS_FOR_CHRONOTYPE };
  }
  const rows = nights.map((p) => {
    const bed = eveningHours(parseLocal(p.bedtime_start).hours);
    const dur = hoursBetween(p.bedtime_start, p.bedtime_end);
    return { day: p.day, bed, wake: bed + dur, mid: bed + dur / 2, dur, weekend: isWeekend(p.day) };
  });
  const clockStats = (xs: number[]) => ({
    median: fmtHours(fromEveningHours(median(xs))),
    p25: fmtHours(fromEveningHours(quantile(xs, 0.25))),
    p75: fmtHours(fromEveningHours(quantile(xs, 0.75))),
    sd_min: round(sd(xs) * 60, 0),
  });
  const group = (r: typeof rows) => ({
    n: r.length,
    bedtime: clockStats(r.map((x) => x.bed)),
    wake: clockStats(r.map((x) => x.wake)),
    midpoint: clockStats(r.map((x) => x.mid)),
    in_bed_h: round(median(r.map((x) => x.dur))),
  });
  const midMedian = median(rows.map((x) => x.mid));
  return {
    nights: rows.length,
    all: group(rows),
    weekday: group(rows.filter((x) => !x.weekend)),
    weekend: group(rows.filter((x) => x.weekend)),
    regularity_sd_of_midpoint_min: round(sd(rows.map((x) => x.mid)) * 60, 0),
    reference_midpoint_shift_h: round(midMedian - eveningHours(3.5)), // vs a ~03:30 population midpoint
    phase_series: rows.map((x) => ({ day: x.day, midpoint: fmtHours(fromEveningHours(x.mid)), shift_h: round(x.mid - midMedian, 1) })),
  };
}

// ---------------------------------------------------------------- event context

export function eventContext(date: string, eventTime: string, ps: SleepPeriod[], baseline: SleepPeriod[], readiness: DailyReadiness[]) {
  const night = mainSleeps(ps)
    .filter((p) => parseLocal(p.bedtime_end).date === date)
    .sort((a, b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0];
  if (!night) return { date, error: `No main sleep period ending on ${date}.` };

  const summary = summariseNight(night);
  const wake = parseLocal(night.bedtime_end);
  const eventEpochMs = new Date(`${date}T${eventTime}:00${wake.offset}`).getTime();
  const trough = lowestHrInstant(night);
  const baseNights = mainSleeps(baseline);
  const baseSleepH = baseNights.map((p) => p.total_sleep_duration).filter((s): s is number => s != null && s > 0).map((s) => s / 3600);
  const baseWakeH = baseNights.map((p) => eveningHours(parseLocal(p.bedtime_end).hours));
  const day = readiness.find((r) => r.day === date);

  return {
    date, event_time: eventTime,
    night: summary,
    hours_awake_at_event: round((eventEpochMs - wake.epochMs) / 3_600_000),
    hours_since_hr_trough: trough ? round((eventEpochMs - trough.epochMs) / 3_600_000) : null,
    sleep_vs_30d_median_h: summary.asleep_h != null && baseSleepH.length ? round(summary.asleep_h - median(baseSleepH)) : null,
    wake_vs_30d_median_h: baseWakeH.length ? round(eveningHours(wake.hours) - median(baseWakeH)) : null,
    readiness_score: day?.score ?? null,
    temp_deviation: day?.temperature_deviation ?? summary.temp_deviation,
  };
}

// ---------------------------------------------------------------- temperature shifts

export interface ShiftOpts { threshold: number; confirm_days: number; baseline_days: number; expected_elevated_days: number }

/**
 * Detects sustained elevations in nightly temperature deviation: a run of `confirm_days`
 * at least `threshold` above the mean of the preceding `baseline_days`, ending when two
 * consecutive days fall back below half the threshold. Reports each elevated phase and
 * flags the current one if it has lasted longer than `expected_elevated_days` + 2.
 */
export function temperatureShifts(readiness: DailyReadiness[], opts: ShiftOpts) {
  const series = readiness
    .filter((r) => r.temperature_deviation != null)
    .sort((a, b) => a.day.localeCompare(b.day))
    .map((r) => ({ day: r.day, dev: r.temperature_deviation as number }));

  const shifts: { shift_day: string; baseline_mean: number | null; elevated_mean: number | null; amplitude: number | null; end_day: string | null; elevated_days: number | null }[] = [];
  let i = opts.baseline_days;
  while (i < series.length) {
    const baselineMean = mean(series.slice(i - opts.baseline_days, i).map((x) => x.dev));
    const window = series.slice(i, i + opts.confirm_days);
    const shifted = window.length === opts.confirm_days && window.every((x) => x.dev >= baselineMean + opts.threshold);
    if (!shifted) { i++; continue; }

    const backToBaseline = (k: number) => series[k].dev < baselineMean + opts.threshold / 2;
    let end: number | null = null;
    for (let j = i + opts.confirm_days; j < series.length - 1; j++) {
      if (backToBaseline(j) && backToBaseline(j + 1)) { end = j; break; }
    }
    const elevated = series.slice(i, end ?? series.length).map((x) => x.dev);
    shifts.push({
      shift_day: series[i].day,
      baseline_mean: round(baselineMean),
      elevated_mean: round(mean(elevated)),
      amplitude: round(mean(elevated) - baselineMean),
      end_day: end != null ? series[end].day : null,
      elevated_days: end != null ? end - i : null,
    });
    i = (end ?? series.length) + 1;
  }

  const last = shifts.at(-1);
  const ongoing = last && !last.end_day ? last : null;
  const daysSince = ongoing ? series.length - series.findIndex((x) => x.day === ongoing.shift_day) : null;
  const extended = daysSince != null && daysSince > opts.expected_elevated_days + 2;
  return {
    days: series.length,
    params: opts,
    shifts,
    current: ongoing ? {
      shift_day: ongoing.shift_day,
      days_since_shift: daysSince,
      extended,
      note: extended
        ? `Temperature still elevated ${daysSince} days after the shift (expected ≤ ${opts.expected_elevated_days}).`
        : "Within expected duration.",
    } : null,
    series,
  };
}

// ---------------------------------------------------------------- daily table

export interface DailyInputs {
  readiness?: DailyReadiness[];
  sleepScores?: DailySleep[];
  activity?: DailyActivity[];
  stress?: DailyStress[];
  spo2?: DailySpo2[];
  sleep?: SleepPeriod[];
}

export type DailyRow = { day: string } & Record<string, unknown>;

/** Merge the daily endpoints into one row per day, sorted by date. Endpoints not supplied contribute no columns. */
export function buildDailyTable(inputs: DailyInputs): DailyRow[] {
  const rows = new Map<string, DailyRow>();
  const upsert = (day: string, fields: Record<string, unknown>) => {
    const row = rows.get(day) ?? { day };
    Object.assign(row, fields);
    rows.set(day, row);
  };
  inputs.readiness?.forEach((r) => upsert(r.day, { readiness: r.score, temp_deviation: r.temperature_deviation, rhr_contrib: r.contributors?.resting_heart_rate ?? null }));
  inputs.sleepScores?.forEach((r) => upsert(r.day, { sleep_score: r.score }));
  inputs.activity?.forEach((r) => upsert(r.day, { activity: r.score, steps: r.steps }));
  inputs.stress?.forEach((r) => upsert(r.day, { stress: r.day_summary, stress_high_min: r.stress_high != null ? Math.round(r.stress_high / 60) : null }));
  inputs.spo2?.forEach((r) => upsert(r.day, { spo2: r.spo2_percentage?.average ?? null }));
  mainSleeps(inputs.sleep ?? []).forEach((p) => upsert(p.day, { lowest_hr: p.lowest_heart_rate, avg_hrv: p.average_hrv, asleep_h: secondsToHours(p.total_sleep_duration) }));
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day));
}

// ---------------------------------------------------------------- baseline drift

interface MetricSpec { name: string; unit: string; absFlag: number; pick: (p: SleepPeriod, readiness?: DailyReadiness) => number | null | undefined }

const DRIFT_METRICS: MetricSpec[] = [
  { name: "lowest_hr", unit: "bpm", absFlag: 3, pick: (p) => p.lowest_heart_rate },
  { name: "avg_hr", unit: "bpm", absFlag: 3, pick: (p) => p.average_heart_rate },
  { name: "avg_hrv", unit: "ms", absFlag: 8, pick: (p) => p.average_hrv },
  { name: "resp_rate", unit: "br/min", absFlag: 0.5, pick: (p) => p.average_breath },
  { name: "temp_deviation", unit: "°C", absFlag: 0.2, pick: (p, r) => r?.temperature_deviation ?? p.readiness?.temperature_deviation },
];
const Z_FLAG = 1.5;

export function baselineDrift(ps: SleepPeriod[], readiness: DailyReadiness[], days: number, window: number) {
  const nights = mainSleeps(ps).sort((a, b) => a.day.localeCompare(b.day));
  const readinessByDay = new Map(readiness.map((r) => [r.day, r]));

  const evaluate = (m: MetricSpec) => {
    const values = nights.map((p) => m.pick(p, readinessByDay.get(p.day))).filter((v): v is number => v != null);
    const recent = values.slice(-window);
    const base = values.slice(0, Math.max(0, values.length - window));
    if (recent.length < 3 || base.length < 7) return { metric: m.name, unit: m.unit, insufficient_data: true };
    const baseMean = mean(base), baseSd = sd(base), recentMean = mean(recent);
    const delta = recentMean - baseMean;
    const z = baseSd > 0 ? delta / baseSd : 0;
    return {
      metric: m.name, unit: m.unit, baseline_n: base.length, recent_n: recent.length,
      baseline_mean: round(baseMean), baseline_sd: round(baseSd), recent_mean: round(recentMean),
      delta: round(delta), z: round(z), flag: Math.abs(z) >= Z_FLAG || Math.abs(delta) >= m.absFlag,
    };
  };

  return { days, window, nights: nights.length, metrics: DRIFT_METRICS.map(evaluate) };
}
