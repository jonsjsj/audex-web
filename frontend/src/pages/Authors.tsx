import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";

export default function Authors() {
  const navigate = useNavigate();
  const { libraryId } = useShell();
  const [groups, setGroups] = useState<BookGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId) return;
    setGroups(null);
    api
      .authors(libraryId)
      .then(setGroups)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load authors."));
  }, [libraryId]);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (!groups) return <p className="sub" style={{ padding: "1.5rem" }}>Loading authors…</p>;
  if (groups.length === 0) return <p className="sub" style={{ padding: "1.5rem" }}>No authors found.</p>;

  return (
    <div className="lib">
      <header className="lib-head">
        <h2 className="group-page-title">Authors</h2>
      </header>
      <div className="group-grid">
        {groups.map((g) => (
          <button key={g.name} className="group-tile" onClick={() => navigate(`/authors/${encodeURIComponent(g.name)}`)}>
            <div className="group-tile-stack">
              {g.books.slice(0, 3).map((b, i) => (
                <img key={b.id} src={b.coverUrl} alt="" style={{ zIndex: 3 - i }} />
              ))}
            </div>
            <div className="group-tile-name">{g.name}</div>
            <div className="group-tile-count">{g.books.length} book{g.books.length === 1 ? "" : "s"}</div>
          </button>
        ))}
      </div>
    </div>
  );
}
