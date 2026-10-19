import { createContext, ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Bookmark, BookDetail, Chapter, PlaySession, PlaySyncBody } from "../api/client";
import { useReadAlong } from "./useReadAlong";
import { progressionAt } from "./syncMap";
import { audioTimeOfSavedReading } from "./readingSpot";
import { tagTitle } from "./bookmarkTitle";
import { chapterIndexAt, LabeledChapter, nextChapterStart, previousChapterStart } from "./chapters";
import { useBookChapters } from "./useBookChapters";
import { useHeardChapters } from "./useHeardChapters";

const SYNC_INTERVAL_MS = 15_000;
// Audiobookshelf holds a position this far from the one this tab last knew → another device saved since. Matches
// the server's own check (backend/app/core/progress_guard.py), which is what actually refuses the older write.
const MOVED_ELSEWHERE_S = 30;
// While paused and in view, look for another device's progress every Nth sync tick (N × 15 s = a minute).
const PAUSED_CHECK_EVERY_TICKS = 4;
// Pressing play checks first only when the last look is older than this, so play stays instant in the usual case.
const PLAY_CHECK_AFTER_MS = 20_000;
// A seek is saved this long after the last one, without waiting for the next sync tick.
const SEEK_SAVE_DELAY_MS = 2_000;
export const SLEEP_OPTIONS = [0, 15, 30, 45, 60]; // minutes, 0 = off
// Mirrors the mobile app's own PlaybackControllerImpl: a jump of at least
// this many seconds — a chapter tap, a scrubber drag, several skips in a
// row — auto-drops a "you were here" bookmark at the position you jumped
// FROM, so an accidental big seek is always one tap away from undoing.
const AUTO_BOOKMARK_JUMP_S = 120;

export function formatTime(totalS: number): string {
  if (!Number.isFinite(totalS) || totalS < 0) totalS = 0;
  const s = Math.floor(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Which track covers overall second [posS], and how far into it. */
function locate(tracks: PlaySession["tracks"], posS: number): { index: number; withinS: number } {
  let idx = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].startOffsetS <= posS) idx = i;
  }
  return { index: idx, withinS: Math.max(0, posS - tracks[idx].startOffsetS) };
}

/** POST with sendBeacon so it actually fires on tab-close or when the tab is hidden —
 *  a plain fetch() gets cancelled the instant the page unloads. */
function beacon(path: string, body: object) {
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  navigator.sendBeacon(path, blob);
}
function closeBeacon(itemId: string, body: PlaySyncBody) {
  beacon(`/api/play/${itemId}/close`, body);
}
function syncBeacon(itemId: string, body: PlaySyncBody) {
  beacon(`/api/play/${itemId}/sync`, body);
}

/** Whether this tab's last attempts to save the position reached Audiobookshelf — shown in the player so a
 *  silent failure can't go on for hours. */
export interface SyncStatus {
  /** When the position was last saved (ms), or null if not yet this session. */
  savedAt: number | null;
  /** The last attempt failed and is being retried. */
  failing: boolean;
}

interface PlaybackState {
  itemId: string | null;
  book: BookDetail | null;
  session: PlaySession | null;
  error: string | null;
  trackIndex: number;
  positionS: number;
  isPlaying: boolean;
  speed: number;
  sleepIdx: number;
  sleepRemainingS: number | null;
  bookmarks: Bookmark[];
  resumeNotice: string | null;
  syncStatus: SyncStatus;
  readAlong: ReturnType<typeof useReadAlong>;
  audioRef: React.RefObject<HTMLAudioElement>;
  // Not React.RefObject<number> — that type allows `current: null`, which
  // this ref never actually is (initialized to 0, always a real number).
  positionRef: { readonly current: number };
  play: (itemId: string) => void;
  seekTo: (targetS: number) => void;
  skip: (deltaS: number) => void;
  /** Previous (-1) / next (1) chapter: previous restarts the current chapter, or goes back one near its start. */
  skipChapter: (direction: 1 | -1) => void;
  /** The book's chapters as shown: the file's own or — when the file only counts them — the ebook's contents placed
   *  by the read-along map (docs/CHAPTERS.md). */
  chapters: Chapter[];
  /** The audio second the saved reading position is narrated at (page-exact when known), or null. */
  readingAheadS: number | null;
  /** "Chapter 33: The Gate" for the chapter playing now (null with no chapters). */
  chapterLabel: string | null;
  /** Every chapter's number/name/label — what the narrator said when Codex has listened to the book, else from the titles. */
  chapterLabels: LabeledChapter[];
  togglePlayPause: () => void;
  cycleSpeed: () => void;
  cycleSleep: () => void;
  addBookmark: (timeS: number, title: string) => Promise<void>;
  removeBookmark: (timeS: number) => Promise<void>;
  discardProgress: () => Promise<void>;
  jumpToText: () => void;
  jumpToReadingPosition: () => void;
  stop: () => void;
  /** Player.tsx calls this when it applies a ?atTime= override (from
   *  Reader's "Jump to audio" link) so the auto-resume-from-reading effect
   *  below doesn't immediately fight it back to the reading position. */
  markExplicitJump: () => void;
}

const PlaybackContext = createContext<PlaybackState | null>(null);

export function usePlayback(): PlaybackState {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error("usePlayback() must be used inside PlaybackProvider");
  return ctx;
}

/** Owns the <audio> element and everything about audiobook playback, mounted
 *  ONCE above the router — so navigating between Library/Series/BookDetail/
 *  etc. while listening doesn't unmount the audio element the way it used to
 *  when this all lived inside the Player page component. Player.tsx and
 *  MiniPlayer.tsx are both just views over this same state now. */
export function PlaybackProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [itemId, setItemId] = useState<string | null>(null);
  const [book, setBook] = useState<BookDetail | null>(null);
  const [session, setSession] = useState<PlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackIndex, setTrackIndex] = useState(0);
  const [positionS, setPositionS] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sleepIdx, setSleepIdx] = useState(0);
  const [sleepRemainingS, setSleepRemainingS] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ savedAt: null, failing: false });

  // Enabled when this item has its own ebook, OR a DIFFERENT item is the
  // same work's ebook edition (pairedItemId — see catalog_match.py). The
  // anchor stays THIS (audio) item's id either way — the align gateway
  // keys status/maps by the audio item, and requestBuild() below passes
  // pairedItemId as the ebookItemId when there's no native one.
  const readAlong = useReadAlong(itemId ?? undefined, !!(book?.hasEbook || book?.pairedItemId));
  const explicitJumpRef = useRef(false);
  const autoResumedRef = useRef(false);
  // Guards against a stale response landing after a second play() call (e.g.
  // rapidly clicking between two different books' pages before the first
  // one's fetch even resolves) — only the MOST RECENT call's result applies.
  const loadTokenRef = useRef(0);

  // Mutable session bookkeeping that effects need without re-subscribing.
  // `knownServerS` is the position Audiobookshelf held when we last looked or wrote — sent with every save so the
  // server can refuse to replace a newer place another device has saved (progress_guard.py). `dirty` is "played or
  // moved since the last confirmed save".
  const stateRef = useRef({ timeListenedS: 0, lastSyncPos: 0, sessionId: "", durationS: 0, knownServerS: 0, dirty: false });
  // The latest of everything an event listener or timer (registered once) needs, so none runs on a stale render.
  const itemIdRef = useRef<string | null>(null);
  const isPlayingRef = useRef(false);
  const seekSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCheckRef = useRef(0);
  const pickingUpRef = useRef(false);
  const latestRef = useRef<{ syncNow: (o?: { beacon?: boolean }) => Promise<void>; pickUp: () => Promise<boolean> } | null>(null);
  // A seek requested before the browser has metadata for the (possibly just
  // swapped) track is silently dropped if applied synchronously — browsers
  // don't know the seekable range yet. Stash it here and apply it from
  // onLoadedMetadata instead, which is the point a seek reliably sticks.
  const pendingSeekRef = useRef<{ withinS: number; thenPlay: boolean } | null>(null);
  // Mirrors positionS for the sync interval below to read without depending on
  // it directly — positionS changes on every timeupdate (several times a
  // second), and an effect keyed on it would tear down/recreate the interval
  // that often, so the 15s sync would never actually survive to fire.
  const heardChapters = useHeardChapters(itemId);
  const sourceChapters = useMemo(() => session?.chapters ?? [], [session]);
  const { chapters, labels: chapterLabels } = useBookChapters({
    chapters: sourceChapters,
    heard: heardChapters,
    ebookItemId: book ? (book.hasEbook ? itemId : book.pairedItemId) : null,
    map: readAlong.map,
  });
  const chapterIdx = chapterIndexAt(chapters, positionS);
  const chapterLabel = chapterIdx >= 0 ? chapterLabels[chapterIdx].label : null;

  // The latest chapter list for handlers that outlive a render (the OS media-session buttons).
  const chaptersRef = useRef<{ startS: number }[]>([]);
  chaptersRef.current = chapters;
  const positionRef = useRef(0);
  useEffect(() => {
    positionRef.current = positionS;
  }, [positionS]);
  itemIdRef.current = itemId;
  isPlayingRef.current = isPlaying;
  const trackIndexRef = useRef(0);
  trackIndexRef.current = trackIndex;

  /** Starts (or switches to) a book. Closes whatever session was already
   *  open first — this is the ONLY place a session gets closed short of an
   *  explicit discard or the tab actually closing, since playback is now
   *  meant to survive ordinary in-app navigation. */
  function play(newItemId: string) {
    if (newItemId === itemId && (session || error)) {
      // Already loaded — but this tab may have sat for hours while another device moved on: look before resuming.
      if (!isPlayingRef.current) void latestRef.current?.pickUp();
      return;
    }
    const prev = stateRef.current;
    if (prev.sessionId && itemId) {
      closeBeacon(itemId, {
        sessionId: prev.sessionId,
        currentTimeS: positionRef.current,
        timeListenedS: prev.timeListenedS,
        durationS: prev.durationS,
        knownServerS: prev.knownServerS,
      });
    }
    if (seekSaveTimerRef.current) clearTimeout(seekSaveTimerRef.current);
    setItemId(newItemId);
    setBook(null);
    setSession(null);
    setError(null);
    setResumeNotice(null);
    explicitJumpRef.current = false;
    autoResumedRef.current = false;
    stateRef.current = { timeListenedS: 0, lastSyncPos: 0, sessionId: "", durationS: 0, knownServerS: 0, dirty: false };
    setSyncStatus({ savedAt: null, failing: false });
    lastCheckRef.current = Date.now();

    const token = ++loadTokenRef.current;
    Promise.all([
      api.item(newItemId),
      api.play(newItemId),
      api.bookmarks(newItemId).catch(() => []),
      api.settings().catch(() => null),
    ])
      .then(([b, s, marks, prefs]) => {
        if (loadTokenRef.current !== token) return; // a newer play() call superseded this one
        setBook(b);
        setSession(s);
        setBookmarks(marks);
        if (prefs) setSpeed(prefs.playbackSpeed);
        stateRef.current.sessionId = s.sessionId;
        stateRef.current.durationS = s.durationS;
        const { index, withinS } = locate(s.tracks, s.currentTimeS);
        setTrackIndex(index);
        setPositionS(s.currentTimeS);
        stateRef.current.lastSyncPos = s.currentTimeS;
        stateRef.current.knownServerS = s.currentTimeS;
        pendingSeekRef.current = { withinS, thenPlay: false };
      })
      .catch((e) => {
        if (loadTokenRef.current !== token) return;
        setError(e instanceof Error ? e.message : "Couldn't open this book.");
      });
  }

  function markExplicitJump() {
    explicitJumpRef.current = true;
  }

  // Now the <audio> element has a real src to load — the pending seek itself
  // is applied from onLoadedMetadata.
  useEffect(() => {
    if (!session) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = session.tracks[trackIndex].streamUrl;
    audio.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Close the session when the tab actually closes — registered once, not
  // per-book, since this context itself never unmounts. The server refuses to let this replace a newer place
  // another device saved (knownServerS), so a tab left open for hours can't undo the phone's progress on the way out.
  useEffect(() => {
    const onUnload = () => {
      const st = stateRef.current;
      const id = itemIdRef.current;
      if (!st.sessionId || !id) return;
      closeBeacon(id, { sessionId: st.sessionId, currentTimeS: positionRef.current, timeListenedS: st.timeListenedS, durationS: st.durationS, knownServerS: st.knownServerS });
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
  }, []);

  /** Saves the position now. The server answers `skipped` when another device has saved a newer one since this tab
   *  last looked; this tab then moves there instead (adoptServerPosition). A failure is kept and retried. */
  async function syncNow(opts: { beacon?: boolean } = {}) {
    const id = itemIdRef.current;
    const st = stateRef.current;
    if (!id || !st.sessionId) return;
    const pos = positionRef.current;
    const listened = Math.max(0, pos - st.lastSyncPos);
    const body: PlaySyncBody = { sessionId: st.sessionId, currentTimeS: pos, timeListenedS: listened, durationS: st.durationS, knownServerS: st.knownServerS };
    const prevLast = st.lastSyncPos;
    st.timeListenedS += listened;
    st.lastSyncPos = pos;
    if (opts.beacon) {
      // The tab is being hidden: nothing can read the answer, but the server applies the same check.
      syncBeacon(id, body);
      st.knownServerS = pos;
      st.dirty = false;
      return;
    }
    try {
      const r = await api.sync(id, body);
      if (itemIdRef.current !== id || stateRef.current !== st) return; // switched book meanwhile
      if (r.skipped && r.serverTimeS !== undefined) {
        audioRef.current?.pause();
        adoptServerPosition(r.serverTimeS, "Your place moved on another device, so this one stopped and followed");
        return;
      }
      st.knownServerS = pos;
      if (positionRef.current === pos) st.dirty = false;
      setSyncStatus({ savedAt: Date.now(), failing: false });
    } catch {
      // Not saved: take the listening time back and try again on the next tick.
      st.lastSyncPos = prevLast;
      st.timeListenedS -= listened;
      st.dirty = true;
      setSyncStatus((cur) => ({ ...cur, failing: true }));
    }
  }

  /** Moves this tab to the position another device saved, with a note saying so (and where this one was). */
  function adoptServerPosition(serverS: number, lead: string) {
    const st = stateRef.current;
    const from = positionRef.current;
    st.knownServerS = serverS;
    seekTo(serverS, { fromServer: true });
    setResumeNotice(`${lead} — ${formatTime(serverS)} (this one was at ${formatTime(from)})`);
  }

  /** Asks Audiobookshelf where the book is now; when another device has moved it, this tab follows. Resolves true
   *  when it moved. Never runs while audio is playing here (the server's check covers that case). */
  async function pickUp(): Promise<boolean> {
    const id = itemIdRef.current;
    const st = stateRef.current;
    if (!id || !st.sessionId || pickingUpRef.current) return false;
    pickingUpRef.current = true;
    lastCheckRef.current = Date.now();
    try {
      const p = await api.audioPosition(id);
      if (itemIdRef.current !== id || stateRef.current !== st || p.currentTimeS === null) return false;
      if (Math.abs(p.currentTimeS - st.knownServerS) <= MOVED_ELSEWHERE_S) return false;
      adoptServerPosition(p.currentTimeS, "Continued from your other device");
      return true;
    } catch {
      return false;
    } finally {
      pickingUpRef.current = false;
    }
  }
  latestRef.current = { syncNow, pickUp };

  // ── Saving the position ──────────────────────────────────────────────────
  // Every 15 s while playing — and, if a save failed or a seek is still unsaved, while paused too; when paused and
  // in view it instead looks (about once a minute) for progress another device has made.
  const tickRef = useRef(0);
  useEffect(() => {
    if (!itemId) return;
    const handle = setInterval(() => {
      const st = stateRef.current;
      if (!st.sessionId) return;
      tickRef.current++;
      if (isPlayingRef.current || st.dirty) void latestRef.current?.syncNow();
      else if (document.visibilityState === "visible" && tickRef.current % PAUSED_CHECK_EVERY_TICKS === 0) void latestRef.current?.pickUp();
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [itemId]);

  // Leaving the tab saves at once (a hidden tab may be frozen or discarded); coming back looks for the other
  // device's progress; the network returning retries a failed save.
  useEffect(() => {
    const onVisibility = () => {
      const st = stateRef.current;
      if (document.visibilityState === "hidden") {
        if (st.sessionId && (isPlayingRef.current || st.dirty)) void latestRef.current?.syncNow({ beacon: true });
      } else if (!isPlayingRef.current) {
        void latestRef.current?.pickUp();
      }
    };
    const onOnline = () => {
      if (stateRef.current.dirty) void latestRef.current?.syncNow();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("online", onOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  // ── Sleep timer ───────────────────────────────────────────────────────────
  useEffect(() => {
    if (sleepRemainingS === null) return;
    if (sleepRemainingS <= 0) {
      audioRef.current?.pause();
      setSleepRemainingS(null);
      setSleepIdx(0);
      return;
    }
    const t = setTimeout(() => setSleepRemainingS((r) => (r === null ? null : r - 1)), 1000);
    return () => clearTimeout(t);
  }, [sleepRemainingS]);

  // ── Media Session (OS / lock-screen controls) — now correct everywhere in
  // the app, not just on the Player page, since this effect lives here. ────
  useEffect(() => {
    if (!("mediaSession" in navigator) || !book) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author ?? undefined,
      album: chapterLabel ?? undefined, // the lock screen shows which chapter you're in
      artwork: [{ src: book.coverUrl, sizes: "400x400", type: "image/jpeg" }],
    });
    navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => skip(-30));
    navigator.mediaSession.setActionHandler("seekforward", () => skip(30));
    navigator.mediaSession.setActionHandler("previoustrack", () => skipChapter(-1));
    navigator.mediaSession.setActionHandler("nexttrack", () => skipChapter(1));
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekbackward", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
      navigator.mediaSession.setActionHandler("previoustrack", null);
      navigator.mediaSession.setActionHandler("nexttrack", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book, chapterLabel]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // ── Auto-resume from reading, if you've read further than you've listened ──
  // Where the saved reading position is narrated — the very sentence at the top of the page you stopped on when the
  // reader saved it (readingSpot.ts), else the whole-book fraction. null while it is being worked out, {s: null}
  // when there is nothing to map.
  const [readingSpot, setReadingSpot] = useState<{ s: number | null } | null>(null);
  useEffect(() => {
    setReadingSpot(null);
    const ebookId = book ? (book.hasEbook ? itemId : book.pairedItemId) : null;
    if (!book || !ebookId || !readAlong.map) return;
    let cancelled = false;
    audioTimeOfSavedReading(readAlong.map, ebookId, book.ebookProgress).then((s) => {
      if (!cancelled) setReadingSpot({ s });
    });
    return () => { cancelled = true; };
  }, [book, itemId, readAlong.map]);
  const readingAheadS = readingSpot?.s ?? null;

  useEffect(() => {
    if (autoResumedRef.current || explicitJumpRef.current) return;
    if (!book || !session || !readAlong.map || !readingSpot) return;
    autoResumedRef.current = true; // decide now, whichever way — never re-run
    if (!(book.hasEbook || book.pairedItemId) || book.ebookProgress <= book.audioProgress) return;
    const mappedS = readingSpot.s;
    if (mappedS === null || mappedS - positionRef.current <= 20) return; // not meaningfully ahead
    seekTo(mappedS);
    setResumeNotice(`Resumed from your reading progress — ${formatTime(mappedS)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAlong.map, book, session, readingSpot]);

  /** [fromServer]: the move is following another device's saved position, so it isn't a "jump" worth a "Left off"
   *  bookmark and there is nothing of ours to save. */
  function seekTo(targetS: number, opts: { fromServer?: boolean } = {}) {
    if (!session) return;
    const clamped = Math.max(0, Math.min(session.durationS, targetS));
    const { index, withinS } = locate(session.tracks, clamped);
    const audio = audioRef.current;
    if (!audio) return;
    if (!opts.fromServer) maybeAutoBookmark(positionRef.current, clamped);
    if (index !== trackIndexRef.current) {
      const wasPlaying = !audio.paused;
      pendingSeekRef.current = { withinS, thenPlay: wasPlaying };
      audio.src = session.tracks[index].streamUrl;
      setTrackIndex(index);
      audio.load();
    } else {
      audio.currentTime = withinS;
    }
    setPositionS(clamped);
    positionRef.current = clamped;
    stateRef.current.lastSyncPos = clamped;
    if (!opts.fromServer) {
      // Save a move soon after it's made, not on the next tick — a phone picked up a moment later finds it.
      stateRef.current.dirty = true;
      if (seekSaveTimerRef.current) clearTimeout(seekSaveTimerRef.current);
      seekSaveTimerRef.current = setTimeout(() => void latestRef.current?.syncNow(), SEEK_SAVE_DELAY_MS);
    }
  }

  function skip(deltaS: number) {
    seekTo(positionRef.current + deltaS);
  }

  function skipChapter(direction: 1 | -1) {
    const chapters = chaptersRef.current;
    const target = direction > 0 ? nextChapterStart(chapters, positionRef.current) : previousChapterStart(chapters, positionRef.current);
    if (target !== null) seekTo(target);
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (!audio.paused) {
      audio.pause();
      return;
    }
    const start = () => audio.play().catch(() => setError("Playback failed — try again."));
    // A tab that has been open a while may be behind another device: look first (at most ~1 s), then play from
    // wherever the book really is — never start from a stale place and save it over the newer one.
    if (Date.now() - lastCheckRef.current > PLAY_CHECK_AFTER_MS && stateRef.current.sessionId) {
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1200));
      void Promise.race([pickUp(), timeout]).then(start, start);
    } else {
      start();
    }
  }

  function onTrackEnded() {
    if (!session) return;
    const next = trackIndex + 1;
    const audio = audioRef.current;
    if (!audio) return;
    if (next < session.tracks.length) {
      pendingSeekRef.current = { withinS: 0, thenPlay: true };
      audio.src = session.tracks[next].streamUrl;
      setTrackIndex(next);
      audio.load();
    } else {
      setIsPlaying(false);
    }
  }

  function onLoadedMetadata() {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = speed;
    const pending = pendingSeekRef.current;
    if (!pending) return;
    pendingSeekRef.current = null;
    audio.currentTime = pending.withinS;
    if (pending.thenPlay) audio.play().catch(() => {});
  }

  function jumpToText() {
    if (!itemId || !readAlong.map) return;
    const p = progressionAt(readAlong.map, positionRef.current);
    if (p === null) return;
    // This item's own ebook if it has one, otherwise the paired item that
    // supplied the ebook side of the read-along map (see pairedItemId).
    const readItemId = book?.hasEbook ? itemId : book?.pairedItemId ?? itemId;
    // atTime lets the reader open on the very sentence being spoken; atProgression is its fallback.
    navigate(`/read/${readItemId}?atProgression=${p}&atTime=${positionRef.current.toFixed(1)}`);
  }

  function jumpToReadingPosition() {
    if (readingAheadS === null) return;
    seekTo(readingAheadS);
  }

  function cycleSpeed() {
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const next = speeds[(speeds.indexOf(speed) + 1) % speeds.length];
    setSpeed(next);
    if (audioRef.current) audioRef.current.playbackRate = next;
    api.updateSettings({ playbackSpeed: next }).catch(() => {});
  }

  function cycleSleep() {
    const next = (sleepIdx + 1) % SLEEP_OPTIONS.length;
    setSleepIdx(next);
    const minutes = SLEEP_OPTIONS[next];
    setSleepRemainingS(minutes > 0 ? minutes * 60 : null);
  }

  /** Fire-and-forget, and deliberately silent on failure — an auto-bookmark
   *  is a background safety net, not a user-requested action. */
  function maybeAutoBookmark(fromS: number, toS: number) {
    if (!itemId || fromS < 1.0 || Math.abs(toS - fromS) < AUTO_BOOKMARK_JUMP_S) return;
    // Named like the Audex player names its own: where you were.
    const title = `Left off · ${formatTime(fromS)}`;
    api
      .addBookmark(itemId, { timeS: fromS, title })
      .then(() => setBookmarks((prev) => [...prev, { timeS: Math.max(1, Math.round(fromS)), title: tagTitle(title), createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS)))
      .catch(() => {});
  }

  async function addBookmark(timeS: number, title: string) {
    if (!itemId) return;
    await api.addBookmark(itemId, { timeS, title });
    setBookmarks((prev) => [...prev, { timeS: Math.max(1, Math.round(timeS)), title: tagTitle(title), createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS));
  }

  async function removeBookmark(timeS: number) {
    if (!itemId) return;
    const prev = bookmarks;
    setBookmarks(prev.filter((b) => b.timeS !== timeS)); // optimistic — a failed delete is rare and low-stakes to retry
    try {
      await api.removeBookmark(itemId, timeS);
    } catch {
      setBookmarks(prev);
    }
  }

  async function discardProgress() {
    if (!itemId) return;
    // Stop first — a still-playing session would just write its position
    // straight back on the next sync tick, resurrecting what was just wiped.
    audioRef.current?.pause();
    stateRef.current.sessionId = ""; // suppresses the periodic sync + pagehide close
    if (seekSaveTimerRef.current) clearTimeout(seekSaveTimerRef.current);
    await api.discardAudioProgress(itemId);
    stop();
    navigate("/");
  }

  /** Stops playback and clears the now-playing state entirely (the
   *  mini-player's "×" and the Player page after a discard both use this) —
   *  distinct from play()'s own session-close-then-load-new, which never
   *  leaves the app with no book loaded. */
  function stop() {
    loadTokenRef.current++; // invalidate any in-flight play() so it can't land after this
    audioRef.current?.pause();
    setItemId(null);
    setBook(null);
    setSession(null);
    setBookmarks([]);
    setIsPlaying(false);
  }

  const value: PlaybackState = {
    itemId,
    book,
    session,
    error,
    trackIndex,
    positionS,
    isPlaying,
    speed,
    sleepIdx,
    sleepRemainingS,
    bookmarks,
    resumeNotice,
    syncStatus,
    readAlong,
    audioRef,
    positionRef,
    play,
    seekTo,
    skip,
    skipChapter,
    chapters,
    readingAheadS,
    chapterLabel,
    chapterLabels,
    togglePlayPause,
    cycleSpeed,
    cycleSleep,
    addBookmark,
    removeBookmark,
    discardProgress,
    jumpToText,
    jumpToReadingPosition,
    stop,
    markExplicitJump,
  };

  return (
    <PlaybackContext.Provider value={value}>
      {children}
      {/* Rendered ONCE, here, outside every route — this is what makes
          playback survive navigating around the app. */}
      <audio
        ref={audioRef}
        onPlay={() => {
          stateRef.current.dirty = true; // playing moves the place: it must reach the server even if paused again
          setIsPlaying(true);
        }}
        onPause={() => {
          setIsPlaying(false);
          void syncNow(); // the place you stopped at, now — not up to 15 s later (or never, on a closed tab)
        }}
        onEnded={onTrackEnded}
        onTimeUpdate={(e) => {
          if (!session) return;
          const audio = e.currentTarget;
          const track = session.tracks[trackIndex];
          setPositionS(track.startOffsetS + audio.currentTime);
        }}
        onLoadedMetadata={onLoadedMetadata}
      />
    </PlaybackContext.Provider>
  );
}
