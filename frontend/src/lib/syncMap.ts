import { SyncMap } from "../api/client";

// Mirrors codexaudio's domain/reader/Alignment.kt SyncMap extension functions
// exactly (progressionAt/timeAtProgression) — same binary search, same
// interpolation, same edge-case handling — so a book's read-along behaves
// identically whether you're on the phone or in the browser. See
// docs/SYNC_API.md §3 for the map format itself.

/** The audio second at which book progression [p] (0..1 of the whole text)
 *  is narrated — for jumping the AUDIOBOOK to where you're READING. */
export function timeAtProgression(map: SyncMap, p: number): number | null {
  const entries = map.entries;
  if (entries.length === 0) return null;
  if (p <= entries[0].p) return entries[0].t0;
  if (p >= entries[entries.length - 1].p) return entries[entries.length - 1].t0;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].p <= p) lo = mid;
    else hi = mid;
  }
  const a = entries[lo];
  const b = entries[hi];
  const span = b.p - a.p;
  if (span <= 0) return a.t0;
  const f = clamp((p - a.p) / span, 0, 1);
  return a.t0 + (b.t0 - a.t0) * f;
}

/** Book progression (0..1) at audio second [seconds] — for following the
 *  page while LISTENING, or jumping the reader to where the audio is. */
export function progressionAt(map: SyncMap, seconds: number): number | null {
  const entries = map.entries;
  if (entries.length === 0) return null;
  if (seconds <= entries[0].t0) return entries[0].p;
  if (seconds >= entries[entries.length - 1].t0) return entries[entries.length - 1].p;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].t0 <= seconds) lo = mid;
    else hi = mid;
  }
  const a = entries[lo];
  const b = entries[hi];
  const span = b.t0 - a.t0;
  if (span <= 0) return a.p;
  const f = clamp((seconds - a.t0) / span, 0, 1);
  return a.p + (b.p - a.p) * f;
}

/** The entry being narrated at [seconds] (nearest at-or-before by start
 *  time) — the anchor to highlight while audio is playing. */
export function entryAt(map: SyncMap, seconds: number): SyncMapEntryOrNull {
  const entries = map.entries;
  if (entries.length === 0 || seconds < entries[0].t0) return null;
  let lo = 0;
  let hi = entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (entries[mid].t0 <= seconds) lo = mid;
    else hi = mid - 1;
  }
  return entries[lo];
}

type SyncMapEntryOrNull = SyncMap["entries"][number] | null;

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}
