import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, Bookmark, BookDetail, PlaySession } from "../api/client";

const SKIP_S = 30;
const SYNC_INTERVAL_MS = 15_000;
const SLEEP_OPTIONS = [0, 15, 30, 45, 60]; // minutes, 0 = off

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
  const audioRef = useRef<HTMLAudioElement>(null);

  const [book, setBook] = useState<BookDetail | null>(null);
  const [session, setSession] = useState<PlaySession | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [trackIndex, setTrackIndex] = useState(0);
  const [positionS, setPositionS] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [sleepIdx, setSleepIdx] = useState(0);
  const [sleepRemainingS, setSleepRemainingS] = useState<number | null>(null);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [addingBookmark, setAddingBookmark] = useState(false);

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
        const { index, withinS } = locate(s.tracks, s.currentTimeS);
        setTrackIndex(index);
        setPositionS(s.currentTimeS);
        stateRef.current.lastSyncPos = s.currentTimeS;
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

  function seekTo(targetS: number) {
    if (!session) return;
    const clamped = Math.max(0, Math.min(session.durationS, targetS));
    const { index, withinS } = locate(session.tracks, clamped);
    const audio = audioRef.current;
    if (!audio) return;
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

  async function addBookmark() {
    if (!itemId || addingBookmark) return;
    setAddingBookmark(true);
    const timeS = positionRef.current;
    const title = `Left off · ${formatTime(timeS)}`;
    try {
      await api.addBookmark(itemId, { timeS, title });
      setBookmarks((prev) => [...prev, { timeS, title, createdAt: Date.now() }].sort((a, b) => a.timeS - b.timeS));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save bookmark.");
    } finally {
      setAddingBookmark(false);
    }
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
      </div>
    );
  }
  if (!book || !session) return <p className="sub" style={{ padding: "2rem" }}>Loading…</p>;

  const shown = scrubbing ?? positionS;
  const currentChapter = session.chapters.find((c) => shown >= c.startS && shown < c.endS) ?? null;

  return (
    <div className="player-wrap">
      <button className="player-back" onClick={() => navigate("/")}>
        ← Library
      </button>

      <div className="player-cover">
        <img src={book.coverUrl} alt="" />
      </div>

      <h1 className="player-title">{book.title}</h1>
      {book.author && <p className="player-author">{book.author}</p>}

      {currentChapter && <p className="player-chapter">{currentChapter.title}</p>}

      <div className="player-scrub">
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
        <div className="player-times">
          <span>{formatTime(shown)}</span>
          <span>-{formatTime(session.durationS - shown)}</span>
        </div>
      </div>

      <div className="player-transport">
        <button className="player-skip" onClick={() => skip(-SKIP_S)} aria-label={`Back ${SKIP_S}s`}>
          ⟲ {SKIP_S}
        </button>
        <button className="player-play" onClick={togglePlayPause} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <button className="player-skip" onClick={() => skip(SKIP_S)} aria-label={`Forward ${SKIP_S}s`}>
          {SKIP_S} ⟳
        </button>
      </div>

      <div className="player-utility">
        <button className="player-util-cell" onClick={cycleSpeed}>
          <span className="v">{speed}×</span>
          <span className="l">SPEED</span>
        </button>
        <button className="player-util-cell" onClick={cycleSleep}>
          <span className="v">{sleepRemainingS !== null ? formatTime(sleepRemainingS) : "Off"}</span>
          <span className="l">SLEEP</span>
        </button>
        <button className="player-util-cell" onClick={addBookmark} disabled={addingBookmark}>
          <span className="v">{addingBookmark ? "…" : "+"}</span>
          <span className="l">BOOKMARK</span>
        </button>
      </div>

      {bookmarks.length > 0 && (
        <div className="player-chapters">
          <div className="l" style={{ marginBottom: ".5rem" }}>
            BOOKMARKS
          </div>
          {bookmarks.map((bm) => (
            <div key={bm.timeS} className="player-chapter-row player-bookmark-row">
              <button className="player-bookmark-jump" onClick={() => seekTo(bm.timeS)}>
                <span>{bm.title}</span>
                <span className="t">{formatTime(bm.timeS)}</span>
              </button>
              <button
                className="player-bookmark-remove"
                onClick={() => removeBookmark(bm.timeS)}
                aria-label={`Remove bookmark at ${formatTime(bm.timeS)}`}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {session.chapters.length > 0 && (
        <div className="player-chapters">
          <div className="l" style={{ marginBottom: ".5rem" }}>
            CHAPTERS
          </div>
          {session.chapters.map((c) => (
            <button
              key={c.id}
              className={`player-chapter-row ${c === currentChapter ? "active" : ""}`}
              onClick={() => seekTo(c.startS)}
            >
              <span>{c.title}</span>
              <span className="t">{formatTime(c.startS)}</span>
            </button>
          ))}
        </div>
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
    </div>
  );
}
