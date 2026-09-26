/** Calendar-day helpers. All days are UTC ISO dates (YYYY-MM-DD); no time zones involved. */

const DAY_MS = 86_400_000;

export const toIsoDay = (d: Date) => d.toISOString().slice(0, 10);
export const parseIsoDay = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const addDays = (day: string, n: number) => toIsoDay(new Date(parseIsoDay(day).getTime() + n * DAY_MS));
export const todayUtc = () => toIsoDay(new Date());

export interface Period {
  from: string;
  to: string;
}

/** The `days`-long period ending on `to` (inclusive), and the equally long period right before it. */
export function periodsFor(days: number, to: string = todayUtc()): { current: Period; previous: Period } {
  const from = addDays(to, -(days - 1));
  return {
    current: { from, to },
    previous: { from: addDays(from, -days), to: addDays(from, -1) },
  };
}

/** Every day in [from, to], inclusive. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}
