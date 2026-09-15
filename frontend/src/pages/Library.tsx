import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Book, Library as LibraryModel } from "../api/client";

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

export default function Library() {
  const navigate = useNavigate();
  const [libraries, setLibraries] = useState<LibraryModel[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [books, setBooks] = useState<Book[] | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .libraries()
      .then((libs) => {
        setLibraries(libs);
        if (libs.length > 0) setLibraryId(libs[0].id);
        else setError("No book libraries found on this Audiobookshelf server.");
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your libraries."));
  }, []);

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

  return (
    <div className="lib">
      <header className="lib-head">
        <h1 className="brand lib-brand">
          Aud<em>ex</em>
        </h1>
        <div className="lib-head-right">
          {libraries && libraries.length > 1 && (
            <select
              className="lib-select"
              value={libraryId ?? ""}
              onChange={(e) => setLibraryId(e.target.value)}
            >
              {libraries.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          )}
          <input
            className="lib-search"
            placeholder="Search your library…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button className="btn btn-secondary lib-signout" onClick={() => navigate("/settings")}>
            Settings
          </button>
        </div>
      </header>

      {error && <div className="error" style={{ margin: "1rem 1.5rem" }}>{error}</div>}

      {!error && !books && <p className="sub" style={{ padding: "0 1.5rem" }}>Loading your library…</p>}

      {books && books.length === 0 && (
        <p className="sub" style={{ padding: "0 1.5rem" }}>
          {search ? `Nothing matches "${search}".` : "This library is empty."}
        </p>
      )}

      {continueBooks.length > 0 && (
        <section>
          <div className="lib-section-label">Continue</div>
          <div className="lib-grid">
            {continueBooks.map((b) => (
              <BookCard key={`continue-${b.id}`} book={b} onNavigate={navigate} />
            ))}
          </div>
        </section>
      )}

      {books && books.length > 0 && (
        <section>
          {continueBooks.length > 0 && <div className="lib-section-label">All books</div>}
          <div className="lib-grid">
            {books.map((b) => (
              <BookCard key={b.id} book={b} onNavigate={navigate} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function BookCard({ book: b, onNavigate }: { book: Book; onNavigate: (href: string) => void }) {
  const hasAudio = b.numAudioFiles > 0;
  // A book with only one format opens directly; one with both opens Listen by
  // default (audio is the more common "resume where I was" action for a
  // library synced from an audiobook-first server) with an explicit Read
  // affordance alongside it, rather than guessing.
  const primaryHref = hasAudio ? `/play/${b.id}` : `/read/${b.id}`;
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
      {hasAudio && b.hasEbook && (
        <button className="lib-read-badge" aria-label={`Read ${b.title}`} onClick={() => onNavigate(`/read/${b.id}`)}>
          Read
        </button>
      )}
    </div>
  );
}
