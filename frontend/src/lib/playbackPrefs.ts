// Playback preferences that belong to this browser, not the account (the Audex app keeps its own per phone too).

/** "Back up on resume": the most seconds Play steps back after a pause. 0 = off. */
export const BACK_UP_CHOICES = [0, 5, 10, 30] as const;
const BACK_UP_KEY = "audexweb.backUpOnResume";
export const BACK_UP_DEFAULT_S = 10;

export function loadBackUpOnResumeS(): number {
  try {
    const raw = localStorage.getItem(BACK_UP_KEY);
    if (raw === null) return BACK_UP_DEFAULT_S;
    const n = Number(raw);
    return (BACK_UP_CHOICES as readonly number[]).includes(n) ? n : BACK_UP_DEFAULT_S;
  } catch {
    return BACK_UP_DEFAULT_S; // storage blocked — the default is fine
  }
}

export function saveBackUpOnResumeS(seconds: number): void {
  try {
    localStorage.setItem(BACK_UP_KEY, String(seconds));
  } catch {
    /* per-device convenience only */
  }
}
