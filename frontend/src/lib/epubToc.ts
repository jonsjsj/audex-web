// An ebook's table of contents keyed by chapter FILE — the key the word-sync map's chapters use.
// Mirrors EpubToc.titlesByFile in the Audex app; here the server has already parsed the EPUB, so this reads the
// manifest's nested `toc` ({ title, href, children }) instead of the nav/NCX document.

/** chapter file name (no directory, no #fragment) → the contents entry's name. The first entry for a file wins. */
export function tocTitlesByFile(rawToc: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (entries: unknown) => {
    if (!Array.isArray(entries)) return;
    for (const e of entries as { title?: unknown; href?: unknown; children?: unknown }[]) {
      if (typeof e?.href === "string" && typeof e.title === "string") {
        const file = e.href.split("#")[0].split("/").pop() ?? "";
        const title = e.title.replace(/\s+/g, " ").trim();
        if (file && title && !(file in out)) out[file] = title;
      }
      walk(e?.children);
    }
  };
  walk(rawToc);
  return out;
}
