/**
 * Oura timestamps carry the ring's local offset, e.g. "2026-03-10T01:47:00+02:00".
 * We keep wall-clock local time from the string itself rather than converting through
 * the machine's zone, so a night recorded in New York reads as New York time.
 */

export interface LocalTime {
  iso: string;        // original string
  date: string;       // YYYY-MM-DD (local)
  hhmm: string;       // HH:MM (local)
  hours: number;      // decimal hours since local midnight
  offset: string;     // "+03:00"
  epochMs: number;    // absolute instant
}

export function parseLocal(iso: string): LocalTime {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?(Z|[+-]\d{2}:\d{2})?$/);
  if (!m) throw new Error(`Unparseable timestamp: ${iso}`);
  const [, date, hh, mm, ss, off] = m;
  const hours = Number(hh) + Number(mm) / 60 + (ss ? Number(ss) / 3600 : 0);
  return {
    iso,
    date,
    hhmm: `${hh}:${mm}`,
    hours,
    offset: off ?? "",
    epochMs: new Date(iso).getTime(),
  };
}

/** Hours between two absolute instants (b - a). */
export function hoursBetween(aIso: string, bIso: string): number {
  return (new Date(bIso).getTime() - new Date(aIso).getTime()) / 3_600_000;
}

/** Bedtime as hours relative to 18:00 the previous evening, so 23:30 → 5.5 and 01:30 → 7.5. */
export function eveningHours(hours: number): number {
  return hours >= 18 ? hours - 18 : hours + 6;
}
export function fromEveningHours(h: number): number {
  const x = h + 18;
  return x >= 24 ? x - 24 : x;
}

export function fmtHours(h: number): string {
  const total = Math.round(((h % 24) + 24) % 24 * 60);
  const H = Math.floor(total / 60), M = total % 60;
  return `${String(H).padStart(2, "0")}:${String(M).padStart(2, "0")}`;
}

/** Format an absolute instant as "YYYY-MM-DD HH:MM" in the given fixed offset (e.g. "+03:00"). */
export function formatInOffset(epochMs: number, offset: string): string {
  const m = offset.match(/^([+-])(\d{2}):(\d{2})$/);
  const offsetMin = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  return new Date(epochMs + offsetMin * 60_000).toISOString().slice(0, 16).replace("T", " ");
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** True for a real calendar date in YYYY-MM-DD form (rejects 2026-13-45 and 2026-02-30). */
export function isValidDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((new Date(`${b}T00:00:00Z`).getTime() - new Date(`${a}T00:00:00Z`).getTime()) / 86_400_000);
}

export function isWeekend(date: string): boolean {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return dow === 0 || dow === 6;
}
