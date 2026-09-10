import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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

/**
 * Resolve a user-supplied directory and refuse anything outside `home`. Checked twice: lexically
 * before creating it (so nothing is created outside), and via realpath after (so a symlink placed
 * inside home can't point out).
 */
export function resolveExportDir(dir: string, home = homedir()): string {
  const target = resolve(dir.replace(/^~(?=$|\/)/, home));
  if (!isInside(home, target)) throw new Error("Export path must be inside your home directory.");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  if (!isInside(realpathSync(home), realpathSync(target))) throw new Error("Export path resolves outside your home directory (symlink).");
  return target;
}

/** Write one CSV per entry of `files` into `dir`. Local disk only. */
export function writeCsvs(dir: string, files: Record<string, Record<string, unknown>[]>, home = homedir()): string[] {
  const target = resolveExportDir(dir, home);
  return Object.entries(files).map(([name, rows]) => {
    const p = join(target, `${name}.csv`);
    writeFileSync(p, csv(rows), { mode: 0o600 });
    return p;
  });
}
