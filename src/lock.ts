import { closeSync, openSync, statSync, unlinkSync, writeSync } from "node:fs";

export interface LockOptions {
  staleMs?: number;    // a lock older than this is assumed abandoned and removed
  timeoutMs?: number;  // give up waiting after this long
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Cross-process mutual exclusion via an O_EXCL lock file. Used around token refresh so two
 * server processes sharing one token file can't both spend the same single-use refresh token.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, opts: LockOptions = {}): Promise<T> {
  const { staleMs = 30_000, timeoutMs = 15_000, wait = defaultWait } = opts;
  const started = Date.now();
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
      } catch { /* lock vanished between checks; loop and retry */ }
      if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for lock ${lockPath}`);
      await wait(50 + Math.random() * 100);
    }
  }
  try {
    return await fn();
  } finally {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}
