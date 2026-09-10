import { test } from "node:test";
import assert from "node:assert/strict";
import { nightRow, seriesRows } from "../src/archive.js";

const period = {
  id: "s1", day: "2026-03-10", type: "long_sleep", bedtime_start: "2026-03-10T01:47:00+02:00", bedtime_end: "2026-03-10T08:23:00+02:00",
  lowest_heart_rate: 50, readiness: { score: 70, temperature_deviation: 0.1, contributors: { hrv_balance: 80 } },
  heart_rate: { interval: 300, timestamp: "2026-03-10T01:47:00.000+02:00", items: [60, null, 58] },
  hrv: { interval: 300, timestamp: "2026-03-10T01:47:00.000+02:00", items: [40, 45, 50] },
  sleep_phase_5_min: "4433",
};

test("seriesRows expands a sample series with local timestamps, keeping nulls", () => {
  const rows = seriesRows(period, "heart_rate");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], { sleep_id: "s1", day: "2026-03-10", sample: 0, timestamp_local: "2026-03-10 01:47:00", offset: "+02:00", value: 60 });
  assert.equal(rows[1].value, null);
  assert.equal(rows[2].timestamp_local, "2026-03-10 01:57:00");
});

test("nightRow flattens one level of nested scalars and drops the sample series", () => {
  const row = nightRow(period);
  assert.equal(row["readiness.score"], 70);
  assert.equal(row["readiness.temperature_deviation"], 0.1);
  assert.equal("readiness.contributors" in row, false, "nested objects two levels down are not flattened");
  assert.equal("heart_rate" in row, false);
  assert.equal(row.sleep_phase_5_min, "4433");
  assert.equal(row.bedtime_local, "2026-03-10 01:47");
  assert.equal(row.offset, "+02:00");
});
