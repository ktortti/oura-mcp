import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock } from "../src/lock.js";

const lockPath = () => join(mkdtempSync(join(tmpdir(), "oura-lock-")), "tokens.json.lock");

test("critical sections under the same lock do not overlap", async () => {
  const p = lockPath();
  const events: string[] = [];
  const section = (name: string) => withFileLock(p, async () => {
    events.push(`${name}:in`);
    await new Promise((r) => setTimeout(r, 20));
    events.push(`${name}:out`);
  }, { wait: (ms) => new Promise((r) => setTimeout(r, ms / 10)) });
  await Promise.all([section("a"), section("b")]);
  assert.deepEqual(events.slice(0, 2).map((e) => e.split(":")[1]), ["in", "out"], `overlap: ${events.join(" ")}`);
  assert.equal(existsSync(p), false, "lock released");
});

test("an abandoned lock older than staleMs is taken over", async () => {
  const p = lockPath();
  writeFileSync(p, "dead-pid");
  const old = new Date(Date.now() - 120_000);
  utimesSync(p, old, old);
  const result = await withFileLock(p, async () => "ran", { staleMs: 30_000 });
  assert.equal(result, "ran");
});

test("a live lock that never releases times out with a clear error", async () => {
  const p = lockPath();
  writeFileSync(p, "live-pid");
  await assert.rejects(withFileLock(p, async () => "never", { staleMs: 60_000, timeoutMs: 100, wait: (ms) => new Promise((r) => setTimeout(r, ms / 10)) }), /Timed out waiting for lock/);
});
