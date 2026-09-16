import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Book } from "../api/client";
import { useShell } from "../components/Shell";

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

type SortKey = "title" | "author" | "added" | "duration" | "progress";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "author", label: "Author" },
  { key: "added", label: "Recently added" },
  { key: "duration", label: "Duration" },
  { key: "progress", label: "Progress" },
];

// Mirrors the mobile app's WorkFilter (LibraryViewModel.kt) exactly.
type FilterKey = "all" | "audio" | "ebook" | "progress";
const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "all", label: "All formats" },
  { key: "audio", label: "Audiobook" },
  { key: "ebook", label: "Ebook" },
  { key: "progress", label: "In progress" },
];

function filterBooks(books: Book[], key: FilterKey): Book[] {
  switch (key) {
    case "audio":
      return books.filter((b) => b.numAudioFiles > 0);
    case "ebook":
      return books.filter((b) => b.hasEbook);
    case "progress":
      return books.filter(isContinuable);
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
  const { libraryId, error: shellError } = useShell();
  const [books, setBooks] = useState<Book[] | null>(null);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortKey>("title");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [error, setError] = useState<string | null>(null);

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
        <input
          className="lib-search"
          placeholder="Search your library…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
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
              <BookCard key={`continue-${b.id}`} book={b} onNavigate={navigate} quickResume />
            ))}
          </div>
        </section>
      )}

      {sortedBooks && sortedBooks.length > 0 && (
        <section>
          {continueBooks.length > 0 && <div className="lib-section-label">All books</div>}
          <div className="lib-grid">
            {sortedBooks.map((b) => (
              <BookCard key={b.id} book={b} onNavigate={navigate} />
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
 *  scanning wants details first, one you're actively mid-book wants speed. */
export function BookCard({ book: b, onNavigate, quickResume }: { book: Book; onNavigate: (href: string) => void; quickResume?: boolean }) {
  const hasAudio = b.numAudioFiles > 0;
  const primaryHref = quickResume ? (hasAudio ? `/play/${b.id}` : `/read/${b.id}`) : `/book/${b.id}`;
  const showProgress = b.progress > 0.001 && !b.isFinished;
  return (
    <div className="lib-card-wrap">
      {/* A <button> can't contain another focusable element (invalid HTML,
          and the browser will hoist it out of the DOM tree unpredictably) —
          the Read badge is a sibling button absolutely positioned over the
          cover by CSS, not nested. */}
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
        {formatDuration(b.durationS) && <div className="lib-duration">{formatDuration(b.durationS)}</div>}
      </button>
      {quickResume && hasAudio && b.hasEbook && (
        <button className="lib-read-badge" aria-label={`Read ${b.title}`} onClick={() => onNavigate(`/read/${b.id}`)}>
          Read
        </button>
      )}
    </div>
  );
}
