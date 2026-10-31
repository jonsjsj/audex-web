// Everything the Stats screen shows, worked out from two daily series: what Audiobookshelf says was listened to
// (seconds per day) and what the reader counted (pages and seconds per day and book). Pure functions, no clock of
// their own — `today` is passed in — so they can be checked with plain data.
//
// Days are "YYYY-MM-DD" strings in the person's own time zone; they are turned into day numbers (UTC midnight / 86400)
// for arithmetic so a daylight-saving change can't shift a day.

export interface ReadingRow {
  day: string;
  itemId: string;
  title: string;
  pages: number;
  seconds: number;
}

export interface ListeningStats {
  totalS: number;
  days: Record<string, number>;
  items: { itemId: string; title: string; s: number }[];
}

export interface StatsData {
  listening: ListeningStats | null;
  reading: ReadingRow[];
}

export interface DayTotal {
  listenS: number;
  pages: number;
  readS: number;
}

export interface Bucket extends DayTotal {
  key: string;
  label: string;
}

export type Grain = "day" | "week" | "month" | "year";

const EMPTY: DayTotal = { listenS: 0, pages: 0, readS: 0 };

export function dayNumber(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayString(n: number): string {
  const d = new Date(n * 86_400_000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** The person's local date, as the key the stats use. */
export function localDay(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(n: number): number {
  return (new Date(n * 86_400_000).getUTCDay() + 6) % 7;
}

const add = (a: DayTotal, b: DayTotal): DayTotal => ({ listenS: a.listenS + b.listenS, pages: a.pages + b.pages, readS: a.readS + b.readS });

/** One total per day, from both series. */
export function perDay(data: StatsData): Map<string, DayTotal> {
  const out = new Map<string, DayTotal>();
  const bump = (day: string, t: DayTotal) => out.set(day, add(out.get(day) ?? EMPTY, t));
  for (const [day, s] of Object.entries(data.listening?.days ?? {})) bump(day, { listenS: s, pages: 0, readS: 0 });
  for (const r of data.reading) bump(r.day, { listenS: 0, pages: r.pages, readS: r.seconds });
  return out;
}

/** The first day of the bucket [day] belongs to, as a day number. */
function bucketStart(n: number, grain: Grain): number {
  if (grain === "day") return n;
  if (grain === "week") return n - weekday(n);
  const d = new Date(n * 86_400_000);
  const y = d.getUTCFullYear();
  const m = grain === "month" ? d.getUTCMonth() : 0;
  return Math.floor(Date.UTC(y, m, 1) / 86_400_000);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function bucketLabel(start: number, grain: Grain): string {
  const d = new Date(start * 86_400_000);
  const y = d.getUTCFullYear();
  const dd = d.getUTCDate();
  const mon = MONTHS[d.getUTCMonth()];
  if (grain === "year") return String(y);
  if (grain === "month") return `${mon} ${y}`;
  if (grain === "week") return `Week of ${dd} ${mon} ${y}`;
  return `${dd} ${mon} ${y}`;
}

/** Totals by day / week / month / year, newest first. */
export function history(days: Map<string, DayTotal>, grain: Grain): Bucket[] {
  const acc = new Map<number, DayTotal>();
  for (const [day, t] of days) {
    const k = bucketStart(dayNumber(day), grain);
    acc.set(k, add(acc.get(k) ?? EMPTY, t));
  }
  return [...acc.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([k, t]) => ({ key: dayString(k), label: bucketLabel(k, grain), ...t }));
}

export interface Periods {
  today: DayTotal;
  week: DayTotal;
  month: DayTotal;
  all: DayTotal;
}

/** Today / this week (Monday on) / this month / all time. */
export function periods(days: Map<string, DayTotal>, today: string): Periods {
  const n = dayNumber(today);
  const weekFrom = n - weekday(n);
  const monthFrom = bucketStart(n, "month");
  const out: Periods = { today: EMPTY, week: EMPTY, month: EMPTY, all: EMPTY };
  for (const [day, t] of days) {
    const d = dayNumber(day);
    out.all = add(out.all, t);
    if (day === today) out.today = add(out.today, t);
    if (d >= weekFrom && d <= n) out.week = add(out.week, t);
    if (d >= monthFrom && d <= n) out.month = add(out.month, t);
  }
  return out;
}

export interface BookTotal {
  itemId: string;
  title: string;
  listenS: number;
  pages: number;
  readS: number;
}

/** Per book: listening from Audiobookshelf, reading from the reader. Books are matched by title (the two sources
 *  know a book by different ids when it is split into an audio and an ebook item), biggest first. */
export function byBook(data: StatsData): BookTotal[] {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const out = new Map<string, BookTotal>();
  const slot = (itemId: string, title: string) => {
    const key = norm(title) || itemId;
    let b = out.get(key);
    if (!b) out.set(key, (b = { itemId, title: title || "Untitled", listenS: 0, pages: 0, readS: 0 }));
    return b;
  };
  for (const i of data.listening?.items ?? []) slot(i.itemId, i.title).listenS += i.s;
  for (const r of data.reading) {
    const b = slot(r.itemId, r.title);
    b.pages += r.pages;
    b.readS += r.seconds;
  }
  return [...out.values()].filter((b) => b.listenS > 0 || b.pages > 0 || b.readS > 0).sort((a, b) => b.listenS + b.readS - (a.listenS + a.readS));
}

export interface Best {
  label: string;
  value: number;
}

export interface Records {
  bestListen: Record<"week" | "month" | "year", Best | null>;
  bestPages: Record<"week" | "month" | "year", Best | null>;
  currentStreak: number;
  longestStreak: number;
  busiestDay: { day: string; listenS: number; pages: number } | null;
  /** Average per weekday, Monday first — how much you usually listen / read on a Monday, a Tuesday… */
  weekdayAvg: { listenS: number; pages: number }[];
  busiestWeekday: number | null;
  /** What an active day looks like (days with any listening or reading). */
  perActiveDay: { listenS: number; pages: number; days: number };
  /** Pages per hour of reading, all time and the last 30 days; null without a reading time to divide by. */
  pace: { all: number | null; last30: number | null };
  /** Share of the time (listening vs reading), 0..1 each, summing to 1; null with neither. */
  split: { listen: number; read: number } | null;
}

/** A day counts towards a streak with a minute of listening or a page read. */
export const isActive = (t: DayTotal) => t.listenS >= 60 || t.pages >= 1;

function best(days: Map<string, DayTotal>, grain: Grain, pick: (t: DayTotal) => number): Best | null {
  let top: Best | null = null;
  for (const b of history(days, grain)) {
    const v = pick(b);
    if (v > 0 && (!top || v > top.value)) top = { label: b.label, value: v };
  }
  return top;
}

export function records(days: Map<string, DayTotal>, today: string): Records {
  const nums = [...days.entries()].filter(([, t]) => isActive(t)).map(([d]) => dayNumber(d)).sort((a, b) => a - b);
  let longest = 0;
  let run = 0;
  let prev = -10;
  for (const n of nums) {
    run = n === prev + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    prev = n;
  }
  const have = new Set(nums);
  const t = dayNumber(today);
  // Not having read yet today doesn't break a streak that ran up to yesterday.
  let cursor = have.has(t) ? t : t - 1;
  let current = 0;
  while (have.has(cursor)) {
    current++;
    cursor--;
  }

  let busiest: Records["busiestDay"] = null;
  const sums = Array.from({ length: 7 }, () => ({ listenS: 0, pages: 0 }));
  const first = nums.length ? nums[0] : t;
  const dayCount = Array.from({ length: 7 }, () => 0);
  for (let n = first; n <= t; n++) dayCount[weekday(n)]++;
  for (const [day, tot] of days) {
    if (!busiest || tot.listenS + tot.pages * 120 > busiest.listenS + busiest.pages * 120) busiest = { day, listenS: tot.listenS, pages: tot.pages };
    const w = weekday(dayNumber(day));
    sums[w].listenS += tot.listenS;
    sums[w].pages += tot.pages;
  }
  const weekdayAvg = sums.map((s, i) => ({ listenS: dayCount[i] ? s.listenS / dayCount[i] : 0, pages: dayCount[i] ? s.pages / dayCount[i] : 0 }));
  let busiestWeekday: number | null = null;
  weekdayAvg.forEach((a, i) => {
    const score = a.listenS + a.pages * 120;
    if (score > 0 && (busiestWeekday === null || score > weekdayAvg[busiestWeekday].listenS + weekdayAvg[busiestWeekday].pages * 120)) busiestWeekday = i;
  });

  let listenSum = 0;
  let pageSum = 0;
  let activeDays = 0;
  let readAll = 0;
  let pagesAll = 0;
  let readRecent = 0;
  let pagesRecent = 0;
  let listenAll = 0;
  for (const [day, tot] of days) {
    listenAll += tot.listenS;
    readAll += tot.readS;
    pagesAll += tot.pages;
    if (dayNumber(day) > t - 30 && dayNumber(day) <= t) {
      readRecent += tot.readS;
      pagesRecent += tot.pages;
    }
    if (tot.listenS > 0 || tot.pages > 0) {
      activeDays++;
      listenSum += tot.listenS;
      pageSum += tot.pages;
    }
  }
  const pace = (pages: number, secs: number) => (secs >= 300 && pages > 0 ? (pages * 3600) / secs : null);
  const total = listenAll + readAll;
  return {
    bestListen: { week: best(days, "week", (b) => b.listenS), month: best(days, "month", (b) => b.listenS), year: best(days, "year", (b) => b.listenS) },
    bestPages: { week: best(days, "week", (b) => b.pages), month: best(days, "month", (b) => b.pages), year: best(days, "year", (b) => b.pages) },
    currentStreak: current,
    longestStreak: longest,
    busiestDay: busiest,
    weekdayAvg,
    busiestWeekday,
    perActiveDay: { listenS: activeDays ? listenSum / activeDays : 0, pages: activeDays ? pageSum / activeDays : 0, days: activeDays },
    pace: { all: pace(pagesAll, readAll), last30: pace(pagesRecent, readRecent) },
    split: total > 0 ? { listen: listenAll / total, read: readAll / total } : null,
  };
}

/** "2 h 05 min", "35 min", "0 min". */
export function formatDuration(totalS: number): string {
  const mins = Math.round(totalS / 60);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h} h` : `${h} h ${String(m).padStart(2, "0")} min`;
}
