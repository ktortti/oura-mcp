import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineDrift, chronotype, eventContext, lowestHrTime, summariseNight, temperatureShifts } from "../src/analysis.js";
import type { DailyReadiness, SleepPeriod } from "../src/client.js";

const night = (day: string, start: string, end: string, extra: Partial<SleepPeriod> = {}): SleepPeriod => ({
  id: day, day, type: "long_sleep", bedtime_start: start, bedtime_end: end,
  total_sleep_duration: 5 * 3600 + 46 * 60, time_in_bed: 6 * 3600 + 28 * 60, efficiency: 89, latency: 600,
  lowest_heart_rate: 50, average_heart_rate: 56, average_hrv: 60, average_breath: 14, ...extra,
});

// Synthetic short night: asleep 01:47, awake 08:23, lowest HR at index 40 of the 5-min curve.
const shortNight = night("2026-03-10", "2026-03-10T01:47:00+02:00", "2026-03-10T08:23:00+02:00", {
  total_sleep_duration: 5 * 3600 + 52 * 60, time_in_bed: 6 * 3600 + 36 * 60,
  heart_rate: { interval: 300, timestamp: "2026-03-10T01:47:00+02:00", items: Array.from({ length: 80 }, (_, i) => (i === 40 ? 50 : 58)) },
  readiness: { score: 70, temperature_deviation: 0.1 },
});

test("summariseNight keeps local wall time and finds lowest HR time", () => {
  const s = summariseNight(shortNight);
  assert.equal(s.bedtime, "2026-03-10 01:47");
  assert.equal(s.wake, "2026-03-10 08:23");
  assert.equal(s.asleep_h, 5.87);
  assert.equal(s.midpoint, "05:05");
  assert.equal(lowestHrTime(shortNight), "2026-03-10 05:07"); // 01:47 + 40×5 min
});

test("eventContext computes hours awake and sleep delta", () => {
  const base = Array.from({ length: 30 }, (_, i) => night(`2026-06-${String(i + 1).padStart(2, "0")}`, `2026-06-${String(i + 1).padStart(2, "0")}T01:30:00+03:00`, `2026-06-${String(i + 1).padStart(2, "0")}T09:30:00+03:00`, { total_sleep_duration: 8 * 3600 }));
  const r = eventContext("2026-03-10", "10:10", [shortNight], base, [{ day: "2026-03-10", score: 70, temperature_deviation: 0.1, temperature_trend_deviation: 0 }]) as any;
  assert.equal(r.hours_awake_at_event, 1.78);
  assert.equal(r.sleep_vs_30d_median_h, -2.13);
  assert.equal(r.readiness_score, 70);
});

test("chronotype medians and plateau", () => {
  const ps = Array.from({ length: 20 }, (_, i) => {
    const d = `2026-08-${String(i + 1).padStart(2, "0")}`;
    return night(d, `${d}T00:52:00+03:00`, `${d}T08:52:00+03:00`);
  });
  const c = chronotype(ps);
  assert.equal(c.all.bedtime.median, "00:52");
  assert.equal(c.all.wake.median, "08:52");
  assert.equal(c.all.midpoint.median, "04:52");
  assert.equal(c.reference_midpoint_shift_h, 1.37);
});

test("temperatureShifts detects a sustained elevation and its duration", () => {
  const days: DailyReadiness[] = [];
  for (let i = 0; i < 30; i++) {
    const d = `2026-08-${String(i + 1).padStart(2, "0")}`;
    const dev = i < 14 ? 0.0 : i < 30 ? 0.35 : 0;      // shift on day 15, still elevated at end
    days.push({ day: d, score: 80, temperature_deviation: dev + (i % 2 ? 0.02 : -0.02), temperature_trend_deviation: 0 });
  }
  const r = temperatureShifts(days, { threshold: 0.2, confirm_days: 3, baseline_days: 6, expected_elevated_days: 14 });
  assert.equal(r.shifts.length, 1);
  assert.equal(r.shifts[0].shift_day, "2026-08-15");
  assert.ok(r.shifts[0].amplitude! > 0.3);
  assert.equal(r.current?.days_since_shift, 16);
  assert.equal(r.current?.extended, false); // 16 ≤ 14 + 2
});

test("baselineDrift flags a resting-HR rise", () => {
  const ps: SleepPeriod[] = [];
  for (let i = 0; i < 30; i++) {
    const d = `2026-08-${String(i + 1).padStart(2, "0")}`;
    ps.push(night(d, `${d}T01:00:00+03:00`, `${d}T09:00:00+03:00`, { lowest_heart_rate: i < 23 ? 50 + (i % 3) : 56, average_hrv: 60 }));
  }
  const r = baselineDrift(ps, [], 30, 7) as any;
  const lhr = r.metrics.find((m: any) => m.metric === "lowest_hr");
  assert.equal(lhr.flag, true);
  assert.ok(lhr.delta >= 4);
  const hrv = r.metrics.find((m: any) => m.metric === "avg_hrv");
  assert.equal(hrv.flag, false);
});
