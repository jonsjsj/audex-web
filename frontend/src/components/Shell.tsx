import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { api, Library as LibraryModel, Me } from "../api/client";

// The sentinel library selection: one merged view across every book library,
// the same "one catalog across libraries" the mobile app builds. Real ABS
// library ids are opaque strings, so a fixed non-id sentinel can't collide.
export const ALL_LIBRARIES = "all";

export interface ShellContext {
  libraries: LibraryModel[] | null;
  libraryId: string; // a real ABS library id, or ALL_LIBRARIES
  error: string | null;
  me: Me;
  onChanged: () => void;
  onSignedOut: () => void;
  // The single search box lives here so it persists across Library/Series/
  // Authors/Narrators instead of one per page — each browse page reads it.
  search: string;
  setSearch: (v: string) => void;
  // Bumped when the brand is clicked ("back to start") so pages can reset
  // their own local view state (Library's sort/filter) to defaults.
  resetSignal: number;
  // Re-fetch the library list — Settings calls this after adding/removing an
  // Audiobookshelf server so the picker reflects it without a page reload.
  refreshLibraries: () => void;
}

// The top-level browse pages that share the persistent search bar. Detail
// pages (a single author/series/book, the player, the reader, settings) carry
// their own headers and aren't searched, so the bar is hidden there.
const SEARCHABLE_PATHS = new Set(["/", "/series", "/authors", "/narrators"]);

/** The persistent side nav — every page lives inside this now, Player and
 *  Reader included: a visible "you are here" rail beats an empty full-bleed
 *  page, and it's one less back-button to build per page. */
export default function Shell({ me, onChanged, onSignedOut }: { me: Me; onChanged: () => void; onSignedOut: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [libraries, setLibraries] = useState<LibraryModel[] | null>(null);
  const [libraryId, setLibraryId] = useState<string>(ALL_LIBRARIES);
  const [error, setError] = useState<string | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [resetSignal, setResetSignal] = useState(0);

  const loadLibraries = () => {
    api
      .libraries()
      .then((libs) => {
        setLibraries(libs);
        setError(libs.length === 0 ? "No book libraries found on your Audiobookshelf server(s)." : null);
        // A removed server's library could still be selected — fall back to
        // the combined view rather than fetching a library that's gone.
        setLibraryId((cur) => (cur === ALL_LIBRARIES || libs.some((l) => l.id === cur) ? cur : ALL_LIBRARIES));
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load your libraries."));
  };

  useEffect(() => {
    loadLibraries();
  }, []);

  // More than one distinct server contributing libraries → disambiguate the
  // picker options by server name.
  const multiServer = new Set((libraries ?? []).map((l) => l.serverKey ?? "")).size > 1;

  // "Back to start": home, cleared search, all libraries, and a reset signal
  // for each page's own view state (Library's sort/filter defaults).
  function goHome() {
    setSearch("");
    setLibraryId(ALL_LIBRARIES);
    setResetSignal((n) => n + 1);
    setNavOpen(false);
    navigate("/");
  }

  const ctx: ShellContext = {
    libraries, libraryId, error, me, onChanged, onSignedOut, search, setSearch, resetSignal,
    refreshLibraries: loadLibraries,
  };
  const showSearch = SEARCHABLE_PATHS.has(location.pathname);

  return (
    <div className="shell">
      <button className="shell-menu-toggle" aria-label="Toggle menu" onClick={() => setNavOpen((v) => !v)}>
        ☰
      </button>
      <aside className={`shell-sidebar ${navOpen ? "open" : ""}`}>
        <button className="brand shell-brand shell-brand-btn" onClick={goHome} aria-label="Back to start">
          Aud<em>ex</em>
        </button>

        {libraries && libraries.length > 1 && (
          <select
            className="shell-select"
            value={libraryId}
            onChange={(e) => setLibraryId(e.target.value)}
            aria-label="Library"
          >
            <option value={ALL_LIBRARIES}>All libraries</option>
            {libraries.map((l) => (
              <option key={l.id} value={l.id}>
                {multiServer && l.serverName ? `${l.serverName} · ${l.name}` : l.name}
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
          <NavLink to="/narrators" className="shell-nav-link">
            Narrators
          </NavLink>
        </nav>

        <NavLink to="/settings" className="shell-nav-link shell-settings-link">
          Settings
        </NavLink>
      </aside>

      <main className="shell-main">
        {showSearch && (
          <div className="shell-searchbar">
            <input
              className="lib-search"
              placeholder="Search your library…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
        {/* Not gated on `error` — a failed /libraries fetch shouldn't lock
            Settings or the Player out too; Library/Series/Authors already
            handle it (which this same failure also causes) on their own, and
            Settings/Player/Reader don't need libraryId at all. */}
        <Outlet context={ctx} />
      </main>
    </div>
  );
}

export function useShell() {
  return useOutletContext<ShellContext>();
}
