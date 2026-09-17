import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import GroupBrowser from "../components/GroupBrowser";

export default function Authors() {
  const navigate = useNavigate();
  const { libraryId, error: shellError, search } = useShell();
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

  if (error || shellError) return <div className="error" style={{ margin: "1.5rem" }}>{error || shellError}</div>;
  if (!groups) return <p className="sub" style={{ padding: "1.5rem" }}>Loading authors…</p>;
  if (groups.length === 0) return <p className="sub" style={{ padding: "1.5rem" }}>No authors found.</p>;

  return (
    <GroupBrowser
      title="Authors"
      groups={groups}
      storageKey="authors"
      isPerson
      search={search}
      onOpen={(name) => navigate(`/authors/${encodeURIComponent(name)}`)}
    />
  );
}
