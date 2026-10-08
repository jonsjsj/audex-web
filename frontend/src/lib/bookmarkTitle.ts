// The bookmark wording shared with the Audex app (docs/BOOKMARKS.md).
//
// Bookmarks live in Audiobookshelf, so every app (Audex, Webdex, Codex) shows the same ones. Each carries WHEN it
// was made (the time Audiobookshelf stamps on it) and WHERE: the app and device are appended to the title as
// "<note> [via <app> · <unit>]" — the same tag Audex writes and reads (BookmarkTitle in :core:domain).
import { deviceName } from "./platform";

export const APP_NAME = "Webdex";

const TAG = /\s*\[via ([^\]·]+?)(?:\s*·\s*([^\]]+?))?\s*\]\s*$/;

export interface ParsedTitle {
  /** The bookmark's own words, without the tag. */
  note: string;
  /** "Webdex · Chrome on Linux", or just the app — null for a bookmark another client made without a tag. */
  origin: string | null;
}

export function parseTitle(title: string): ParsedTitle {
  const m = TAG.exec(title);
  if (!m) return { note: title.trim(), origin: null };
  const app = m[1].trim();
  const unit = (m[2] ?? "").trim();
  return { note: title.slice(0, m.index).trim(), origin: unit ? `${app} · ${unit}` : app };
}

/** [note] with this app and device appended (brackets in a device name would break the tag, so they go). */
export function tagTitle(note: string, unit: string | null = deviceName()): string {
  const clean = (unit ?? "").replace(/[\[\]·]/g, " ").replace(/\s+/g, " ").trim();
  const base = parseTitle(note).note || "Bookmark";
  return clean ? `${base} [via ${APP_NAME} · ${clean}]` : `${base} [via ${APP_NAME}]`;
}

/** When a bookmark was made, in the browser's own date/time style ("8 Oct 2026, 14:05"); null when unknown. */
export function madeAt(createdAt: number | null | undefined): string | null {
  if (!createdAt || createdAt <= 0) return null;
  return new Date(createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
