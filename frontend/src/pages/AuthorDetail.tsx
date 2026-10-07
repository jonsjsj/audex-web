import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import PersonDetail from "../components/PersonDetail";

export default function AuthorDetail() {
  const { name } = useParams<{ name: string }>();
  const { libraryId, syncSignal } = useShell();
  const [group, setGroup] = useState<BookGroup | null | undefined>(undefined); // undefined = loading
  const [bio, setBio] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId || !name) return;
    setGroup(undefined);
    setBio(null);
    api
      .authors(libraryId)
      .then((groups) => setGroup(groups.find((g) => g.name === decodeURIComponent(name)) ?? null))
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this author."));
  }, [libraryId, name, syncSignal]);

  // A separate call, not embedded in the /authors list — a bio is a whole
  // paragraph, not worth fetching for every author until one is actually opened.
  useEffect(() => {
    if (!group?.id) return;
    api.authorBio(group.id).then((r) => setBio(r.description)).catch(() => {});
  }, [group?.id]);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (group === undefined) return <p className="sub" style={{ padding: "1.5rem" }}>Loading…</p>;
  if (group === null) return <p className="sub" style={{ padding: "1.5rem" }}>Author not found.</p>;

  return (
    <PersonDetail
      name={group.name}
      imageUrl={group.imageUrl}
      bio={bio}
      books={group.books}
      backLabel="Authors"
      backTo="/authors"
    />
  );
}
