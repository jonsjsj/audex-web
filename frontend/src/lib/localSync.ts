/** Where the book is, kept on THIS device by whichever of the reader and the player moved last — so switching between
 *  reading and listening (or two tabs) finds the place at once, without waiting for the server round trip that carries it
 *  to Audiobookshelf and Codex later. Keyed by the audiobook's item id (the read-along map's anchor). Per-device
 *  convenience only: storage may be blocked or empty, and everything here must then simply do nothing. */

export type Medium = "reader" | "player";

export interface LocalPos {
  /** The audio second narrating the spot (the first words on the page, when it was the reader that moved). */
  audioS: number;
  /** The same spot as a whole-book fraction, 0..1. */
  progress: number;
  by: Medium;
  /** When it was written (ms). */
  at: number;
}

const PREFIX = "audexweb.pos.";
/** A saved spot is a hand-over between the two screens, not a record: after this long the server's position wins. */
export const FRESH_MS = 6 * 60 * 60 * 1000;
/** Positions this close (in seconds) are the same place. */
export const SAME_SPOT_S = 3;

export function writeLocalPos(key: string, pos: Omit<LocalPos, "at">, now: number = Date.now()): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ ...pos, at: now }));
  } catch {
    /* storage blocked or full — the server path still works */
  }
}

export function readLocalPos(key: string): LocalPos | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? parseLocalPos(raw) : null;
  } catch {
    return null;
  }
}

export function parseLocalPos(raw: string): LocalPos | null {
  try {
    const v = JSON.parse(raw) as Partial<LocalPos>;
    if (typeof v.audioS !== "number" || !Number.isFinite(v.audioS) || v.audioS < 0) return null;
    if (typeof v.progress !== "number" || !Number.isFinite(v.progress)) return null;
    if (v.by !== "reader" && v.by !== "player") return null;
    if (typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
    return { audioS: v.audioS, progress: v.progress, by: v.by, at: v.at };
  } catch {
    return null;
  }
}

export function isFresh(p: LocalPos, now: number = Date.now()): boolean {
  return now - p.at >= 0 && now - p.at <= FRESH_MS;
}

/** Should the player move to where the reader last was? Only when it was the reader that moved last, recently, and the audio
 *  is not already there. */
export function shouldAdoptForAudio(p: LocalPos | null, currentAudioS: number, now: number = Date.now()): p is LocalPos {
  return !!p && p.by === "reader" && isFresh(p, now) && Math.abs(p.audioS - currentAudioS) > SAME_SPOT_S;
}

/** Should the reader move to where the audio last was? Only when the player moved last, recently, and the page is not
 *  already within [slackProgress] of it. */
export function shouldAdoptForReader(p: LocalPos | null, currentProgress: number, slackProgress: number, now: number = Date.now()): p is LocalPos {
  return !!p && p.by === "player" && isFresh(p, now) && Math.abs(p.progress - currentProgress) > slackProgress;
}

/** Call [cb] when ANOTHER tab of this site writes the position of [key] (the storage event never fires in the writing tab). */
export function onLocalPosFromOtherTab(key: string, cb: (p: LocalPos) => void): () => void {
  const handler = (e: StorageEvent) => {
    if (e.key !== PREFIX + key || !e.newValue) return;
    const p = parseLocalPos(e.newValue);
    if (p) cb(p);
  };
  window.addEventListener("storage", handler);
  return () => window.removeEventListener("storage", handler);
}
