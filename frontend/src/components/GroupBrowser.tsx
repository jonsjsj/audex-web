import { useEffect, useState } from "react";
import { BookGroup } from "../api/client";

type ViewMode = "grid" | "list";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  const first = parts[0]?.[0] ?? "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] : "";
  return (first + last).toUpperCase();
}

/** One tile's image. For a person (author/narrator): a real ABS headshot when
 *  one exists, otherwise an initials placeholder — NEVER a book cover
 *  standing in for a person, per the explicit "shouldn't have book covers"
 *  ask. For a series: a real headshot never applies, so a cover is the
 *  right stand-in there. `imageUrl` may 404 (ABS knows the author but has no
 *  photo on file) even when set, since the backend can't cheaply pre-check
 *  every author — falls back to initials on that error rather than a broken
 *  image. */
function TileImage({
  name,
  imageUrl,
  coverUrl,
  isPerson,
}: {
  name: string;
  imageUrl?: string | null;
  coverUrl?: string;
  isPerson: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const src = imageUrl ?? (isPerson ? undefined : coverUrl);
  if (!src || failed) {
    return (
      <div className="group-tile-initials" aria-hidden>
        {initials(name)}
      </div>
    );
  }
  return <img src={src} alt="" onError={() => setFailed(true)} />;
}

export default function GroupBrowser({
  title,
  groups,
  storageKey,
  isPerson = false,
  onOpen,
}: {
  title: string;
  groups: BookGroup[];
  storageKey: string; // "series" | "authors" | "narrators" — persists the grid/list choice per page
  isPerson?: boolean; // true for authors/narrators — governs the never-a-book-cover rule above
  onOpen: (name: string) => void;
}) {
  const [view, setView] = useState<ViewMode>("grid");

  useEffect(() => {
    try {
      const saved = localStorage.getItem(`audexweb.groupView.${storageKey}`);
      if (saved === "grid" || saved === "list") setView(saved);
    } catch {
      // private-browsing / storage-blocked — just keep the default
    }
  }, [storageKey]);

  function changeView(v: ViewMode) {
    setView(v);
    try {
      localStorage.setItem(`audexweb.groupView.${storageKey}`, v);
    } catch {
      // per-viewer convenience only — fine if it doesn't stick
    }
  }

  return (
    <div className="lib">
      <header className="lib-head">
        <h2 className="group-page-title">{title}</h2>
        <div className="group-view-toggle" role="group" aria-label="View">
          <button className={view === "grid" ? "active" : ""} onClick={() => changeView("grid")} aria-label="Grid view">
            ⊞
          </button>
          <button className={view === "list" ? "active" : ""} onClick={() => changeView("list")} aria-label="List view">
            ☰
          </button>
        </div>
      </header>

      {view === "grid" ? (
        <div className="group-grid">
          {groups.map((g) => (
            <button key={g.name} className="group-tile" onClick={() => onOpen(g.name)}>
              <div className="group-tile-poster">
                <TileImage name={g.name} imageUrl={g.imageUrl} coverUrl={g.books[0]?.coverUrl} isPerson={isPerson} />
              </div>
              <div className="group-tile-name">{g.name}</div>
              <div className="group-tile-count">
                {g.books.length} book{g.books.length === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      ) : (
        <div className="group-list">
          {groups.map((g) => (
            <button key={g.name} className="group-list-row" onClick={() => onOpen(g.name)}>
              <div className="group-list-thumb">
                <TileImage name={g.name} imageUrl={g.imageUrl} coverUrl={g.books[0]?.coverUrl} isPerson={isPerson} />
              </div>
              <span className="group-list-name">{g.name}</span>
              <span className="group-list-count">{g.books.length}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
