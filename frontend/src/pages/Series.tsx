import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, BookGroup } from "../api/client";
import { useShell } from "../components/Shell";
import GroupBrowser, { GroupSort } from "../components/GroupBrowser";
import { latestSort, nameSort } from "../lib/groupSort";

// A series' own author isn't a stored field (ABS series are just a name +
// sequence on each book) — the author most of the series' books agree on,
// same idea as picking a representative cover.
function seriesAuthor(g: BookGroup): string {
  const counts = new Map<string, number>();
  for (const b of g.books) if (b.author) counts.set(b.author, (counts.get(b.author) ?? 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) if (count > bestCount) [best, bestCount] = [name, count];
  return best;
}

const SORTS: GroupSort[] = [
  { key: "latest", label: "Latest release", cmp: latestSort },
  { key: "name", label: "Name", cmp: nameSort },
  { key: "author", label: "Author", cmp: (a, b) => seriesAuthor(a).localeCompare(seriesAuthor(b)) || nameSort(a, b) },
];

export default function Series() {
  const navigate = useNavigate();
  const { libraryId, error: shellError, search } = useShell();
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
      sorts={SORTS}
      search={search}
      onOpen={(name) => navigate(`/series/${encodeURIComponent(name)}`)}
    />
  );
}
