// Reading bookmarks, stored the way the Audex app stores them.
//
// A book that has an audiobook edition keeps its bookmarks IN AUDIOBOOKSHELF, as
// a point in the audio: seconds = (how far through the book) × (audio duration).
// That's the Audex app's own scheme (ReaderViewModel.addReadingBookmark), so a
// bookmark made here shows up there and the other way round. ABS bookmarks are
// time-based, so a book with no audio at all has no duration to express one in —
// those are kept by audex-web itself instead (see api/read.py), on this server only.
import { api } from "../api/client";

export interface ReaderBookmark {
  /** Opaque, unique within a store (the audio second for ABS, the row id locally). */
  key: string;
  fraction: number; // 0..1 through the whole book
  title: string;
  createdAt: number | null;
  /** A "Left off" marker dropped automatically on a big jump, not one you made. */
  auto: boolean;
}

export interface BookmarkStore {
  /** True when the bookmarks live in Audiobookshelf (and so reach the Audex app). */
  synced: boolean;
  list(): Promise<ReaderBookmark[]>;
  add(fraction: number, title: string): Promise<void>;
  remove(b: ReaderBookmark): Promise<void>;
}

// Same values and wording as the Audex app (ReaderViewModel.kt), so its markers
// and ours are recognised — and pruned — by both.
export const AUTO_PREFIX = "Left off · ";
/** A jump of more than this fraction of the book auto-drops a "Left off" marker. */
export const JUMP_THRESHOLD = 0.015;
const MAX_AUTO = 5;

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
export const bookmarkTitle = (fraction: number) => `Bookmark · ${Math.round(fraction * 100)}%`;

export function absStore(audioItemId: string, durationS: number): BookmarkStore {
  return {
    synced: true,
    async list() {
      const rows = await api.bookmarks(audioItemId);
      return rows.map((b) => ({
        key: String(b.timeS),
        fraction: clamp01(b.timeS / durationS),
        title: b.title,
        createdAt: b.createdAt,
        auto: b.title.startsWith(AUTO_PREFIX),
      }));
    },
    async add(fraction, title) {
      await api.addBookmark(audioItemId, { timeS: Math.floor(clamp01(fraction) * durationS), title });
    },
    async remove(b) {
      await api.removeBookmark(audioItemId, Number(b.key));
    },
  };
}

export function localStore(itemId: string): BookmarkStore {
  return {
    synced: false,
    async list() {
      const rows = await api.readerBookmarks(itemId);
      return rows.map((b) => ({
        key: String(b.id),
        fraction: clamp01(b.fraction),
        title: b.title,
        createdAt: b.createdAt,
        auto: b.title.startsWith(AUTO_PREFIX),
      }));
    },
    async add(fraction, title) {
      await api.addReaderBookmark(itemId, { fraction: clamp01(fraction), title });
    },
    async remove(b) {
      await api.removeReaderBookmark(itemId, Number(b.key));
    },
  };
}

/** Drop a "Left off" marker at [from] — where you were before a big jump — unless
 *  one is already close by, then keep only the most recent few. Mirrors the Audex
 *  app (autoBookmark): an accidental slider drag should never lose your place. */
export async function dropLeftOff(store: BookmarkStore, existing: ReaderBookmark[], from: number): Promise<void> {
  if (existing.some((b) => b.auto && Math.abs(b.fraction - from) < JUMP_THRESHOLD)) return;
  await store.add(from, `${AUTO_PREFIX}${Math.round(from * 100)}%`);
  const autos = (await store.list()).filter((b) => b.auto).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  for (const old of autos.slice(0, Math.max(0, autos.length - MAX_AUTO))) {
    await store.remove(old).catch(() => {});
  }
}
