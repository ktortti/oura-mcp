import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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

const backdate = (p: string, ms: number) => { const t = new Date(Date.now() - ms); utimesSync(p, t, t); };

test("an old lock whose owner process is gone is taken over", async () => {
  const p = lockPath();
  writeFileSync(p, "999999999:dead");
  backdate(p, 300_000);
  const result = await withFileLock(p, async () => "ran", { staleMs: 120_000 });
  assert.equal(result, "ran");
  assert.equal(existsSync(p), false);
});

test("an old lock whose owner process is still alive is never taken over", async () => {
  const p = lockPath();
  writeFileSync(p, `${process.pid}:live`);
  backdate(p, 300_000);
  await assert.rejects(withFileLock(p, async () => "never", { staleMs: 10, timeoutMs: 100, wait: (ms) => new Promise((r) => setTimeout(r, ms / 10)) }), /Timed out/);
  assert.equal(existsSync(p), true, "lock left in place");
});

test("the lock file records an owner and only the owner removes it", async () => {
  const p = lockPath();
  await withFileLock(p, async () => {
    const content = readFileSync(p, "utf8");
    assert.match(content, new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
    writeFileSync(p, "someone-else:x"); // simulate a takeover mid-section
  });
  assert.equal(existsSync(p), true, "a lock now owned by someone else is not unlinked");
});

test("a live lock that never releases times out with a clear error", async () => {
  const p = lockPath();
  writeFileSync(p, "live-pid");
  await assert.rejects(withFileLock(p, async () => "never", { staleMs: 60_000, timeoutMs: 100, wait: (ms) => new Promise((r) => setTimeout(r, ms / 10)) }), /Timed out waiting for lock/);
});
