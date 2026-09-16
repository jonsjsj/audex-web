import { useEffect, useState } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import { api, Library as LibraryModel, Me } from "../api/client";

export interface ShellContext {
  libraries: LibraryModel[] | null;
  libraryId: string | null;
  error: string | null;
  me: Me;
  onChanged: () => void;
  onSignedOut: () => void;
}

/** The persistent side nav — every page lives inside this now, Player and
 *  Reader included: a visible "you are here" rail beats an empty full-bleed
 *  page, and it's one less back-button to build per page. */
export default function Shell({ me, onChanged, onSignedOut }: { me: Me; onChanged: () => void; onSignedOut: () => void }) {
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

  const ctx: ShellContext = { libraries, libraryId, error, me, onChanged, onSignedOut };

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
        {/* Not gated on `error` — a failed /libraries fetch shouldn't lock
            Settings or the Player out too; Library/Series/Authors already
            handle a null libraryId (which this same failure also causes) on
            their own, and Settings/Player/Reader don't need libraryId at all. */}
        <Outlet context={ctx} />
      </main>
    </div>
  );
}

export function useShell() {
  return useOutletContext<ShellContext>();
}
