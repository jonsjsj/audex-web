import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import PersonDetail from "../components/PersonDetail";

export default function NarratorDetail() {
  const { name } = useParams<{ name: string }>();
  const { libraryId } = useShell();
  const [group, setGroup] = useState<BookGroup | null | undefined>(undefined); // undefined = loading
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId || !name) return;
    setGroup(undefined);
    api
      .narrators(libraryId)
      .then((groups) => setGroup(groups.find((g) => g.name === decodeURIComponent(name)) ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this narrator."));
  }, [libraryId, name]);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (group === undefined) return <p className="sub" style={{ padding: "1.5rem" }}>Loading…</p>;
  if (group === null) return <p className="sub" style={{ padding: "1.5rem" }}>Narrator not found.</p>;

  return (
    // No imageUrl/bio — ABS has no Narrator entity to fetch either from (see
    // library.py's _narrator_names docstring). PersonDetail falls back to
    // initials cleanly either way.
    <PersonDetail name={group.name} books={group.books} backLabel="Narrators" backTo="/narrators" />
  );
}
