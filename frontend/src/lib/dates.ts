/** The one way Audex Web writes a date: the browser's own regional format (05.01.2026 in Norway, 1/5/2026 in the US),
 *  never a hand-built "2026-01-05". Unknown or invalid input gives "". */
function toDate(value: string | number | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDay(value: string | number | null | undefined): string {
  const d = toDate(value);
  return d ? d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit", year: "numeric" }) : "";
}

export function formatDayTime(value: string | number | null | undefined): string {
  const d = toDate(value);
  return d
    ? `${formatDay(value)} ${d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
    : "";
}
