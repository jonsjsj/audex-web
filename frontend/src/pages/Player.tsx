import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { usePlayback, formatTime } from "../lib/PlaybackContext";
import { bookmarkTitle } from "../lib/platform";
import { timeAtProgression } from "../lib/syncMap";

const SKIP_S = 30;
// Decorative, not audio-derived — mirrors the native app's own fixed
// waveform silhouette exactly (its source comments say the same: hand-tuned
// from the design mockup, not real amplitude data).
const WAVEFORM_BARS = [0.3, 0.62, 0.44, 0.82, 0.55, 1.0, 0.7, 0.9, 0.48, 0.76, 0.38, 0.66];

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

/** Now just a view over PlaybackContext — playback itself (the <audio>
 *  element, the ABS session, sync, media session, bookmarks) lives there and
 *  survives navigating away from this page entirely, so audio keeps playing
 *  while you browse elsewhere. See MiniPlayer.tsx for the other view. */
export default function Player() {
  const { itemId: urlItemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const playback = usePlayback();

  const [reportSent, setReportSent] = useState(false);
  const [scrubbing, setScrubbing] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<"chapters" | "bookmarks">("chapters");
  const [confirmRemoveTimeS, setConfirmRemoveTimeS] = useState<number | null>(null);
  const [goToOpen, setGoToOpen] = useState(false);
  const [goToValue, setGoToValue] = useState("");
  const [goToError, setGoToError] = useState<string | null>(null);
  const [addBookmarkOpen, setAddBookmarkOpen] = useState(false);
  const [addBookmarkNote, setAddBookmarkNote] = useState("");
  const [addingBookmark, setAddingBookmark] = useState(false);
  const [addBookmarkError, setAddBookmarkError] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState(false);

  // Starts (or confirms) playback for whatever book this URL names — a
  // no-op in the context if it's already the one loaded/loading.
  useEffect(() => {
    if (urlItemId) playback.play(urlItemId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlItemId]);

  // A read-along "jump to audio" link (Reader.tsx) arrives as ?atTime=<s> —
  // applied once the right book's session has actually loaded, not before.
  const appliedAtTimeRef = useRef(false);
  useEffect(() => {
    appliedAtTimeRef.current = false;
  }, [urlItemId]);
  useEffect(() => {
    if (appliedAtTimeRef.current) return;
    if (!playback.session || playback.itemId !== urlItemId) return;
    const atTimeParam = searchParams.get("atTime");
    appliedAtTimeRef.current = true;
    if (atTimeParam === null) return;
    const atTimeS = Number(atTimeParam);
    if (!Number.isFinite(atTimeS)) return;
    playback.markExplicitJump();
    playback.seekTo(atTimeS);
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("atTime");
      return next;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.session, playback.itemId, urlItemId]);

  function openAddBookmark() {
    setAddBookmarkNote(bookmarkTitle());
    setAddBookmarkError(null);
    setAddBookmarkOpen(true);
  }

  async function submitAddBookmark() {
    if (addingBookmark) return;
    setAddingBookmark(true);
    setAddBookmarkError(null);
    const timeS = playback.positionRef.current;
    const title = addBookmarkNote.trim() || bookmarkTitle();
    try {
      await playback.addBookmark(timeS, title);
      setAddBookmarkOpen(false);
    } catch (e) {
      setAddBookmarkError(e instanceof Error ? e.message : "Couldn't save bookmark.");
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
    playback.removeBookmark(timeS);
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
    playback.seekTo(target);
    setGoToOpen(false);
  }

  function jumpToReadingPosition() {
    playback.jumpToReadingPosition();
    setGoToOpen(false);
  }

  async function discardProgress() {
    if (!window.confirm("Discard your progress on this audiobook? This can't be undone.")) return;
    setDiscarding(true);
    try {
      await playback.discardProgress();
    } catch (e) {
      setDiscarding(false);
      window.alert(e instanceof Error ? e.message : "Couldn't discard progress.");
    }
  }

  const loaded = playback.book && playback.session && playback.itemId === urlItemId;

  if (playback.error && playback.itemId === urlItemId) {
    return (
      <div className="player-wrap">
        <div className="error" style={{ margin: "2rem" }}>{playback.error}</div>
        <button className="btn btn-secondary" style={{ width: "auto", margin: "0 2rem" }} onClick={() => navigate("/")}>
          Back to library
        </button>
        <button
          className="player-report-link"
          onClick={() => {
            setReportSent(true);
            api.submitReport({ message: playback.error!, itemId: urlItemId, url: window.location.pathname }).catch(() => {});
          }}
          disabled={reportSent}
        >
          {reportSent ? "Reported — thanks" : "Report this problem"}
        </button>
      </div>
    );
  }
  if (!loaded) return <p className="sub" style={{ padding: "2rem" }}>Loading…</p>;

  const { book, session, positionS, isPlaying, speed, sleepRemainingS, bookmarks, resumeNotice, readAlong } = playback;
  const shown = scrubbing ?? positionS;
  const currentChapter = session!.chapters.find((c) => shown >= c.startS && shown < c.endS) ?? null;
  const progressFrac = session!.durationS > 0 ? shown / session!.durationS : 0;
  const litBars = Math.round(progressFrac * WAVEFORM_BARS.length);
  const readingAheadS = book!.hasEbook && readAlong.map ? timeAtProgression(readAlong.map, book!.ebookProgress) : null;
  const showJumpToReading = readingAheadS !== null && readingAheadS - shown > 20;

  return (
    <div className="player-wrap">
      <div className="player-hero">
        <img className="player-hero-cover" src={book!.coverUrl} alt="" />
        <div className="player-hero-scrim" />
        <span className="player-hero-eyebrow">NOW PLAYING</span>
        {(book!.hasEbook || book!.pairedItemId) && (
          <button
            className="player-format-switch"
            onClick={() =>
              readAlong.map ? playback.jumpToText() : navigate(`/read/${book!.hasEbook ? urlItemId : book!.pairedItemId}`)
            }
          >
            📖 Read
          </button>
        )}
        <div className="player-hero-text">
          <h1 className="player-title">{book!.title}</h1>
          <div className="player-byline">
            {book!.author && (
              <button className="player-byline-link" onClick={() => navigate(`/authors/${encodeURIComponent(book!.author!)}`)}>
                {book!.author}
              </button>
            )}
            {book!.series && (
              <button
                className="player-byline-link"
                onClick={() => navigate(`/series/${encodeURIComponent(book!.series!.replace(/ #.*$/, ""))}`)}
              >
                {book!.series}
              </button>
            )}
            {book!.narrator &&
              book!.narrator.split(",").map((n) => n.trim()).filter(Boolean).map((n) => (
                <button key={n} className="player-byline-link" onClick={() => navigate(`/narrators/${encodeURIComponent(n)}`)}>
                  Read by {n}
                </button>
              ))}
          </div>
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
              max={session!.durationS || 1}
              step={1}
              value={shown}
              onChange={(e) => setScrubbing(Number(e.target.value))}
              onMouseUp={() => {
                if (scrubbing !== null) playback.seekTo(scrubbing);
                setScrubbing(null);
              }}
              onTouchEnd={() => {
                if (scrubbing !== null) playback.seekTo(scrubbing);
                setScrubbing(null);
              }}
            />
            {session!.chapters.length > 1 && session!.durationS > 0 && (
              <div className="player-scrub-ticks">
                {session!.chapters.slice(1).map((c) => (
                  <div key={c.id} className="player-scrub-tick" style={{ left: `${(c.startS / session!.durationS) * 100}%` }} />
                ))}
              </div>
            )}
            {session!.durationS > 0 && bookmarks.length > 0 && (
              <div className="player-scrub-marks">
                {bookmarks.map((bm) => (
                  <button
                    key={bm.timeS}
                    className="player-scrub-mark"
                    style={{ left: `${(bm.timeS / session!.durationS) * 100}%` }}
                    onClick={() => playback.seekTo(bm.timeS)}
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
          <span>-{formatTime(session!.durationS - shown)}</span>
          <span>{formatTime(session!.durationS)}</span>
        </div>
      </div>

      <div className="player-transport">
        <button className="player-skip" onClick={() => playback.skip(-SKIP_S)} aria-label={`Back ${SKIP_S}s`}>
          ⟲<span className="player-skip-n">{SKIP_S}</span>
        </button>
        <button className="player-play" onClick={playback.togglePlayPause} aria-label={isPlaying ? "Pause" : "Play"}>
          {isPlaying ? "❚❚" : "▶"}
        </button>
        <button className="player-skip" onClick={() => playback.skip(SKIP_S)} aria-label={`Forward ${SKIP_S}s`}>
          <span className="player-skip-n">{SKIP_S}</span>⟳
        </button>
      </div>

      <div className="player-utility">
        <button className="player-util-cell" onClick={playback.cycleSpeed}>
          <span className={`v ${speed !== 1 ? "accent" : ""}`}>{speed}×</span>
          <span className="l">SPEED</span>
        </button>
        <button className="player-util-cell" onClick={playback.cycleSleep}>
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

      {(book!.hasEbook || book!.pairedItemId) && !readAlong.map && (
        // The switch-to-reading action itself now lives in the hero (always
        // visible, no scrolling needed) — this block is just the read-along
        // build prompt/status, which only matters pre-map.
        <div className="player-readalong">
          {readAlong.status && readAlong.status.state !== "none" && readAlong.status.state !== "error" ? (
            <div className="player-readalong-status">
              <span>Building word sync…</span>
              {readAlong.status.etaSeconds != null && <span className="t">~{formatTime(readAlong.status.etaSeconds)} left</span>}
            </div>
          ) : (
            <button
              className="player-readalong-build"
              onClick={() => readAlong.requestBuild(book!.hasEbook ? undefined : book!.pairedItemId ?? undefined)}
            >
              Build read-along
            </button>
          )}
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
        session!.chapters.length > 0 ? (
          <div className="player-tab-list">
            {session!.chapters.map((c, i) => (
              <button
                key={c.id}
                className={`player-chapter-row ${c === currentChapter ? "active" : ""}`}
                onClick={() => playback.seekTo(c.startS)}
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
              <button className="player-bookmark-jump" onClick={() => playback.seekTo(bm.timeS)}>
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
            {addBookmarkError && <div className="error" style={{ marginTop: "0.6rem" }}>{addBookmarkError}</div>}
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
