import { useEffect, useRef, useState } from "react";
import { api, ReadAlongStatus, SyncMap } from "../api/client";

const POLL_MS = 4000;
const _RUNNING_STATES = new Set(["queued", "downloading", "extracting", "transcribing", "aligning"]);

/** Status polling + map fetching for one book's read-along, shared by Player
 *  and Reader. [enabled] gates the whole thing on "this book even has the
 *  other format" — no point checking status for a book that can never have
 *  a map (see docs/SYNC_API.md §3's "needs both an audio and an ebook
 *  edition" note). */
export function useReadAlong(itemId: string | undefined, enabled: boolean) {
  const [status, setStatus] = useState<ReadAlongStatus | null>(null);
  const [map, setMap] = useState<SyncMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Avoids a second, stale-closure map fetch once one is already in flight/done.
  const mapFetchedRef = useRef(false);

  useEffect(() => {
    if (!itemId || !enabled) return;
    let cancelled = false;
    // A single self-rescheduling timeout, not setInterval: each poll waits
    // for the PREVIOUS request to finish before scheduling the next, so a
    // slow/hung request can't pile up overlapping polls the way a fixed-
    // period setInterval would.
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function poll() {
      try {
        const s = await api.readAlongStatus(itemId!);
        if (cancelled) return;
        setStatus(s);
        if (_RUNNING_STATES.has(s.state)) {
          timer = setTimeout(poll, POLL_MS);
        }
      } catch {
        // A transient failure shouldn't kill the poll loop — try again later.
        if (!cancelled) timer = setTimeout(poll, POLL_MS);
      }
    }
    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [itemId, enabled]);

  useEffect(() => {
    if (!itemId || !status?.available || mapFetchedRef.current) return;
    mapFetchedRef.current = true;
    api.readAlongMap(itemId).then(setMap).catch(() => {
      mapFetchedRef.current = false; // let a transient fetch failure retry on the next status tick
    });
  }, [itemId, status]);

  async function requestBuild(ebookItemId?: string) {
    if (!itemId) return;
    setError(null);
    try {
      const res = await api.readAlongBuild(itemId, ebookItemId);
      setStatus((prev) => ({
        configured: true,
        available: res.state === "done",
        state: res.state ?? "queued",
        progress: prev?.progress ?? 0,
        etaSeconds: res.eta_seconds ?? null,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't start word sync.");
    }
  }

  return { status, map, error, requestBuild };
}
