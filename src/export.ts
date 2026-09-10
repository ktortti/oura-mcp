import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

function csv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const cols = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const esc = (v: unknown) => { const s = v == null ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n";
}

/** Writes CSVs under a directory the user chose. Refuses paths outside the home directory. */
export function writeCsvs(dir: string, files: Record<string, Record<string, unknown>[]>): string[] {
  const target = resolve(dir.replace(/^~(?=$|\/)/, homedir()));
  if (!target.startsWith(homedir())) throw new Error("Export path must be inside your home directory.");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  const written: string[] = [];
  for (const [name, rows] of Object.entries(files)) {
    const p = join(target, `${name}.csv`);
    writeFileSync(p, csv(rows), { mode: 0o600 });
    written.push(p);
  }
  return written;
}
