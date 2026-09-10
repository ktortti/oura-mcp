import { DailyReadiness, SleepPeriod } from "./client.js";
import { eveningHours, fromEveningHours, fmtHours, hoursBetween, isWeekend, parseLocal } from "./time.js";
import { mean, median, quantile, round, sd } from "./stats.js";

// ---------- sleep period summaries ----------

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

export function lowestHrTime(p: SleepPeriod): string | null {
  const hr = p.heart_rate;
  if (!hr || !hr.items?.length) return null;
  let best = Infinity, idx = -1;
  hr.items.forEach((v, i) => { if (v != null && v < best) { best = v; idx = i; } });
  if (idx < 0) return null;
  const t0 = parseLocal(hr.timestamp);
  const local = new Date(t0.epochMs + idx * hr.interval * 1000);
  // Re-express in the period's local offset
  const offMin = offsetMinutes(t0.offset);
  const shifted = new Date(local.getTime() + offMin * 60_000);
  return `${shifted.toISOString().slice(0, 16).replace("T", " ")}`;
}

function offsetMinutes(off: string): number {
  if (!off || off === "Z") return 0;
  const m = off.match(/([+-])(\d{2}):(\d{2})/); if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
}

export function summariseNight(p: SleepPeriod, withCurve = false): NightSummary {
  const b = parseLocal(p.bedtime_start), w = parseLocal(p.bedtime_end);
  const midH = (eveningHours(b.hours) + (eveningHours(b.hours) + hoursBetween(p.bedtime_start, p.bedtime_end))) / 2;
  const s: NightSummary = {
    day: p.day, type: p.type,
    bedtime: `${b.date} ${b.hhmm}`, wake: `${w.date} ${w.hhmm}`, offset: b.offset,
    midpoint: fmtHours(fromEveningHours(midH)),
    in_bed_h: round((p.time_in_bed ?? 0) / 3600), asleep_h: round((p.total_sleep_duration ?? 0) / 3600),
    efficiency: p.efficiency ?? null, latency_min: p.latency != null ? round(p.latency / 60, 0) : null,
    lowest_hr: p.lowest_heart_rate ?? null, lowest_hr_at: lowestHrTime(p),
    avg_hr: p.average_heart_rate ?? null, avg_hrv: p.average_hrv ?? null, resp_rate: p.average_breath ?? null,
    temp_deviation: p.readiness?.temperature_deviation ?? null,
  };
  if (withCurve && p.heart_rate) s.hr_curve = { start: p.heart_rate.timestamp, interval_s: p.heart_rate.interval, bpm: p.heart_rate.items };
  return s;
}

export const mainSleeps = (ps: SleepPeriod[]) => ps.filter((p) => p.type === "long_sleep");

// ---------- chronotype ----------

export function chronotype(ps: SleepPeriod[]) {
  const nights = mainSleeps(ps);
  const rows = nights.map((p) => {
    const b = parseLocal(p.bedtime_start), w = parseLocal(p.bedtime_end);
    const bed = eveningHours(b.hours);
    const dur = hoursBetween(p.bedtime_start, p.bedtime_end);
    return { day: p.day, bed, wake: bed + dur, mid: bed + dur / 2, dur, weekend: isWeekend(p.day) };
  });
  const stat = (xs: number[]) => ({
    median: fmtHours(fromEveningHours(median(xs))),
    p25: fmtHours(fromEveningHours(quantile(xs, 0.25))),
    p75: fmtHours(fromEveningHours(quantile(xs, 0.75))),
    sd_min: round(sd(xs) * 60, 0),
  });
  const grp = (r: typeof rows) => ({
    n: r.length,
    bedtime: stat(r.map((x) => x.bed)),
    wake: stat(r.map((x) => x.wake)),
    midpoint: stat(r.map((x) => x.mid)),
    in_bed_h: round(median(r.map((x) => x.dur))),
  });
  const wakeMed = median(rows.map((x) => x.wake));
  const midMed = median(rows.map((x) => x.mid));
  return {
    nights: rows.length,
    all: grp(rows),
    weekday: grp(rows.filter((x) => !x.weekend)),
    weekend: grp(rows.filter((x) => x.weekend)),
    regularity_sd_of_midpoint_min: round(sd(rows.map((x) => x.mid)) * 60, 0),
    reference_midpoint_shift_h: round(midMed - eveningHours(3.5)), // vs a ~03:30 population midpoint
    phase_series: rows.map((x) => ({ day: x.day, midpoint: fmtHours(fromEveningHours(x.mid)), shift_h: round(x.mid - midMed, 1) })),
  };
}

// ---------- event context ----------

export function eventContext(date: string, eventTime: string, ps: SleepPeriod[], baseline: SleepPeriod[], readiness: DailyReadiness[]) {
  const candidates = mainSleeps(ps).filter((p) => parseLocal(p.bedtime_end).date === date);
  const night = candidates.sort((a, b) => (b.total_sleep_duration ?? 0) - (a.total_sleep_duration ?? 0))[0];
  if (!night) return { date, error: `No main sleep period ending on ${date}.` };
  const s = summariseNight(night, false);
  const wake = parseLocal(night.bedtime_end);
  const eventIso = `${date}T${eventTime}:00${wake.offset}`;
  const hoursAwake = hoursBetween(night.bedtime_end, eventIso);
  const trough = lowestHrTime(night);
  const hoursSinceTrough = trough ? hoursBetween(`${trough.replace(" ", "T")}:00${wake.offset}`, eventIso) : null;
  const baseDur = mainSleeps(baseline).map((p) => (p.total_sleep_duration ?? 0) / 3600).filter((x) => x > 0);
  const baseWake = mainSleeps(baseline).map((p) => eveningHours(parseLocal(p.bedtime_end).hours) );
  const r = readiness.find((x) => x.day === date);
  return {
    date, event_time: eventTime,
    night: s,
    hours_awake_at_event: round(hoursAwake),
    hours_since_hr_trough: round(hoursSinceTrough ?? NaN),
    sleep_vs_30d_median_h: baseDur.length ? round((s.asleep_h ?? 0) - median(baseDur)) : null,
    wake_vs_30d_median_h: baseWake.length ? round(eveningHours(wake.hours) - median(baseWake)) : null,
    readiness_score: r?.score ?? null,
    temp_deviation: r?.temperature_deviation ?? s.temp_deviation,
  };
}

// ---------- temperature shifts ----------

export interface ShiftOpts { threshold: number; confirm_days: number; baseline_days: number; expected_elevated_days: number; }

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
  const shifts: { shift_day: string; baseline_mean: number; elevated_mean: number | null; amplitude: number | null; end_day: string | null; elevated_days: number | null }[] = [];
  let i = opts.baseline_days;
  while (i < series.length) {
    const base = series.slice(i - opts.baseline_days, i).map((x) => x.dev);
    const bm = mean(base);
    const win = series.slice(i, i + opts.confirm_days);
    if (win.length === opts.confirm_days && win.every((x) => x.dev >= bm + opts.threshold)) {
      let j = i + opts.confirm_days, end: number | null = null;
      while (j < series.length - 1) {
        if (series[j].dev < bm + opts.threshold / 2 && series[j + 1].dev < bm + opts.threshold / 2) { end = j; break; }
        j++;
      }
      const elevated = series.slice(i, end ?? series.length).map((x) => x.dev);
      shifts.push({
        shift_day: series[i].day, baseline_mean: round(bm)!,
        elevated_mean: round(mean(elevated)), amplitude: round(mean(elevated) - bm),
        end_day: end != null ? series[end].day : null,
        elevated_days: end != null ? end - i : null,
      });
      i = (end ?? series.length) + 1;
    } else i++;
  }
  const last = shifts[shifts.length - 1];
  const daysSince = last && !last.end_day ? series.length - series.findIndex((x) => x.day === last.shift_day) : null;
  const extended = daysSince != null && daysSince > opts.expected_elevated_days + 2;
  return {
    days: series.length, params: opts,
    shifts,
    current: last && !last.end_day ? {
      shift_day: last.shift_day, days_since_shift: daysSince, extended,
      note: extended
        ? `Temperature still elevated ${daysSince} days after the shift (expected ≤ ${opts.expected_elevated_days}).`
        : "Within expected duration.",
    } : null,
    series,
  };
}

// ---------- baseline drift ----------

export function baselineDrift(ps: SleepPeriod[], readiness: DailyReadiness[], days: number, window: number) {
  const nights = mainSleeps(ps).sort((a, b) => a.day.localeCompare(b.day));
  const byDay = new Map(readiness.map((r) => [r.day, r]));
  const metric = (name: string, pick: (p: SleepPeriod) => number | null | undefined, absFlag: number, unit: string) => {
    const xs = nights.map((p) => ({ day: p.day, v: pick(p) })).filter((x) => x.v != null) as { day: string; v: number }[];
    const recent = xs.slice(-window).map((x) => x.v);
    const base = xs.slice(0, Math.max(0, xs.length - window)).map((x) => x.v);
    if (recent.length < 3 || base.length < 7) return { metric: name, unit, insufficient_data: true };
    const bm = mean(base), bs = sd(base), rm = mean(recent);
    const delta = rm - bm, z = bs > 0 ? delta / bs : 0;
    return {
      metric: name, unit, baseline_n: base.length, recent_n: recent.length,
      baseline_mean: round(bm), baseline_sd: round(bs), recent_mean: round(rm),
      delta: round(delta), z: round(z), flag: Math.abs(z) >= 1.5 || Math.abs(delta) >= absFlag,
    };
  };
  return {
    days, window, nights: nights.length,
    metrics: [
      metric("lowest_hr", (p) => p.lowest_heart_rate, 3, "bpm"),
      metric("avg_hr", (p) => p.average_heart_rate, 3, "bpm"),
      metric("avg_hrv", (p) => p.average_hrv, 8, "ms"),
      metric("resp_rate", (p) => p.average_breath, 0.5, "br/min"),
      metric("temp_deviation", (p) => byDay.get(p.day)?.temperature_deviation ?? p.readiness?.temperature_deviation, 0.2, "°C"),
    ],
  };
}
