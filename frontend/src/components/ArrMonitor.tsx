import { useEffect, useState } from "react";
import { api, ArrStatus } from "../api/client";

const LABEL: Record<string, string> = { chaptarr: "Chaptarr", readarr: "Readarr" };

/** "Monitor & download in Chaptarr" — asks Codex's connected book downloader to grab this book now
 *  if a release is out, otherwise to keep it monitored and download it when it's released.
 *  Renders NOTHING unless Codex reports a Chaptarr/Readarr is connected (the opt-in gate), and shows
 *  the book's real state (already in the library / already monitored) instead of a blind button. */
export default function ArrMonitor({ itemId }: { itemId: string }) {
  const [service, setService] = useState<string | null>(null);   // null = not available → render nothing
  const [status, setStatus] = useState<ArrStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setService(null); setStatus(null); setNote(null);
    api.arrConfig()
      .then((c) => {
        if (!live || !c.configured) return;
        setService(c.service ?? "chaptarr");
        api.arrStatus(itemId).then((s) => live && setStatus(s)).catch(() => undefined);
      })
      .catch(() => undefined);   // Codex down / old Codex: just no button
    return () => { live = false; };
  }, [itemId]);

  if (!service) return null;
  const name = LABEL[service] ?? "your downloader";

  async function onClick() {
    setBusy(true); setNote(null);
    try {
      const r = await api.arrMonitor(itemId, "both");
      setNote(r.message || (r.ok ? "Monitoring — it will download when a release is available." : "Couldn't monitor this book."));
      api.arrStatus(itemId).then(setStatus).catch(() => undefined);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't monitor this book.");
    } finally {
      setBusy(false);
    }
  }

  const inLibrary = !!status?.present && !!status?.monitored && !!status?.has_files;
  const monitored = !!status?.present && !!status?.monitored;
  const label = busy ? "Working…"
    : inLibrary ? `In ${name} ✓`
    : monitored ? `Monitored in ${name}`
    : `Monitor & download in ${name}`;
  return (
    <>
      <button className="btn btn-secondary" style={{ width: "auto" }} disabled={busy || inLibrary} onClick={onClick}
        title={monitored && !inLibrary ? "Already monitored — it downloads when a release is available. Click to search again." : undefined}>
        {label}
      </button>
      {note && <span className="sub" style={{ alignSelf: "center" }}>{note}</span>}
    </>
  );
}
