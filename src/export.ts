import { closeSync, constants, existsSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

const isInside = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/** Deepest ancestor of `p` that exists on disk (possibly `p` itself). */
function existingAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const up = dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return cur;
}

/**
 * Resolve a user-supplied directory and refuse anything outside `home`, without creating
 * anything outside it either: the lexical check runs first, then the nearest existing ancestor
 * is realpath'd (so a symlink already on the path can't point out) before mkdir, and the final
 * directory is realpath'd again after.
 */
export function resolveExportDir(dir: string, home = homedir()): string {
  const target = resolve(dir.replace(/^~(?=$|\/)/, home));
  if (!isInside(home, target)) throw new Error("Export path must be inside your home directory.");
  const realHome = realpathSync(home);
  if (!isInside(realHome, realpathSync(existingAncestor(target)))) throw new Error("Export path resolves outside your home directory (symlink).");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!isInside(realHome, realpathSync(target))) throw new Error("Export path resolves outside your home directory (symlink).");
  return target;
}

/** Create-or-truncate without following a symlink at the final component (POSIX O_NOFOLLOW). */
function writePrivateFile(path: string, text: string): void {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | noFollow, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`Refusing to write through a symlink: ${path}`);
    throw e;
  }
  try { writeSync(fd, text); } finally { closeSync(fd); }
}

/** Write one CSV per entry of `files` into `dir`. Local disk only. */
export function writeCsvs(dir: string, files: Record<string, Record<string, unknown>[]>, home = homedir()): string[] {
  const target = resolveExportDir(dir, home);
  return Object.entries(files).map(([name, rows]) => {
    const p = join(target, `${name}.csv`);
    writePrivateFile(p, csv(rows));
    return p;
  });
}
