import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import { BookCard } from "./Library";

/** Books in a series are pre-sorted by sequence server-side (library.py's
 *  /series groups them that way), so this just renders the group as-is. */
export default function SeriesDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();
  const { libraryId } = useShell();
  const [group, setGroup] = useState<BookGroup | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId || !name) return;
    setGroup(undefined);
    api
      .series(libraryId)
      .then((groups) => setGroup(groups.find((g) => g.name === decodeURIComponent(name)) ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this series."));
  }, [libraryId, name]);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (group === undefined) return <p className="sub" style={{ padding: "1.5rem" }}>Loading…</p>;
  if (group === null) return <p className="sub" style={{ padding: "1.5rem" }}>Series not found.</p>;

  const finishedCount = group.books.filter((b) => b.isFinished).length;

  return (
    <div className="lib">
      <header className="lib-head">
        <button className="group-back" onClick={() => navigate("/series")}>
          ← Series
        </button>
        <h2 className="group-page-title">{group.name}</h2>
        <span className="group-page-sub">
          {finishedCount} of {group.books.length} finished
        </span>
      </header>
      <div className="lib-grid" style={{ padding: "1.6rem 1.5rem" }}>
        {group.books.map((b) => (
          <BookCard key={b.id} book={b} onNavigate={navigate} />
        ))}
      </div>
    </div>
  );
}
