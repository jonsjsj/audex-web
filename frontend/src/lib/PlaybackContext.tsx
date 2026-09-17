import { createContext, ReactNode, useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Bookmark, BookDetail, PlaySession } from "../api/client";
import { useReadAlong } from "./useReadAlong";
import { progressionAt, timeAtProgression } from "./syncMap";
import { bookmarkTitle } from "./platform";

const SYNC_INTERVAL_MS = 15_000;
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

/** POST close with sendBeacon so it actually fires on tab-close —
 *  a plain fetch() gets cancelled the instant the page unloads. */
function closeBeacon(itemId: string, body: object) {
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  navigator.sendBeacon(`/api/play/${itemId}/close`, blob);
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
  readAlong: ReturnType<typeof useReadAlong>;
  audioRef: React.RefObject<HTMLAudioElement>;
  // Not React.RefObject<number> — that type allows `current: null`, which
  // this ref never actually is (initialized to 0, always a real number).
  positionRef: { readonly current: number };
  play: (itemId: string) => void;
  seekTo: (targetS: number) => void;
  skip: (deltaS: number) => void;
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

  const readAlong = useReadAlong(itemId ?? undefined, book?.hasEbook ?? false);
  const explicitJumpRef = useRef(false);
  const autoResumedRef = useRef(false);
  // Guards against a stale response landing after a second play() call (e.g.
  // rapidly clicking between two different books' pages before the first
  // one's fetch even resolves) — only the MOST RECENT call's result applies.
  const loadTokenRef = useRef(0);

  // Mutable session bookkeeping that effects need without re-subscribing.
  const stateRef = useRef({ timeListenedS: 0, lastSyncPos: 0, sessionId: "", durationS: 0 });
  // A seek requested before the browser has metadata for the (possibly just
  // swapped) track is silently dropped if applied synchronously — browsers
  // don't know the seekable range yet. Stash it here and apply it from
  // onLoadedMetadata instead, which is the point a seek reliably sticks.
  const pendingSeekRef = useRef<{ withinS: number; thenPlay: boolean } | null>(null);
  // Mirrors positionS for the sync interval below to read without depending on
  // it directly — positionS changes on every timeupdate (several times a
  // second), and an effect keyed on it would tear down/recreate the interval
  // that often, so the 15s sync would never actually survive to fire.
  const positionRef = useRef(0);
  useEffect(() => {
    positionRef.current = positionS;
  }, [positionS]);

  /** Starts (or switches to) a book. Closes whatever session was already
   *  open first — this is the ONLY place a session gets closed short of an
   *  explicit discard or the tab actually closing, since playback is now
   *  meant to survive ordinary in-app navigation. */
  function play(newItemId: string) {
    if (newItemId === itemId && (session || error)) return; // already loaded/loading this book
    const prev = stateRef.current;
    if (prev.sessionId && itemId) {
      closeBeacon(itemId, {
        sessionId: prev.sessionId,
        currentTimeS: positionRef.current,
        timeListenedS: prev.timeListenedS,
        durationS: prev.durationS,
      });
    }
    setItemId(newItemId);
    setBook(null);
    setSession(null);
    setError(null);
    setResumeNotice(null);
    explicitJumpRef.current = false;
    autoResumedRef.current = false;
    stateRef.current = { timeListenedS: 0, lastSyncPos: 0, sessionId: "", durationS: 0 };

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
  // per-book, since this context itself never unmounts.
  useEffect(() => {
    const onUnload = () => {
      const st = stateRef.current;
      if (!st.sessionId || !itemId) return;
      closeBeacon(itemId, { sessionId: st.sessionId, currentTimeS: positionRef.current, timeListenedS: st.timeListenedS, durationS: st.durationS });
    };
    window.addEventListener("pagehide", onUnload);
    return () => window.removeEventListener("pagehide", onUnload);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // ── Periodic position sync while playing ─────────────────────────────────
  useEffect(() => {
    if (!isPlaying || !itemId) return;
    const handle = setInterval(() => {
      const st = stateRef.current;
      if (!st.sessionId) return;
      const pos = positionRef.current;
      const listened = Math.max(0, pos - st.lastSyncPos);
      st.timeListenedS += listened;
      st.lastSyncPos = pos;
      api
        .sync(itemId, { sessionId: st.sessionId, currentTimeS: pos, timeListenedS: listened, durationS: st.durationS })
        .catch(() => {});
    }, SYNC_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [isPlaying, itemId]);

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
      artwork: [{ src: book.coverUrl, sizes: "400x400", type: "image/jpeg" }],
    });
    navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => skip(-30));
    navigator.mediaSession.setActionHandler("seekforward", () => skip(30));
    return () => {
      navigator.mediaSession.setActionHandler("play", null);
      navigator.mediaSession.setActionHandler("pause", null);
      navigator.mediaSession.setActionHandler("seekbackward", null);
      navigator.mediaSession.setActionHandler("seekforward", null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book]);

  useEffect(() => {
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // ── Auto-resume from reading, if you've read further than you've listened ──
  useEffect(() => {
    if (autoResumedRef.current || explicitJumpRef.current) return;
    if (!book || !session || !readAlong.map) return;
    autoResumedRef.current = true; // decide now, whichever way — never re-run
    if (!book.hasEbook || book.ebookProgress <= book.audioProgress) return;
    const mappedS = timeAtProgression(readAlong.map, book.ebookProgress);
    if (mappedS === null || mappedS - positionRef.current <= 20) return; // not meaningfully ahead
    seekTo(mappedS);
    setResumeNotice(`Resumed from your reading progress — ${formatTime(mappedS)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAlong.map, book, session]);

  function seekTo(targetS: number) {
    if (!session) return;
    const clamped = Math.max(0, Math.min(session.durationS, targetS));
    const { index, withinS } = locate(session.tracks, clamped);
    const audio = audioRef.current;
    if (!audio) return;
    maybeAutoBookmark(positionRef.current, clamped);
    if (index !== trackIndex) {
      const wasPlaying = !audio.paused;
      pendingSeekRef.current = { withinS, thenPlay: wasPlaying };
      audio.src = session.tracks[index].streamUrl;
      setTrackIndex(index);
      audio.load();
    } else {
      audio.currentTime = withinS;
    }
    setPositionS(clamped);
    stateRef.current.lastSyncPos = clamped;
  }

  function skip(deltaS: number) {
    seekTo(positionRef.current + deltaS);
  }

  function togglePlayPause() {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) audio.play().catch(() => setError("Playback failed — try again."));
    else audio.pause();
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
    navigate(`/read/${itemId}?atProgression=${p}`);
  }

  function jumpToReadingPosition() {
    if (!book || !readAlong.map) return;
    const target = timeAtProgression(readAlong.map, book.ebookProgress);
    if (target === null) return;
    seekTo(target);
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
    const title = bookmarkTitle();
    api
      .addBookmark(itemId, { timeS: fromS, title })
      .then(() => setBookmarks((prev) => [...prev, { timeS: fromS, title, createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS)))
      .catch(() => {});
  }

  async function addBookmark(timeS: number, title: string) {
    if (!itemId) return;
    await api.addBookmark(itemId, { timeS, title });
    setBookmarks((prev) => [...prev, { timeS, title, createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS));
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
    readAlong,
    audioRef,
    positionRef,
    play,
    seekTo,
    skip,
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
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
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
