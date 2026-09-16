import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import GroupBrowser from "../components/GroupBrowser";

export default function Series() {
  const navigate = useNavigate();
  const { libraryId, error: shellError } = useShell();
  const [groups, setGroups] = useState<BookGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId) return;
    setGroups(null);
    api
      .series(libraryId)
      .then(setGroups)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load series."));
  }, [libraryId]);

  if (error || shellError) return <div className="error" style={{ margin: "1.5rem" }}>{error || shellError}</div>;
  if (!groups) return <p className="sub" style={{ padding: "1.5rem" }}>Loading series…</p>;
  if (groups.length === 0) return <p className="sub" style={{ padding: "1.5rem" }}>No series in this library.</p>;

  return (
    <GroupBrowser
      title="Series"
      groups={groups}
      storageKey="series"
      onOpen={(name) => navigate(`/series/${encodeURIComponent(name)}`)}
    />
  );
}
