import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, Bookmark, BookDetail, PlaySession } from "../api/client";
import { useReadAlong } from "../lib/useReadAlong";
import { progressionAt, timeAtProgression } from "../lib/syncMap";

const SKIP_S = 30;
const SYNC_INTERVAL_MS = 15_000;
const SLEEP_OPTIONS = [0, 15, 30, 45, 60]; // minutes, 0 = off
// Mirrors the mobile app's own PlaybackControllerImpl: a jump of at least
// this many seconds — a chapter tap, a scrubber drag, several skips in a
// row — auto-drops a "you were here" bookmark at the position you jumped
// FROM, so an accidental big seek is always one tap away from undoing.
const AUTO_BOOKMARK_JUMP_S = 120;
// Decorative, not audio-derived — mirrors the native app's own fixed
// waveform silhouette exactly (its source comments say the same: hand-tuned
// from the design mockup, not real amplitude data).
const WAVEFORM_BARS = [0.3, 0.62, 0.44, 0.82, 0.55, 1.0, 0.7, 0.9, 0.48, 0.76, 0.38, 0.66];

function formatTime(totalS: number): string {
  if (!Number.isFinite(totalS) || totalS < 0) totalS = 0;
  const s = Math.floor(totalS);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Parses the Go To dialog's free-typed time — "90", "12:34", or "1:02:03". */
function parseTimeInput(raw: string): number | null {
  const parts = raw.trim().split(":").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => p === "" || !/^\d+$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 1) return nums[0];
  if (nums.length === 2) return nums[0] * 60 + nums[1];
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2];
  return null;
}

/** Which track covers overall second [posS], and how far into it. */
function locate(tracks: PlaySession["tracks"], posS: number): { index: number; withinS: number } {
  let idx = 0;
  for (let i = 0; i < tracks.length; i++) {
    if (tracks[i].startOffsetS <= posS) idx = i;
  }
  return { index: idx, withinS: Math.max(0, posS - tracks[idx].startOffsetS) };
}

/** POST close with sendBeacon so it actually fires on tab-close/navigation —
 *  a plain fetch() gets cancelled the instant the page unloads. */
function closeBeacon(itemId: string, body: object) {
  const blob = new Blob([JSON.stringify(body)], { type: "application/json" });
  navigator.sendBeacon(`/api/play/${itemId}/close`, blob);
}

export default function Player() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const audioRef = useRef<HTMLAudioElement>(null);

  const [book, setBook] = useState<BookDetail | null>(null);
  const [session, setSession] = useState<PlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);

  const [trackIndex, setTrackIndex] = useState(0);
  const [positionS, setPositionS] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sleepIdx, setSleepIdx] = useState(0);
  const [sleepRemainingS, setSleepRemainingS] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chapters" | "bookmarks">("chapters");
  const [confirmRemoveTimeS, setConfirmRemoveTimeS] = useState<number | null>(null);

  const [goToOpen, setGoToOpen] = useState(false);
  const [goToValue, setGoToValue] = useState("");
  const [goToError, setGoToError] = useState<string | null>(null);

  const [addBookmarkOpen, setAddBookmarkOpen] = useState(false);
  const [addBookmarkNote, setAddBookmarkNote] = useState("");
  const [addingBookmark, setAddingBookmark] = useState(false);

  // Cross-format jump (docs/SYNC_API.md §3) — only worth polling/building for
  // a book that could ever have both an audio and an ebook edition.
  const readAlong = useReadAlong(itemId, book?.hasEbook ?? false);
  // Set when the load effect below applies an explicit ?atTime= jump (from the
  // Reader's "Jump to audio") — the auto-resume effect further down must not
  // then ALSO override the position from reading progress, fighting the jump
  // the user just asked for.
  const explicitJumpRef = useRef(false);
  // Guards the auto-resume effect to run at most once per book load — it
  // reacts to readAlong.map arriving, which happens once; without this guard
  // a map re-fetch (there isn't one today, but this is cheap insurance) could
  // seek the user right back after they've since moved on themselves.
  const autoResumedRef = useRef(false);

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

  // ── Load the book + start the ABS session ────────────────────────────────
  useEffect(() => {
    if (!itemId) return;
    let cancelled = false;
    Promise.all([
      api.item(itemId),
      api.play(itemId),
      api.bookmarks(itemId).catch(() => []),
      api.settings().catch(() => null),
    ])
      .then(([b, s, marks, prefs]) => {
        if (cancelled) return;
        setBook(b);
        setSession(s);
        setBookmarks(marks);
        if (prefs) setSpeed(prefs.playbackSpeed);
        stateRef.current.sessionId = s.sessionId;
        stateRef.current.durationS = s.durationS;
        // A read-along "jump to audio" link (Reader.tsx) arrives as
        // ?atTime=<seconds> — it overrides the ABS-resumed position for this
        // one load, same as the mobile app's deep-link resume override.
        const atTimeParam = searchParams.get("atTime");
        const atTimeS = atTimeParam !== null ? Number(atTimeParam) : null;
        const resumeS = atTimeS !== null && Number.isFinite(atTimeS) ? atTimeS : s.currentTimeS;
        const { index, withinS } = locate(s.tracks, resumeS);
        setTrackIndex(index);
        setPositionS(resumeS);
        stateRef.current.lastSyncPos = resumeS;
        if (atTimeS !== null) {
          explicitJumpRef.current = true;
          // Consume the param so a refresh resumes normally instead of
          // re-jumping back to this same spot every time.
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("atTime");
            return next;
          }, { replace: true });
        }
        // NOT here: the <audio> element doesn't exist yet — this component
        // returns an early "Loading…" placeholder (no <audio> in the tree)
        // until `session` is set, and that only takes effect on React's NEXT
        // render, after this callback returns. audioRef.current would still
        // be null right now. The effect below (keyed on `session`) runs once
        // that render has actually committed and the ref is real.
        pendingSeekRef.current = { withinS, thenPlay: false };
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't open this book."));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // Now the <audio> element is guaranteed to be mounted (session is non-null
  // only once Home has re-rendered past the loading placeholder) — load the
  // resume track. The pending seek itself is applied from onLoadedMetadata.
  useEffect(() => {
    if (!session) return;
    const audio = audioRef.current;
    if (!audio) return;
    audio.src = session.tracks[trackIndex].streamUrl;
    audio.load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  // Close the ABS session on unmount (route change) and on tab close. Reads
  // positionRef, not positionS directly — this effect only runs once per
  // itemId, so a closed-over positionS would always report whatever it was
  // when the effect was set up, not the actual position at unload time.
  useEffect(() => {
    if (!itemId) return;
    const onUnload = () => {
      const st = stateRef.current;
      if (!st.sessionId) return;
      closeBeacon(itemId, { sessionId: st.sessionId, currentTimeS: positionRef.current, timeListenedS: st.timeListenedS, durationS: st.durationS });
    };
    window.addEventListener("pagehide", onUnload);
    return () => {
      window.removeEventListener("pagehide", onUnload);
      onUnload();
    };
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

  // ── Media Session (OS / lock-screen controls) ────────────────────────────
  useEffect(() => {
    if (!("mediaSession" in navigator) || !book) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: book.title,
      artist: book.author ?? undefined,
      artwork: [{ src: book.coverUrl, sizes: "400x400", type: "image/jpeg" }],
    });
    navigator.mediaSession.setActionHandler("play", () => audioRef.current?.play());
    navigator.mediaSession.setActionHandler("pause", () => audioRef.current?.pause());
    navigator.mediaSession.setActionHandler("seekbackward", () => skip(-SKIP_S));
    navigator.mediaSession.setActionHandler("seekforward", () => skip(SKIP_S));
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
  // Mirrors the mobile app's cross-format carryover: the library grid already
  // shows "furthest of audio/ebook progress" as ONE bar (library.py's
  // _book_summary); this makes that same "furthest wins" idea actually MOVE
  // the resume point, not just describe it. Runs once map+book+session are
  // all available — map arrival is the natural trigger since it's normally
  // the last of the three to load.
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
    // positionRef, not positionS: the MediaSession action handlers below
    // register `skip` once (effect keyed on `book`) and never rebind it, so a
    // stale positionS closure would make the OS lock-screen seek buttons
    // always skip relative to wherever playback was when the book first
    // loaded, not the live position. positionRef is kept current every render
    // for exactly this reason — reading it here makes skip() correct no
    // matter which render's closure ends up calling it.
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
    // playbackRate isn't guaranteed to survive a src swap in every browser —
    // reapply it on every track load rather than assuming it stuck.
    audio.playbackRate = speed;
    const pending = pendingSeekRef.current;
    if (!pending) return;
    pendingSeekRef.current = null;
    audio.currentTime = pending.withinS;
    if (pending.thenPlay) audio.play().catch(() => {});
  }

  /** Navigate to the reader at the point in the text the audio has reached —
   *  the audio-side half of the cross-format jump (docs/SYNC_API.md §3). */
  function jumpToText() {
    if (!itemId || !readAlong.map) return;
    const p = progressionAt(readAlong.map, positionRef.current);
    if (p === null) return;
    navigate(`/read/${itemId}?atProgression=${p}`);
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
   *  is a background safety net, not a user-requested action, so it should
   *  never interrupt playback with an error banner if it doesn't stick. */
  function maybeAutoBookmark(fromS: number, toS: number) {
    if (!itemId || fromS < 1.0 || Math.abs(toS - fromS) < AUTO_BOOKMARK_JUMP_S) return;
    const title = `Left off · ${formatTime(fromS)}`;
    api
      .addBookmark(itemId, { timeS: fromS, title })
      .then(() => setBookmarks((prev) => [...prev, { timeS: fromS, title, createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS)))
      .catch(() => {});
  }

  function openAddBookmark() {
    setAddBookmarkNote(`Left off · ${formatTime(positionRef.current)}`);
    setAddBookmarkOpen(true);
  }

  async function submitAddBookmark() {
    if (!itemId || addingBookmark) return;
    setAddingBookmark(true);
    const timeS = positionRef.current;
    const title = addBookmarkNote.trim() || `Left off · ${formatTime(timeS)}`;
    try {
      await api.addBookmark(itemId, { timeS, title });
      setBookmarks((prev) => [...prev, { timeS, title, createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS));
      setAddBookmarkOpen(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save bookmark.");
    } finally {
      setAddingBookmark(false);
    }
  }

  /** Two-tap remove (tap "Remove" → it becomes "Remove?" → tap again) — no
   *  dialog, mirrors the mobile app's own bookmark row exactly. */
  function onBookmarkRemoveClick(timeS: number) {
    if (confirmRemoveTimeS !== timeS) {
      setConfirmRemoveTimeS(timeS);
      return;
    }
    setConfirmRemoveTimeS(null);
    removeBookmark(timeS);
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

  function openGoTo() {
    setGoToValue("");
    setGoToError(null);
    setGoToOpen(true);
  }

  function submitGoTo() {
    const target = parseTimeInput(goToValue);
    if (target === null) {
      setGoToError("Enter a time like 12:34 or 1:02:03.");
      return;
    }
    seekTo(target);
    setGoToOpen(false);
  }

  /** The Go To dialog's "jump to where you're reading" row — an on-demand
   *  version of the auto-resume effect above, for whenever you want to sync
   *  up mid-listen rather than only at the moment you opened the player. */
  function jumpToReadingPosition() {
    if (!book || !readAlong.map) return;
    const target = timeAtProgression(readAlong.map, book.ebookProgress);
    if (target === null) return;
    seekTo(target);
    setGoToOpen(false);
  }

  const [discarding, setDiscarding] = useState(false);
  async function discardProgress() {
    if (!itemId) return;
    if (!window.confirm("Discard your progress on this audiobook? This can't be undone.")) return;
    setDiscarding(true);
    try {
      // Stop first — a still-playing session would just write its position
      // straight back on the next sync tick, resurrecting what was just
      // wiped (the same reasoning the mobile app's own discard flow uses).
      audioRef.current?.pause();
      stateRef.current.sessionId = ""; // suppresses the periodic sync effect and pagehide/unmount close
      await api.discardAudioProgress(itemId);
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't discard progress.");
      setDiscarding(false);
    }
  }

  if (error) {
    return (
      <div className="player-wrap">
        <div className="error" style={{ margin: "2rem" }}>{error}</div>
        <button className="btn btn-secondary" style={{ width: "auto", margin: "0 2rem" }} onClick={() => navigate("/")}>
          Back to library
        </button>
        <button
          className="player-report-link"
          onClick={() => {
            setReportSent(true);
            api.submitReport({ message: error, itemId, url: window.location.pathname }).catch(() => {});
          }}
          disabled={reportSent}
        >
          {reportSent ? "Reported — thanks" : "Report this problem"}
        </button>
      </div>
    );
  }
  if (!book || !session) return <p className="sub" style={{ padding: "2rem" }}>Loading…</p>;

  const shown = scrubbing ?? positionS;
  const currentChapter = session.chapters.find((c) => shown >= c.startS && shown < c.endS) ?? null;
  const progressFrac = session.durationS > 0 ? shown / session.durationS : 0;
  const litBars = Math.round(progressFrac * WAVEFORM_BARS.length);
  const readingAheadS = book.hasEbook && readAlong.map ? timeAtProgression(readAlong.map, book.ebookProgress) : null;
  const showJumpToReading = readingAheadS !== null && readingAheadS - shown > 20;

  return (
    <div className="player-wrap">
      <div className="player-hero">
        <img className="player-hero-cover" src={book.coverUrl} alt="" />
        <div className="player-hero-scrim" />
        <span className="player-hero-eyebrow">NOW PLAYING</span>
        <div className="player-hero-text">
          <h1 className="player-title">{book.title}</h1>
          {book.author && <p className="player-author">{book.author}</p>}
        </div>
      </div>

      {resumeNotice && <p className="player-resume-notice">{resumeNotice}</p>}

      <div className="player-progress-section">
        <p className="player-current-chapter">{currentChapter?.title ?? ""}</p>

        <div className="player-scrub">
          <div className="player-scrub-track">
            <input
              type="range"
              min={0}
              max={session.durationS || 1}
              step={1}
              value={shown}
              onChange={(e) => setScrubbing(Number(e.target.value))}
              onMouseUp={() => {
                if (scrubbing !== null) seekTo(scrubbing);
                setScrubbing(null);
              }}
              onTouchEnd={() => {
                if (scrubbing !== null) seekTo(scrubbing);
                setScrubbing(null);
              }}
            />
            {/* One tick per chapter BOUNDARY, not per chapter — the first
                chapter's own start is 0, the very edge of the track, not a
                meaningful mark. pointer-events:none (see CSS) so this overlay
                never steals the drag from the range input underneath it. */}
            {session.chapters.length > 1 && session.durationS > 0 && (
              <div className="player-scrub-ticks">
                {session.chapters.slice(1).map((c) => (
                  <div key={c.id} className="player-scrub-tick" style={{ left: `${(c.startS / session.durationS) * 100}%` }} />
                ))}
              </div>
            )}
            {/* Bookmarks as small dots directly on the track — visible +
                tappable without switching to the Bookmarks tab below. */}
            {session.durationS > 0 && bookmarks.length > 0 && (
              <div className="player-scrub-marks">
                {bookmarks.map((bm) => (
                  <button
                    key={bm.timeS}
                    className="player-scrub-mark"
                    style={{ left: `${(bm.timeS / session.durationS) * 100}%` }}
                    onClick={() => seekTo(bm.timeS)}
                    aria-label={`Jump to bookmark: ${bm.title}`}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="player-waveform" aria-hidden>
          {WAVEFORM_BARS.map((h, i) => (
            <div key={i} className={`player-wave-bar ${i < litBars ? "lit" : ""}`} style={{ height: `${h * 100}%` }} />
          ))}
        </div>

        <div className="player-times">
          <span>{formatTime(shown)}</span>
          <span>-{formatTime(session.durationS - shown)}</span>
          <span>{formatTime(session.durationS)}</span>
        </div>
      </div>

      <div className="player-transport">
        <button className="player-skip" onClick={() => skip(-SKIP_S)} aria-label={`Back ${SKIP_S}s`}>
          ⟲<span className="player-skip-n">{SKIP_S}</span>
        </button>
        <button className="player-play" onClick={togglePlayPause} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <button className="player-skip" onClick={() => skip(SKIP_S)} aria-label={`Forward ${SKIP_S}s`}>
          <span className="player-skip-n">{SKIP_S}</span>⟳
        </button>
      </div>

      <div className="player-utility">
        <button className="player-util-cell" onClick={cycleSpeed}>
          <span className={`v ${speed !== 1 ? "accent" : ""}`}>{speed}×</span>
          <span className="l">SPEED</span>
        </button>
        <button className="player-util-cell" onClick={cycleSleep}>
          <span className={`v ${sleepRemainingS !== null ? "accent" : ""}`}>
            {sleepRemainingS !== null ? formatTime(sleepRemainingS) : "Off"}
          </span>
          <span className="l">SLEEP</span>
        </button>
        <button className="player-util-cell" onClick={openAddBookmark}>
          <span className="v">+</span>
          <span className="l">BOOKMARK</span>
        </button>
        <button className="player-util-cell" onClick={openGoTo}>
          <span className="v">⌖</span>
          <span className="l">GO TO</span>
        </button>
      </div>

      {book.hasEbook && (
        <div className="player-readalong">
          {readAlong.map ? (
            <button className="player-readalong-jump" onClick={jumpToText}>
              Jump to text ↦
            </button>
          ) : (
            // No read-along map yet (or none configured) — a plain format
            // switch shouldn't have to wait on that; it just opens the
            // reader at wherever your own reading position last was.
            <button className="player-readalong-jump" onClick={() => navigate(`/read/${itemId}`)}>
              Read this book ↦
            </button>
          )}
          {!readAlong.map &&
            (readAlong.status && readAlong.status.state !== "none" && readAlong.status.state !== "error" ? (
              <div className="player-readalong-status">
                <span>Building word sync…</span>
                {readAlong.status.etaSeconds != null && <span className="t">~{formatTime(readAlong.status.etaSeconds)} left</span>}
              </div>
            ) : (
              <button className="player-readalong-build" onClick={() => readAlong.requestBuild()}>
                Build read-along
              </button>
            ))}
          {readAlong.error && (
            <p className="error" style={{ margin: 0 }}>
              {readAlong.error}
            </p>
          )}
        </div>
      )}

      <div className="player-tabs">
        <button className={`player-tab ${activeTab === "chapters" ? "active" : ""}`} onClick={() => setActiveTab("chapters")}>
          Chapters
        </button>
        <button className={`player-tab ${activeTab === "bookmarks" ? "active" : ""}`} onClick={() => setActiveTab("bookmarks")}>
          Bookmarks{bookmarks.length > 0 ? ` (${bookmarks.length})` : ""}
        </button>
      </div>

      {activeTab === "chapters" ? (
        session.chapters.length > 0 ? (
          <div className="player-tab-list">
            {session.chapters.map((c, i) => (
              <button
                key={c.id}
                className={`player-chapter-row ${c === currentChapter ? "active" : ""}`}
                onClick={() => seekTo(c.startS)}
              >
                <span className="player-chapter-idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="player-chapter-title">{c.title}</span>
                <span className="t">{formatTime(c.startS)}</span>
              </button>
            ))}
          </div>
        ) : (
          <p className="sub" style={{ padding: "0.6rem 0.1rem" }}>No chapters for this book.</p>
        )
      ) : bookmarks.length > 0 ? (
        <div className="player-tab-list">
          {bookmarks.map((bm) => (
            <div key={bm.timeS} className="player-chapter-row player-bookmark-row">
              <button className="player-bookmark-jump" onClick={() => seekTo(bm.timeS)}>
                <span>{bm.title}</span>
                <span className="t">{formatTime(bm.timeS)}</span>
              </button>
              <button
                className={`player-bookmark-remove ${confirmRemoveTimeS === bm.timeS ? "confirm" : ""}`}
                onClick={() => onBookmarkRemoveClick(bm.timeS)}
              >
                {confirmRemoveTimeS === bm.timeS ? "Remove?" : "Remove"}
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="sub" style={{ padding: "0.6rem 0.1rem" }}>No bookmarks yet.</p>
      )}

      <button className="player-discard" onClick={discardProgress} disabled={discarding}>
        {discarding ? "Discarding…" : "Discard audiobook progress"}
      </button>

      <audio
        ref={audioRef}
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
        onEnded={onTrackEnded}
        onTimeUpdate={(e) => {
          const audio = e.currentTarget;
          if (scrubbing !== null) return; // don't fight the user's drag
          const track = session.tracks[trackIndex];
          setPositionS(track.startOffsetS + audio.currentTime);
        }}
        onLoadedMetadata={onLoadedMetadata}
      />

      {goToOpen && (
        <div className="player-dialog-backdrop" onClick={() => setGoToOpen(false)}>
          <div className="player-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Go to</h3>
            {showJumpToReading && readingAheadS !== null && (
              <>
                <button className="player-dialog-reading-jump" onClick={jumpToReadingPosition}>
                  Jump to where you're reading ({formatTime(readingAheadS)})
                </button>
                <div className="divider">or</div>
              </>
            )}
            <input
              className="settings-input"
              placeholder="12:34 or 1:02:03"
              value={goToValue}
              onChange={(e) => setGoToValue(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGoTo()}
              autoFocus
            />
            {goToError && <div className="error" style={{ marginTop: "0.6rem" }}>{goToError}</div>}
            <div className="player-dialog-actions">
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setGoToOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={submitGoTo}>
                Go
              </button>
            </div>
          </div>
        </div>
      )}

      {addBookmarkOpen && (
        <div className="player-dialog-backdrop" onClick={() => setAddBookmarkOpen(false)}>
          <div className="player-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Add bookmark</h3>
            <input
              className="settings-input"
              value={addBookmarkNote}
              onChange={(e) => setAddBookmarkNote(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAddBookmark()}
              autoFocus
            />
            <div className="player-dialog-actions">
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setAddBookmarkOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={submitAddBookmark} disabled={addingBookmark}>
                {addingBookmark ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
