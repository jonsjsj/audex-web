import { labelChapters } from "../lib/chapters";
import { FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Book, BookDetail as BookDetailModel } from "../api/client";
import { useShell } from "../components/Shell";
import ArrMonitor from "../components/ArrMonitor";

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
/** One wording for "did this change also reach Codex?" — used by Edit details and Merge alike. */
function codexNote(state?: string): string | undefined {
  if (state === "not-linked")
    return "Saved to Audiobookshelf. Link your Codex account in Settings so this fix reaches Codex too — until then Codex's older value is still shown.";
  if (state === "failed")
    return "Saved to Audiobookshelf, but Codex didn't accept the change — Codex's older value may still be shown.";
  return undefined;
}

/** Did a merge (or separation) made here also reach Codex? Say so when it didn't — Codex is where the three apps agree. */
function codexMergeNote(state?: string, merged = true): string | undefined {
  const done = merged ? "Merged here" : "Separated here";
  if (state === "not-linked") return `${done}, but Codex isn't linked — link your Codex account in Settings so Codex does the same.`;
  if (state === "failed") return `${done}, but Codex didn't accept it — they may still look ${merged ? "separate" : "merged"} in Codex.`;
  if (state === "not-in-codex") return `${done}. Codex doesn't have both editions yet, so it hasn't been told.`;
  if (state === "merged-in-codex") return "Separated here, but Codex still has them merged — separate them in Codex too, or the other apps will follow it.";
  return undefined;
}

/** Comma/newline separated text <-> list, for the multi-value fields. */
const splitList = (v: string) => v.split(/[,\n;]/).map((x) => x.trim()).filter(Boolean);

/** Fix a book's details where they live: Audiobookshelf. Wrong or mismatched
 *  title/author/series/ASIN/ISBN is what stops an ebook and its audiobook from
 *  showing up as one book, and the fix belongs in the library (so the Audex and
 *  Codex apps benefit too), not in a local workaround. */
function EditDetails({ book, onSaved, onCancel }: { book: BookDetailModel; onSaved: (note?: string) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(book.title);
  const [subtitle, setSubtitle] = useState(book.subtitle ?? "");
  const [authors, setAuthors] = useState(book.authorList.join(", "));
  const [narrators, setNarrators] = useState(book.narratorList.join(", "));
  const [series, setSeries] = useState(book.seriesList[0]?.name ?? "");
  const [sequence, setSequence] = useState(book.seriesList[0]?.sequence ?? "");
  const [asin, setAsin] = useState(book.asin ?? "");
  const [isbn, setIsbn] = useState(book.isbn ?? "");
  const [description, setDescription] = useState(book.description ?? "");
  const [publisher, setPublisher] = useState(book.publisher ?? "");
  const [year, setYear] = useState(book.publishedYear ?? "");
  const [language, setLanguage] = useState(book.language ?? "");
  const [genres, setGenres] = useState(book.genres.join(", "));
  const [alsoPaired, setAlsoPaired] = useState(!!book.pairedItemId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await api.updateMetadata(book.id, {
        title,
        subtitle,
        authors: splitList(authors),
        narrators: splitList(narrators),
        series: series.trim() ? [{ name: series, sequence }] : [],
        asin,
        isbn,
        description,
        publisher,
        publishedYear: year,
        language,
        genres: splitList(genres),
        alsoPaired,
      });
      // Codex is the source of truth for these details. If this fix didn't reach it, Codex's older value would
      // keep being shown — say so, with the one thing that fixes it.
      onSaved(codexNote(res.codexSync));
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Couldn't save.");
      setBusy(false);
    }
  }

  return (
    <form className="book-detail-section book-edit" onSubmit={save}>
      <div className="l">EDIT DETAILS</div>
      <p className="sub">Saved to Audiobookshelf and Codex, so Audex and Codex pick it up too.</p>
      <label htmlFor="ed-title">Title</label>
      <input id="ed-title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      <label htmlFor="ed-sub">Subtitle</label>
      <input id="ed-sub" value={subtitle} onChange={(e) => setSubtitle(e.target.value)} />
      <label htmlFor="ed-auth">Authors (comma separated)</label>
      <input id="ed-auth" value={authors} onChange={(e) => setAuthors(e.target.value)} />
      <label htmlFor="ed-narr">Narrators (comma separated)</label>
      <input id="ed-narr" value={narrators} onChange={(e) => setNarrators(e.target.value)} />
      <div className="book-edit-row">
        <div style={{ flex: 3 }}>
          <label htmlFor="ed-series">Series</label>
          <input id="ed-series" value={series} onChange={(e) => setSeries(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="ed-seq">Book #</label>
          <input id="ed-seq" value={sequence} onChange={(e) => setSequence(e.target.value)} />
        </div>
      </div>
      <div className="book-edit-row">
        <div style={{ flex: 1 }}>
          <label htmlFor="ed-asin">ASIN</label>
          <input id="ed-asin" value={asin} onChange={(e) => setAsin(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="ed-isbn">ISBN</label>
          <input id="ed-isbn" value={isbn} onChange={(e) => setIsbn(e.target.value)} />
        </div>
      </div>
      <div className="book-edit-row">
        <div style={{ flex: 2 }}>
          <label htmlFor="ed-pub">Publisher</label>
          <input id="ed-pub" value={publisher} onChange={(e) => setPublisher(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="ed-year">Year</label>
          <input id="ed-year" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div style={{ flex: 1 }}>
          <label htmlFor="ed-lang">Language</label>
          <input id="ed-lang" value={language} onChange={(e) => setLanguage(e.target.value)} />
        </div>
      </div>
      <label htmlFor="ed-genres">Genres (comma separated)</label>
      <input id="ed-genres" value={genres} onChange={(e) => setGenres(e.target.value)} />
      <label htmlFor="ed-desc">Description</label>
      <textarea id="ed-desc" rows={5} value={description} onChange={(e) => setDescription(e.target.value)} />
      <p className="sub">Giving the ebook and the audiobook the same ASIN or ISBN is the surest way to keep them one book.</p>
      {book.pairedItemId && (
        <label className="book-edit-check">
          <input type="checkbox" checked={alsoPaired} onChange={(e) => setAlsoPaired(e.target.checked)} />
          Apply to the other edition too
        </label>
      )}
      {err && <div className="error">{err}</div>}
      <div className="book-detail-actions">
        <button className="btn btn-primary" style={{ width: "auto" }} disabled={busy} type="submit">
          {busy ? "Saving…" : "Save to Audiobookshelf"}
        </button>
        <button className="btn btn-secondary" style={{ width: "auto" }} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** Merge this book with its other-format edition when Audiobookshelf holds them as
 *  two items and the automatic matching missed them. The change is written to
 *  Audiobookshelf (the other item is made to match this one), so Audex and Codex
 *  merge them too — see the backend's link_editions. */
function MergePicker({ book, onDone, onCancel }: { book: BookDetailModel; onDone: (note?: string) => void; onCancel: () => void }) {
  const wantAudio = book.numAudioFiles <= 0; // this is the ebook → look for its audiobook, and vice versa
  const [q, setQ] = useState(book.title.split(":")[0]);
  const [results, setResults] = useState<Book[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .items("all", q)
        .then((r) =>
          setResults(
            r.items
              .filter((b) => b.id !== book.id && !b.pairedItemId && (wantAudio ? b.numAudioFiles > 0 && !b.hasEbook : b.hasEbook && b.numAudioFiles === 0))
              .slice(0, 8),
          ),
        )
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q, book.id, wantAudio]);

  async function pick(b: Book) {
    if (!window.confirm(`Make "${b.title}" match "${book.title}" in Audiobookshelf, so they show as one book in Audex, Codex and here?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.linkEditions(book.id, b.id);
      onDone([codexNote(res.codexSync), codexMergeNote(res.codexMerge)].filter(Boolean).join(" ") || undefined);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : "Couldn't merge.");
      setBusy(false);
    }
  }

  return (
    <div className="book-detail-section book-edit">
      <div className="l">MERGE WITH {wantAudio ? "AUDIOBOOK" : "EBOOK"}</div>
      <p className="sub">
        Pick the {wantAudio ? "audiobook" : "ebook"} of this same book. Its details are updated in Audiobookshelf to match this one.
      </p>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by title or author" aria-label="Search" />
      {results.length === 0 && <p className="sub">No unmerged {wantAudio ? "audiobooks" : "ebooks"} match.</p>}
      {results.map((b) => (
        <button key={b.id} className="player-chapter-row" disabled={busy} onClick={() => pick(b)}>
          <span>
            {b.title}
            {b.author ? ` — ${b.author}` : ""}
          </span>
        </button>
      ))}
      {err && <div className="error">{err}</div>}
      <div className="book-detail-actions">
        <button className="btn btn-secondary" style={{ width: "auto" }} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function BookDetail() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const { libraryId, syncSignal } = useShell();
  const [book, setBook] = useState<BookDetailModel | null>(null);
  const [nextInSeries, setNextInSeries] = useState<Book | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [merging, setMerging] = useState(false);
  const [reload, setReload] = useState(0);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  useEffect(() => {
    if (!itemId) return;
    api
      .item(itemId)
      .then(setBook)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this book."));
  }, [itemId, reload, syncSignal]);

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
  // ABS sometimes catalogs a book's audiobook and ebook as two separate
  // library items instead of one with both files (see pairedItemId's own
  // doc comment) — when this item is missing a format natively but has a
  // paired item, that pair supplies it.
  const audioTargetId = hasAudio ? book.id : book.pairedItemId;
  const ebookTargetId = book.hasEbook ? book.id : book.pairedItemId;

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
            {audioTargetId && (
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => navigate(`/play/${audioTargetId}`)}>
                {book.audioProgress > 0.001 ? "Resume listening" : "Listen"}
              </button>
            )}
            {ebookTargetId && (
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => navigate(`/read/${ebookTargetId}`)}>
                {book.ebookProgress > 0.001 ? "Resume reading" : "Read"}
              </button>
            )}
            <ArrMonitor itemId={book.id} />
            <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setEditing((v) => !v)}>
              Edit details
            </button>
            {book.pairedItemId && (
              <button
                className="btn btn-secondary"
                style={{ width: "auto" }}
                title="They are two different books — show them separately from now on"
                onClick={() => {
                  if (!window.confirm("Show the audiobook and the ebook as two separate books from now on?")) return;
                  api
                    .unlinkEditions(book.id, book.pairedItemId!)
                    .then((res) => {
                      const note = codexMergeNote(res.codexMerge, false);
                      if (note) window.alert(note);
                      navigate("/");
                    })
                    .catch((e) => setError(e instanceof Error ? e.message : "Couldn't separate them."));
                }}
              >
                Not the same book
              </button>
            )}
            {!book.pairedItemId && (book.numAudioFiles > 0) !== book.hasEbook && (
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setMerging((v) => !v)}>
                Merge with {book.numAudioFiles > 0 ? "ebook" : "audiobook"}…
              </button>
            )}
          </div>
        </div>
      </div>

      {merging && (
        <MergePicker
          book={book}
          onCancel={() => setMerging(false)}
          onDone={(note) => {
            setMerging(false);
            setSaveNote(note ?? null);
            setReload((n) => n + 1);
          }}
        />
      )}

      {editing && (
        <EditDetails
          book={book}
          onCancel={() => setEditing(false)}
          onSaved={(note) => {
            setEditing(false);
            setSaveNote(note ?? null);
            setReload((n) => n + 1);
          }}
        />
      )}
      {saveNote && <div className="error" role="status">{saveNote}</div>}

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
          {labelChapters(book.chapters.map((c) => c.title)).map((c, i) => (
            <div key={book.chapters[i].id} className="player-chapter-row" style={{ cursor: "default" }}>
              <span>{c.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
