import { useEffect, useMemo, useState } from "react";
import { api, Chapter, HeardChapter, SyncMap } from "../api/client";
import { countHeard, isGenericChapterList, labelChaptersFor, LabeledChapter } from "./chapters";
import { tocTitlesByFile } from "./epubToc";
import { titledChapterStarts } from "./syncMap";

// One ebook's contents, fetched once per page load however many components ask.
const tocCache = new Map<string, Promise<Record<string, string>>>();
function ebookToc(ebookItemId: string): Promise<Record<string, string>> {
  let p = tocCache.get(ebookItemId);
  if (!p) {
    p = api.readManifest(ebookItemId).then((m) => tocTitlesByFile(m.toc));
    p.catch(() => tocCache.delete(ebookItemId)); // let a later render retry a failed fetch
    tocCache.set(ebookItemId, p);
  }
  return p;
}

/** Whether a book's chapters may be renamed from its ebook — only a list that merely counts ("Chapter 1 … 78") that
 *  Codex has not already named by listening (docs/CHAPTERS.md "Named from the ebook"). The caller uses it to decide
 *  whether to fetch the read-along map at all. */
export function wantsEbookNames(chapters: Chapter[], heard: HeardChapter[]): boolean {
  return isGenericChapterList(chapters.map((c) => c.title)) && countHeard(chapters, heard) * 2 <= chapters.length;
}

/** A book's chapters and their labels ("Chapter 33: The Gate").
 *
 *  Normally the file's own chapters, with the names Codex heard in the narration laid over them. When the file only
 *  counts its chapters ("Chapter 1 … Chapter 78", credits and book summary included, so the book's chapter 1 shows as
 *  Chapter 3) and the book has an ebook and a read-along map, the chapters are instead the ebook's own contents,
 *  placed where the map says each one is spoken — same as the Audex app. Anything missing (no ebook, no map yet, a
 *  failed fetch) leaves the chapters exactly as the file has them. */
export function useBookChapters(args: {
  chapters: Chapter[];
  heard: HeardChapter[];
  ebookItemId: string | null | undefined;
  map: SyncMap | null;
}): { chapters: Chapter[]; labels: LabeledChapter[] } {
  const { chapters, heard, ebookItemId, map } = args;
  const wanted = !!ebookItemId && !!map && wantsEbookNames(chapters, heard);
  const [toc, setToc] = useState<{ id: string; titles: Record<string, string> } | null>(null);

  useEffect(() => {
    if (!wanted || !ebookItemId) return;
    let cancelled = false;
    ebookToc(ebookItemId)
      .then((titles) => { if (!cancelled) setToc({ id: ebookItemId, titles }); })
      .catch(() => {}); // an upgrade over the file's titles, never a requirement
    return () => { cancelled = true; };
  }, [wanted, ebookItemId]);

  return useMemo(() => {
    let effective = chapters;
    if (wanted && map && toc && toc.id === ebookItemId) {
      const starts = titledChapterStarts(map, toc.titles);
      if (starts.length >= 3) {
        const endS = chapters.length > 0 ? chapters[chapters.length - 1].endS : map.durationS;
        effective = starts.map((s, i) => ({
          id: i,
          title: s.title,
          startS: s.startS,
          endS: i + 1 < starts.length ? starts[i + 1].startS : Math.max(endS, s.startS),
        }));
      }
    }
    return { chapters: effective, labels: labelChaptersFor(effective.map((c) => ({ title: c.title, startS: c.startS })), heard) };
  }, [chapters, heard, wanted, map, toc, ebookItemId]);
}
