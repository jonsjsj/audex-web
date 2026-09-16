import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Book, BookDetail as BookDetailModel } from "../api/client";
import { useShell } from "../components/Shell";

function formatDuration(s: number | null): string | null {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** The book-info page Codex has and audex-web didn't: everything ABS knows
 *  about a title beyond what fits a library card, with author/series as
 *  actual navigation (not just labels) — see docs/AUDEX_NAVIGATION.md's
 *  "clickable author/series/title" principle. Reached from a library-grid
 *  card; Play/Read are the actions FROM here, not skipped past it. */
export default function BookDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const { libraryId } = useShell();
  const [book, setBook] = useState<BookDetailModel | null>(null);
  const [nextInSeries, setNextInSeries] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!itemId) return;
    api
      .item(itemId)
      .then(setBook)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this book."));
  }, [itemId]);

  // "Next: #N Title" — mirrors the mobile app's WorkDetailScreen. Reuses the
  // same grouped-series endpoint Series/SeriesDetail already fetch, rather
  // than a dedicated lookup — a homelab-scale library makes that cheap.
  useEffect(() => {
    if (!book?.series || !libraryId) {
      setNextInSeries(null);
      return;
    }
    const seriesName = book.series.replace(/ #.*$/, "");
    api
      .series(libraryId)
      .then((groups) => {
        const group = groups.find((g) => g.name === seriesName);
        if (!group) return;
        const idx = group.books.findIndex((b) => b.id === book.id);
        if (idx >= 0 && idx + 1 < group.books.length) setNextInSeries(group.books[idx + 1]);
      })
      .catch(() => {}); // "Next in series" is a nice-to-have, not worth an error banner
  }, [book?.id, book?.series, libraryId]);

  if (error) {
    return (
      <div className="lib">
        <div className="error" style={{ margin: "1.5rem" }}>{error}</div>
      </div>
    );
  }
  if (!book) return <p className="sub" style={{ padding: "1.5rem" }}>Loading…</p>;

  const hasAudio = book.numAudioFiles > 0;
  const duration = formatDuration(book.durationS);

  return (
    <div className="lib book-detail">
      <button className="group-back" onClick={() => navigate(-1)}>
        ← Back
      </button>

      <div className="book-detail-top">
        <img className="book-detail-cover" src={book.coverUrl} alt="" />
        <div className="book-detail-meta">
          <h1 className="book-detail-title">{book.title}</h1>
          {book.subtitle && <p className="book-detail-subtitle">{book.subtitle}</p>}
          {book.author && (
            <button className="book-detail-link" onClick={() => navigate(`/authors/${encodeURIComponent(book.author!)}`)}>
              {book.author}
            </button>
          )}
          {book.series && (
            <button
              className="book-detail-link book-detail-series"
              onClick={() => navigate(`/series/${encodeURIComponent(book.series!.replace(/ #.*$/, ""))}`)}
            >
              {book.series}
            </button>
          )}

          <div className="book-detail-tags">
            {duration && <span className="tag">{duration}</span>}
            {book.narrator &&
              book.narrator.split(",").map((n) => n.trim()).filter(Boolean).map((n) => (
                <button
                  key={n}
                  className="tag book-detail-narrator-tag"
                  onClick={() => navigate(`/narrators/${encodeURIComponent(n)}`)}
                >
                  Read by {n}
                </button>
              ))}
            {book.publishedYear && <span className="tag">{book.publishedYear}</span>}
            {book.language && <span className="tag">{book.language}</span>}
          </div>

          {book.progress > 0.001 && (
            <div className="book-detail-progress">
              <div className="lib-progress-bar">
                <div className="lib-progress-fill" style={{ width: `${Math.round(book.progress * 100)}%` }} />
              </div>
              <span>{book.isFinished ? "Finished" : `${Math.round(book.progress * 100)}% done`}</span>
            </div>
          )}

          {nextInSeries && (
            <button className="book-detail-next" onClick={() => navigate(`/book/${nextInSeries.id}`)}>
              Next in series → {nextInSeries.title}
            </button>
          )}

          <div className="book-detail-actions">
            {hasAudio && (
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => navigate(`/play/${book.id}`)}>
                {book.audioProgress > 0.001 ? "Resume listening" : "Listen"}
              </button>
            )}
            {book.hasEbook && (
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => navigate(`/read/${book.id}`)}>
                {book.ebookProgress > 0.001 ? "Resume reading" : "Read"}
              </button>
            )}
          </div>
        </div>
      </div>

      {book.description && (
        <div className="book-detail-section">
          <div className="l">DESCRIPTION</div>
          <p className="book-detail-description">{book.description}</p>
        </div>
      )}

      {book.genres.length > 0 && (
        <div className="book-detail-section">
          <div className="l">GENRES</div>
          <div className="book-detail-tags">
            {book.genres.map((g) => (
              <span key={g} className="tag">
                {g}
              </span>
            ))}
          </div>
        </div>
      )}

      {(book.publisher || book.isbn || book.asin) && (
        <div className="book-detail-section">
          <div className="l">DETAILS</div>
          <dl className="book-detail-facts">
            {book.publisher && (
              <>
                <dt>Publisher</dt>
                <dd>{book.publisher}</dd>
              </>
            )}
            {book.isbn && (
              <>
                <dt>ISBN</dt>
                <dd>{book.isbn}</dd>
              </>
            )}
            {book.asin && (
              <>
                <dt>ASIN</dt>
                <dd>{book.asin}</dd>
              </>
            )}
          </dl>
        </div>
      )}

      {book.chapters.length > 0 && (
        <div className="book-detail-section">
          <div className="l">CHAPTERS</div>
          {book.chapters.map((c) => (
            <div key={c.id} className="player-chapter-row" style={{ cursor: "default" }}>
              <span>{c.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
