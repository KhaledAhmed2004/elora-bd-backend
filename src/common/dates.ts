import { z } from 'zod';

/** Bangladesh is UTC+6 all year (no daylight saving) */
const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const DAY = 86_400_000;

/** "2026-11-13" (Bangladesh calendar day) of an instant */
export const bdDay = (d: Date) =>
  new Date(d.getTime() + BD_OFFSET_MS).toISOString().slice(0, 10);

/** Start of a Bangladesh calendar day ("2026-11-13" → 2026-11-12T18:00Z) */
export const bdDayStart = (day: string) =>
  new Date(new Date(`${day}T00:00:00Z`).getTime() - BD_OFFSET_MS);

/** [from, to) for an inclusive range of Bangladesh days */
export function bdRange(fromDay: string, toDay: string) {
  return {
    gte: bdDayStart(fromDay),
    lt: new Date(bdDayStart(toDay).getTime() + DAY),
  };
}

/** First day of this Bangladesh month, e.g. "2026-11-01" */
export const bdMonthStart = (now = new Date()) =>
  `${bdDay(now).slice(0, 7)}-01`;

/** The last `n` Bangladesh days, oldest first */
export function lastBdDays(n: number, now = new Date()) {
  return Array.from({ length: n }, (_, i) =>
    bdDay(new Date(now.getTime() - (n - 1 - i) * DAY)),
  );
}

/** Optional ?from=YYYY-MM-DD&to=YYYY-MM-DD (Bangladesh days, inclusive) */
export const dateRangeQuery = z
  .object({ from: z.iso.date().optional(), to: z.iso.date().optional() })
  .refine(
    (v) => !v.from || !v.to || v.from <= v.to,
    '"from" must be before "to"',
  );
