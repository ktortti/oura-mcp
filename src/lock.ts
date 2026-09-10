import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomUUID } from "node:crypto";

export interface LockOptions {
  staleMs?: number;    // a lock older than this whose owner is not a live process is assumed abandoned
  timeoutMs?: number;  // give up waiting after this long
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-process mutual exclusion via an O_EXCL lock file. Used around token refresh so two
 * server processes sharing one token file can't both spend the same single-use refresh token.
 *
 * Stale-lock takeover is deliberately conservative: the default window (2 min) is well beyond
 * the 30 s token-exchange timeout; a lock whose owning pid is still alive is never taken over;
 * and the file is re-read immediately before unlinking so a lock that changed hands in the
 * meantime is left alone.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { staleMs = 120_000, timeoutMs = 15_000, wait = defaultWait } = opts;
  const owner = `${process.pid}:${randomUUID()}`;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, owner);
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (tryTakeOverStale(lockPath, staleMs)) continue;
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await wait(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    try { if (readFileSync(lockPath, "utf8") === owner) unlinkSync(lockPath); } catch { /* already gone or not ours */ }
  }
}

/** Remove an abandoned lock. Returns true if the caller should retry acquiring. */
function tryTakeOverStale(lockPath: string, staleMs: number): boolean {
  try {
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age <= staleMs) return false;
    const content = readFileSync(lockPath, "utf8");
    if (isAlive(Number(content.split(":")[0]))) return false;
    if (readFileSync(lockPath, "utf8") !== content) return false; // changed hands between checks
    unlinkSync(lockPath);
    return true;
  } catch {
    return true; // lock vanished mid-check; retry acquiring
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
