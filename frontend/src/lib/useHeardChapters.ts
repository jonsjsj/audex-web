import { useEffect, useState } from "react";
import { api, HeardChapter } from "../api/client";

/** The chapter names/numbers Codex heard in the narration for one book (see lib/chapters.ts labelChaptersFor).
 *  Empty until the book has been listened to — and on any failure: this is an upgrade over the file's own
 *  titles, never a requirement, so it never shows an error. */
export function useHeardChapters(itemId: string | undefined | null): HeardChapter[] {
  const [heard, setHeard] = useState<HeardChapter[]>([]);
  useEffect(() => {
    setHeard([]);
    if (!itemId) return;
    let cancelled = false;
    api.heardChapters(itemId).then((r) => { if (!cancelled) setHeard(r.chapters ?? []); }).catch(() => {});
    return () => { cancelled = true; };
  }, [itemId]);
  return heard;
}
