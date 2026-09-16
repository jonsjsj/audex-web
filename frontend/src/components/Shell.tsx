import { useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { api, Library as LibraryModel } from "../api/client";

export interface ShellContext {
  libraries: LibraryModel[] | null;
  libraryId: string | null;
  error: string | null;
}

/** The persistent side nav for every library-browsing page (Library, Series,
 *  Authors, Book info) — a left rail rather than a top bar, so switching
 *  between them doesn't re-layout the page each time. Player/Reader stay
 *  OUTSIDE this shell (immersive, no chrome around them) — see
 *  docs/AUDEX_NAVIGATION.md's "immersive reader/player" principle. */
export default function Shell() {
  const [libraries, setLibraries] = useState<LibraryModel[] | null>(null);
  const [libraryId, setLibraryId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);

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

  const ctx: ShellContext = { libraries, libraryId, error };

  return (
    <div className="shell">
      <button className="shell-menu-toggle" aria-label="Toggle menu" onClick={() => setNavOpen((v) => !v)}>
        ☰
      </button>
      <aside className={`shell-sidebar ${navOpen ? "open" : ""}`}>
        <h1 className="brand shell-brand">
          Aud<em>ex</em>
        </h1>

        {libraries && libraries.length > 1 && (
          <select
            className="shell-select"
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

        <nav className="shell-nav" onClick={() => setNavOpen(false)}>
          <NavLink to="/" end className="shell-nav-link">
            Library
          </NavLink>
          <NavLink to="/series" className="shell-nav-link">
            Series
          </NavLink>
          <NavLink to="/authors" className="shell-nav-link">
            Authors
          </NavLink>
        </nav>

        <NavLink to="/settings" className="shell-nav-link shell-settings-link">
          Settings
        </NavLink>
      </aside>

      <main className="shell-main">
        {error ? <div className="error" style={{ margin: "1.5rem" }}>{error}</div> : <Outlet context={ctx} />}
      </main>
    </div>
  );
}

export function useShell() {
  return useOutletContext<ShellContext>();
}
