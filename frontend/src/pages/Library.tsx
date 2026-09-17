import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Book } from "../api/client";
import { useShell } from "../components/Shell";
import { yearOf } from "../lib/groupSort";

// A book you own but haven't opened yet — the "unread" shelf. Started-and-
// unfinished books belong to "In progress", finished ones to neither.
function isUnread(b: Book): boolean {
  return b.progress <= 0.001 && !b.isFinished;
}

function formatDuration(s: number | null): string | null {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// Mirrors the mobile app's Continue rule: a book only belongs there while
// it's genuinely partway through, not merely "touched" (a stray 0% sync) and
// not already finished (finishing on ebook shouldn't re-surface the same
// work just because its audio edition has separate, lower progress here —
// same reasoning, simpler in audex-web since Player/Reader are already
// separate per-format routes rather than one cross-edition detail screen).
function isContinuable(b: Book): boolean {
  return b.progress > 0.001 && b.progress < 0.999 && !b.isFinished;
}

const CONTINUE_LIMIT = 6;

type SortKey = "title" | "author" | "released" | "added" | "duration" | "progress";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "released", label: "Release date" },
  { key: "added", label: "Recently added" },
  { key: "duration", label: "Duration" },
  { key: "progress", label: "Progress" },
];

// Mirrors the mobile app's WorkFilter (LibraryViewModel.kt), plus "both" —
// specifically the books eligible for read-along (needs both formats on one
// item), which didn't have its own filter before.
type FilterKey = "all" | "audio" | "ebook" | "both" | "progress" | "unread";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All formats" },
  { key: "audio", label: "Audiobook" },
  { key: "ebook", label: "Ebook" },
  { key: "both", label: "Audio + ebook" },
  { key: "progress", label: "In progress" },
  { key: "unread", label: "Unread" },
];

function filterBooks(books: Book[], key: FilterKey): Book[] {
  switch (key) {
    case "audio":
      return books.filter((b) => b.numAudioFiles > 0);
    case "ebook":
      return books.filter((b) => b.hasEbook);
    case "both":
      return books.filter((b) => b.numAudioFiles > 0 && b.hasEbook);
    case "progress":
      return books.filter(isContinuable);
    case "unread":
      return books.filter(isUnread);
    case "all":
    default:
      return books;
  }
}

function sortBooks(books: Book[], key: SortKey): Book[] {
  const arr = [...books];
  switch (key) {
    case "author":
      return arr.sort((a, b) => (a.author ?? "").localeCompare(b.author ?? "") || a.title.localeCompare(b.title));
    case "released":
      return arr.sort((a, b) => yearOf(b) - yearOf(a) || a.title.localeCompare(b.title));
    case "added":
      return arr.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));
    case "duration":
      return arr.sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
    case "progress":
      return arr.sort((a, b) => b.progress - a.progress);
    case "title":
    default:
      return arr.sort((a, b) => a.title.localeCompare(b.title));
  }
}

export default function Library() {
  const navigate = useNavigate();
  const { libraryId, error: shellError, search, resetSignal } = useShell();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [sort, setSort] = useState<SortKey>("title");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [error, setError] = useState<string | null>(null);
  const [alignMap, setAlignMap] = useState<Record<string, boolean>>({});

  // "Back to start" (brand click) resets the local view controls to defaults;
  // the search itself is cleared by the shell that owns it.
  useEffect(() => {
    if (resetSignal === 0) return; // initial mount — leave the defaults as-is
    setSort("title");
    setFilter("all");
  }, [resetSignal]);

  useEffect(() => {
    if (!libraryId) return;
    setBooks(null);
    const handle = setTimeout(() => {
      api
        .items(libraryId, search)
        .then((res) => setBooks(res.items))
        .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this library."));
    }, search ? 250 : 0); // debounce typing, but load the initial list instantly
    return () => clearTimeout(handle);
  }, [libraryId, search]);

  // Read-along availability for the whole library in one call — powers the
  // grid cards' third icon. Best-effort: a failed/slow fetch just leaves
  // every card showing "not yet built" rather than blocking the page.
  useEffect(() => {
    if (!libraryId) return;
    api.readAlongBulkStatus(libraryId).then(setAlignMap).catch(() => {});
  }, [libraryId]);

  // Fire-and-forget: no optimistic flip to "available" (it isn't yet — this
  // only starts the build), and no per-card loading state to keep simple —
  // re-visiting the library page after a while picks up the finished result
  // via the bulk-status fetch above.
  function requestAlign(itemId: string) {
    api.readAlongBuild(itemId).catch(() => {});
  }

  const continueBooks = useMemo(() => {
    if (!books || search) return []; // a search result isn't the place for a Continue rail
    return books
      .filter(isContinuable)
      .sort((a, b) => (b.lastUpdate ?? 0) - (a.lastUpdate ?? 0))
      .slice(0, CONTINUE_LIMIT);
  }, [books, search]);

  const sortedBooks = useMemo(
    () => (books ? sortBooks(filterBooks(books, filter), sort) : null),
    [books, sort, filter],
  );

  return (
    <div className="lib">
      <header className="lib-head">
        <select className="lib-sort" value={filter} onChange={(e) => setFilter(e.target.value as FilterKey)} aria-label="Filter">
          {FILTERS.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <select className="lib-sort" value={sort} onChange={(e) => setSort(e.target.value as SortKey)} aria-label="Sort by">
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>
              Sort: {s.label}
            </option>
          ))}
        </select>
      </header>

      {(shellError || error) && <div className="error" style={{ margin: "1rem 1.5rem" }}>{shellError || error}</div>}

      {!shellError && !error && !books && <p className="sub" style={{ padding: "0 1.5rem" }}>Loading your library…</p>}

      {books && books.length === 0 && (
        <p className="sub" style={{ padding: "0 1.5rem" }}>
          {search ? `Nothing matches "${search}".` : "This library is empty."}
        </p>
      )}
      {books && books.length > 0 && sortedBooks?.length === 0 && (
        <p className="sub" style={{ padding: "0 1.5rem" }}>Nothing matches this filter.</p>
      )}

      {continueBooks.length > 0 && (
        <section>
          <div className="lib-section-label">Continue</div>
          <div className="lib-grid">
            {continueBooks.map((b) => (
              <BookCard
                key={`continue-${b.id}`}
                book={b}
                onNavigate={navigate}
                quickResume
                aligned={alignMap[b.id]}
                onRequestAlign={requestAlign}
              />
            ))}
          </div>
        </section>
      )}

      {sortedBooks && sortedBooks.length > 0 && (
        <section>
          {continueBooks.length > 0 && <div className="lib-section-label">All books</div>}
          <div className="lib-grid">
            {sortedBooks.map((b) => (
              <BookCard key={b.id} book={b} onNavigate={navigate} aligned={alignMap[b.id]} onRequestAlign={requestAlign} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** [quickResume]: Continue-rail cards jump straight into Play/Read (you
 *  tapped it to keep going); ordinary library-grid cards open the book info
 *  page instead, same as Codex's own browse cards — a media app you're
 *  scanning wants details first, one you're actively mid-book wants speed.
 *  [aligned]: undefined = not eligible or not checked yet, false = eligible
 *  but no map built, true = read-along ready — the mobile app's own
 *  headphones/book/"W" three-icon row, mirrored here. */
export function BookCard({
  book: b,
  onNavigate,
  quickResume,
  aligned,
  onRequestAlign,
}: {
  book: Book;
  onNavigate: (href: string) => void;
  quickResume?: boolean;
  aligned?: boolean;
  onRequestAlign?: (itemId: string) => void;
}) {
  const hasAudio = b.numAudioFiles > 0;
  const bothFormats = hasAudio && b.hasEbook;
  const primaryHref = quickResume ? (hasAudio ? `/play/${b.id}` : `/read/${b.id}`) : `/book/${b.id}`;
  const showProgress = b.progress > 0.001 && !b.isFinished;
  return (
    <div className="lib-card-wrap">
      {/* A <button> can't contain another focusable element (invalid HTML,
          and the browser will hoist it out of the DOM tree unpredictably) —
          the Read/align badges are sibling buttons absolutely positioned
          over the cover by CSS, not nested. */}
      <button className="lib-card" onClick={() => onNavigate(primaryHref)}>
        <div className="lib-cover">
          <img src={b.coverUrl} alt="" loading="lazy" />
          {showProgress && (
            <div className="lib-progress-bar">
              <div className="lib-progress-fill" style={{ width: `${Math.round(b.progress * 100)}%` }} />
            </div>
          )}
        </div>
        <div className="lib-title">{b.title}</div>
        {b.author && <div className="lib-author">{b.author}</div>}
        {b.series && <div className="lib-series">{b.series}</div>}
        <div className="lib-format-icons" aria-hidden>
          <span className={`lib-format-icon ${hasAudio ? "on" : ""}`} title="Audiobook">
            🎧
          </span>
          <span className={`lib-format-icon ${b.hasEbook ? "on" : ""}`} title="Ebook">
            📖
          </span>
          {bothFormats && (
            <span className={`lib-align-icon ${aligned ? "on" : ""}`} title={aligned ? "Read-along ready" : "Read-along not built"}>
              W
            </span>
          )}
        </div>
        {formatDuration(b.durationS) && <div className="lib-duration">{formatDuration(b.durationS)}</div>}
      </button>
      {quickResume && bothFormats && (
        <button className="lib-read-badge" aria-label={`Read ${b.title}`} onClick={() => onNavigate(`/read/${b.id}`)}>
          Read
        </button>
      )}
      {bothFormats && aligned === false && onRequestAlign && (
        <button
          className="lib-align-badge"
          aria-label={`Request read-along for ${b.title}`}
          title="Request read-along"
          onClick={() => onRequestAlign(b.id)}
        >
          +
        </button>
      )}
    </div>
  );
}
