import { useCallback, useEffect, useState } from "react";
import { api, ReadAlongMapVersion, ReadAlongMaps as Maps } from "../api/client";
import { formatDayTime } from "../lib/dates";

const SOURCE: Record<string, string> = {
  transcribe: "Listened to the audio",
  realign: "Re-aligned from the saved transcript",
  initial: "Built earlier",
};

function describe(v: ReadAlongMapVersion): string {
  return [SOURCE[v.source ?? ""] ?? "Read-along map", v.requestedBy].filter(Boolean).join(" · ");
}

/**
 * Every read-along map of a book with the day and time it was made. Use another map just for yourself, go back to
 * the default, or ask for a new one: "Re-align" takes seconds (from the saved transcript), "Re-transcribe" listens
 * to the audio again (hours). New maps are added next to the others and never replace them. Deleting old maps and
 * choosing the default for everyone is done in Codex by an admin.
 */
export default function ReadAlongMaps({
  itemId,
  ebookItemId,
  title,
  onChanged,
}: {
  /** The audio item's id (the read-along anchor). */
  itemId: string;
  /** The ebook item when it is a separate item from the audio. */
  ebookItemId?: string;
  title?: string;
  /** The map in use changed: reload it. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<Maps | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmTranscribe, setConfirmTranscribe] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.readAlongMaps(itemId));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load the maps.");
    }
  }, [itemId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(run: () => Promise<string | null>) {
    setBusy(true);
    setNote(null);
    setError(null);
    try {
      setNote(await run());
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  }

  const use = (version: string | null) =>
    act(async () => {
      await api.readAlongChooseMap(itemId, version);
      onChanged();
      return version ? "Using this map." : "Using the default map.";
    });

  const ask = (kind: "realign" | "transcribe") =>
    act(async () => {
      const res = await api.readAlongNewMap(itemId, kind, ebookItemId, title);
      return res.state === "done" ? "A new map was added." : "Listening to the audio again. The new map appears here when it is ready.";
    });

  const inUse = data ? data.mine ?? data.default : null;

  return (
    <div className="ra-maps">
      <div className="reader-panel-title">Read-along maps</div>
      <p className="reader-panel-note">
        A map says where every sentence is spoken, so the text and the audio line up. Each map is kept with the date it was made.
      </p>
      {error && <p className="reader-ra-hint reader-ra-error">{error}</p>}
      {!data && !error && <p className="reader-panel-empty">Loading…</p>}
      {data && data.versions.length === 0 && <p className="reader-panel-empty">This book has no map yet.</p>}
      {data?.versions.map((v) => {
        const current = v.id === inUse;
        const tags = [current ? "In use" : null, v.isDefault ? "Default" : null, v.isMine ? "Your pick" : null].filter(Boolean);
        return (
          <div key={v.id} className={`ra-map-row${current ? " current" : ""}`}>
            <div className="ra-map-main">
              <div className="ra-map-date">{formatDayTime(v.createdAt) || "Date unknown"}</div>
              <div className="ra-map-meta">{describe(v)}</div>
              {tags.length > 0 && <div className="ra-map-tags">{tags.join(" · ")}</div>}
            </div>
            {!current && (
              <button className="reader-font-btn" disabled={busy} onClick={() => void use(v.id)}>
                Use this
              </button>
            )}
          </div>
        );
      })}
      {data?.mine && (
        <button className="reader-font-btn" disabled={busy} onClick={() => void use(null)}>
          Use the default again
        </button>
      )}
      {note && <p className="reader-panel-note ra-map-note">{note}</p>}

      <div className="reader-panel-title ra-map-new-title">Make a new map</div>
      <button className="reader-panel-item reader-panel-add" disabled={busy} onClick={() => void ask("realign")}>
        Re-align (seconds)
      </button>
      <p className="reader-panel-note">Uses the transcript saved when the book was first listened to. Quick, and picks up changes to the ebook.</p>
      {confirmTranscribe ? (
        <div className="ra-map-confirm">
          <p className="reader-panel-note">This uses the server's graphics card for hours. The current maps stay as they are.</p>
          <button
            className="reader-panel-item reader-panel-add"
            disabled={busy}
            onClick={() => {
              setConfirmTranscribe(false);
              void ask("transcribe");
            }}
          >
            Yes, listen to the book again
          </button>
          <button className="reader-font-btn" onClick={() => setConfirmTranscribe(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="reader-panel-item reader-panel-add" disabled={busy} onClick={() => setConfirmTranscribe(true)}>
          Re-transcribe (hours)
        </button>
      )}
      <p className="reader-panel-note">Listens to the whole audiobook again. Use it when the current maps are off. Only a Codex admin can delete old maps or choose the default for everyone.</p>
    </div>
  );
}
