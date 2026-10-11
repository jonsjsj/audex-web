import { api, ReadiumLocator, SyncMap } from "../api/client";
import { timeAtPage, timeAtProgression } from "./syncMap";

// A saved locator and the whole-book % that sits beside it are written together; when they differ by more than this,
// another client has moved the position since and the locator is stale (same threshold the reader uses to open).
const LOCATOR_AGREES = 0.02;

/** The reader saves the first text on the page next to the locator ("pageStart"), so the audio can start at that very
 *  sentence instead of a guess from how far down the chapter the page sits (docs/SYNC_API.md §3). */
export function pageStartOf(locator: ReadiumLocator | null | undefined): string | null {
  const v = (locator as { pageStart?: unknown } | null | undefined)?.pageStart;
  return typeof v === "string" && v.trim() ? v : null;
}

/** The audio second at which the saved reading position is narrated — page-exact when the saved locator is ours and
 *  still current, else through the whole-book [progress] fraction. Null without a map position for either. */
export function audioTimeOfReading(map: SyncMap, locator: ReadiumLocator | null | undefined, progress: number): number | null {
  const loc = locator as { href?: unknown; locations?: { progression?: unknown; totalProgression?: unknown } } | null | undefined;
  const href = typeof loc?.href === "string" ? loc.href : null;
  const progression = typeof loc?.locations?.progression === "number" ? loc.locations.progression : null;
  const total = typeof loc?.locations?.totalProgression === "number" ? loc.locations.totalProgression : null;
  if (href && progression !== null && total !== null && Math.abs(total - progress) <= LOCATOR_AGREES) {
    const exact = timeAtPage(map, href, progression, pageStartOf(locator));
    if (exact !== null) return exact;
  }
  return timeAtProgression(map, progress);
}

/** [audioTimeOfReading] for a book's saved reading position, fetched from the server. A failed fetch falls back to the
 *  whole-book fraction, which the caller already has. */
export async function audioTimeOfSavedReading(map: SyncMap, ebookItemId: string, progress: number): Promise<number | null> {
  const saved = await api.readPosition(ebookItemId).catch(() => null);
  return audioTimeOfReading(map, saved?.locator, progress);
}
