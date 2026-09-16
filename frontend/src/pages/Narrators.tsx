import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import GroupBrowser from "../components/GroupBrowser";

export default function Narrators() {
  const navigate = useNavigate();
  const { libraryId } = useShell();
  const [groups, setGroups] = useState<BookGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!libraryId) return;
    setGroups(null);
    api
      .narrators(libraryId)
      .then(setGroups)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load narrators."));
  }, [libraryId]);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (!groups) return <p className="sub" style={{ padding: "1.5rem" }}>Loading narrators…</p>;
  if (groups.length === 0) return <p className="sub" style={{ padding: "1.5rem" }}>No narrators found.</p>;

  return (
    <GroupBrowser
      title="Narrators"
      groups={groups}
      storageKey="narrators"
      isPerson
      onOpen={(name) => navigate(`/narrators/${encodeURIComponent(name)}`)}
    />
  );
}
