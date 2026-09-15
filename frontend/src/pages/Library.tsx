import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Book, Library as LibraryModel, Me } from "../api/client";

function formatDuration(s: number | null): string | null {
  if (!s || s <= 0) return null;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function Library({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
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

  async function signOut() {
    await api.logout();
    onSignedOut();
  }

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
          <button className="btn btn-secondary lib-signout" onClick={signOut}>
            Sign out
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

      {books && books.length > 0 && (
        <div className="lib-grid">
          {books.map((b) => (
            <button key={b.id} className="lib-card" onClick={() => navigate(`/play/${b.id}`)}>
              <div className="lib-cover">
                <img src={b.coverUrl} alt="" loading="lazy" />
              </div>
              <div className="lib-title">{b.title}</div>
              {b.author && <div className="lib-author">{b.author}</div>}
              {b.series && <div className="lib-series">{b.series}</div>}
              {formatDuration(b.durationS) && <div className="lib-duration">{formatDuration(b.durationS)}</div>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
