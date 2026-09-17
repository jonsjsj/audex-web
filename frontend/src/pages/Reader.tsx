import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HttpFetcher, Locator, LocatorLocations, Manifest, Publication } from "@readium/shared";
import { EpubNavigator, EpubNavigatorListeners, EpubPreferences } from "@readium/navigator";
import { api, BookDetail } from "../api/client";
import { useReadAlong } from "../lib/useReadAlong";
import { progressionAt, timeAtProgression } from "../lib/syncMap";

// @readium/navigator's HttpFetcher.get() resolves each Link's href against
// THIS base itself (WHATWG URL resolution — see epub.py's build_manifest()
// docstring on the backend for why hrefs in the manifest are plain
// zip-relative paths, not pre-joined with this prefix).
const RES_BASE = (itemId: string) => `/api/read/${itemId}/res/`;

const FONT_SIZES = [87.5, 100, 112.5, 125, 137.5, 150, 175, 200]; // percent, Readium's own default preset steps
const SAVE_DEBOUNCE_MS = 2000;

/** The position-list entry closest to progression [p] — there's no direct
 *  "Locator from progression" constructor in @readium/shared, so both the
 *  ?atProgression= jump and the auto-resume-from-audio effect below pick the
 *  nearest entry from Readium's own fixed-size position list instead. */
function nearestLocatorForProgression(positions: Locator[], p: number): Locator | undefined {
  if (positions.length === 0) return undefined;
  return positions.reduce((best, loc) => {
    const bestP = best.locations?.totalProgression ?? 0;
    const locP = loc.locations?.totalProgression ?? 0;
    return Math.abs(locP - p) < Math.abs(bestP - p) ? loc : best;
  });
}

export default function Reader() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<EpubNavigator | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [title, setTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fontSizeIdx, setFontSizeIdx] = useState(1); // index into FONT_SIZES, 100% default
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);
  const [bookDetail, setBookDetail] = useState<BookDetail | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const hasAudio = (bookDetail?.numAudioFiles ?? 0) > 0;
  // Mirrors progressPct as a raw 0..1 fraction — progressPct is rounded for
  // display, too coarse to feed back into progressionAt/timeAtProgression.
  const progressionRef = useRef(0);
  // Readium's fixed-size position list from this load — stashed for the
  // auto-resume effect below, which runs later (once the map arrives) and
  // needs the same list the initial ?atProgression= handling used.
  const positionsRef = useRef<Locator[]>([]);
  // Set when the load effect applies an explicit ?atProgression= jump (from
  // the Player's "Jump to text") — the auto-resume effect must not then ALSO
  // override the position from listening progress, fighting that jump.
  const explicitProgressionRef = useRef(false);
  const autoResumedRef = useRef(false);

  // Cross-format jump (docs/SYNC_API.md §3) — gated on this item also having
  // audio, same reasoning as Player.tsx's own gate on hasEbook.
  const readAlong = useReadAlong(itemId, hasAudio);

  useEffect(() => {
    if (!itemId || !containerRef.current) return;
    let cancelled = false;
    let nav: EpubNavigator | null = null;

    async function open() {
      try {
        const [manifestJson, positionRes, prefs, detail] = await Promise.all([
          api.readManifest(itemId!),
          api.readPosition(itemId!),
          api.settings().catch(() => null),
          api.item(itemId!).catch(() => null),
        ]);
        if (cancelled) return;
        if (detail) setBookDetail(detail);

        // A LOCAL var, not the fontSizeIdx STATE — this effect only runs once
        // per itemId (mount), so the closure below would otherwise always
        // construct with whatever fontSizeIdx was at mount time (the
        // hardcoded default), never a preference loaded within this same
        // async call. setFontSizeIdx (after construction, below) syncs the
        // UI's A-/A+ buttons to match what was actually applied.
        let initialFontIdx = 1;
        if (prefs) {
          initialFontIdx = FONT_SIZES.reduce(
            (best, size, i) => (Math.abs(size - prefs.readerFontSize) < Math.abs(FONT_SIZES[best] - prefs.readerFontSize) ? i : best),
            0,
          );
        }

        const manifest = Manifest.deserialize(manifestJson);
        if (!manifest) throw new Error("This book's manifest couldn't be read.");
        const fetcher = new HttpFetcher(window.fetch.bind(window), RES_BASE(itemId!));
        const pub = new Publication({ manifest, fetcher });
        setTitle(pub.metadata.title.getTranslation());

        // Our own backend's manifest never advertises a Readium position-list
        // link (epub.py's build_manifest() doesn't generate one), so
        // positionsFromManifest() always resolves to []. That's fine as long
        // as SOMETHING is in `positions` before construction: EpubNavigator's
        // own load() falls back to `this.currentLocation = this.positions[0]`
        // when no initial locator was given, and unconditionally dereferences
        // `.locations` on it right after — an empty array makes that
        // `undefined.locations`, crashing on the very first open of any book
        // that has no saved reading position yet. One synthetic locator per
        // reading-order item (chapter-start granularity, not real pagination)
        // is enough to keep the navigator's own fallback from ever landing on
        // undefined, and gives ?atProgression=/auto-resume something to
        // target too.
        let positions = await pub.positionsFromManifest();
        if (positions.length === 0) {
          const items = pub.readingOrder.items;
          positions = items.map(
            (item, i) =>
              new Locator({
                href: item.href,
                type: item.type ?? "application/xhtml+xml",
                title: item.title,
                locations: new LocatorLocations({ position: i + 1, progression: 0, totalProgression: i / items.length }),
              }),
          );
        }
        positionsRef.current = positions;

        // A read-along "jump to text" link (Player.tsx) arrives as
        // ?atProgression=<0..1> — it overrides the saved position for this
        // one load.
        const atProgressionParam = searchParams.get("atProgression");
        const atProgression = atProgressionParam !== null ? Number(atProgressionParam) : null;
        let initialLocator: Locator | undefined;
        if (atProgression !== null && Number.isFinite(atProgression) && positions.length > 0) {
          explicitProgressionRef.current = true;
          initialLocator = nearestLocatorForProgression(positions, atProgression);
          // Consume the param so a refresh resumes from the real saved
          // position instead of re-jumping back here every time.
          setSearchParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete("atProgression");
              return next;
            },
            { replace: true },
          );
        } else {
          initialLocator = positionRes.locator ? Locator.deserialize(positionRes.locator) : undefined;
        }

        const listeners: EpubNavigatorListeners = {
          frameLoaded: () => {},
          positionChanged: (locator) => {
            // `nav` (the closure variable, not navRef) isn't assigned until
            // the `new EpubNavigator(...)` call below RETURNS — if this
            // fires synchronously during construction, nav is still null
            // AND the locator parameter itself can be undefined on that
            // first event. Without this guard that was a hard crash
            // ("Cannot read properties of undefined (reading 'locations')")
            // on every book open.
            const loc = nav?.currentLocator ?? locator;
            if (!loc?.locations) return;
            progressionRef.current = loc.locations.totalProgression ?? 0;
            setProgressPct(
              loc.locations.totalProgression != null ? Math.round(loc.locations.totalProgression * 100) : null,
            );
            setChapterTitle(loc.title ?? null);
            queueSave(itemId!, loc);
          },
          timelineItemChanged: () => {},
          tap: () => false,
          click: () => false,
          zoom: () => {},
          miscPointer: () => {},
          scroll: () => {},
          customEvent: () => {},
          handleLocator: () => false,
          textSelected: () => {},
          contentProtection: () => {},
          contextMenu: () => {},
          peripheral: () => {},
        };

        nav = new EpubNavigator(
          containerRef.current!,
          pub,
          listeners,
          positions,
          initialLocator,
          { preferences: new EpubPreferences({ fontSize: FONT_SIZES[initialFontIdx] }), defaults: {} },
        );
        await nav.load();
        if (cancelled) {
          await nav.destroy();
          return;
        }
        navRef.current = nav;
        setFontSizeIdx(initialFontIdx);
        setLoading(false);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Couldn't open this book.");
      }
    }

    void open();
    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      // Flush whatever's pending BEFORE destroying the navigator — a route
      // change or tab close shouldn't lose up to SAVE_DEBOUNCE_MS of reading
      // to the debounce window. Deliberately in THIS cleanup, not a second
      // effect: two effects both cleaning up on the same unmount only flush-
      // then-clear in the right order because React runs cleanups in reverse
      // declaration order — true today, but a silent footgun for whoever
      // reorders these effects later. One effect owning both leaves nothing
      // for ordering to get wrong.
      flushSave(itemId);
      navRef.current?.destroy();
      navRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  // ── Auto-resume from listening, if you've listened further than you've read ──
  // The reader-side half of the same carryover as Player.tsx's own effect —
  // see the comment there for the "furthest wins" reasoning. Runs once
  // bookDetail + map + the navigator are all ready.
  useEffect(() => {
    if (autoResumedRef.current || explicitProgressionRef.current) return;
    if (!bookDetail || !readAlong.map || !navRef.current || positionsRef.current.length === 0) return;
    autoResumedRef.current = true; // decide now, whichever way — never re-run
    if (bookDetail.numAudioFiles === 0 || bookDetail.audioProgress <= bookDetail.ebookProgress) return;
    const targetP = progressionAt(readAlong.map, bookDetail.audioTimeS);
    if (targetP === null || targetP - progressionRef.current <= 0.01) return; // not meaningfully ahead
    const target = nearestLocatorForProgression(positionsRef.current, targetP);
    if (!target) return;
    navRef.current.go(target, true, () => {});
    setResumeNotice("Resumed from your listening progress");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAlong.map, bookDetail]);

  // Debounced, not on every positionChanged — a fast page-turner would
  // otherwise fire a PATCH per page. Coalesces to the LATEST locator only:
  // fine to drop an intermediate position, never fine to drop the final one
  // (the unmount cleanup above flushes it synchronously on the way out).
  const pendingLocatorRef = useRef<Locator | null>(null);
  function queueSave(id: string, locator: Locator) {
    pendingLocatorRef.current = locator;
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => flushSave(id), SAVE_DEBOUNCE_MS);
  }
  function flushSave(id: string) {
    const locator = pendingLocatorRef.current;
    if (!locator) return;
    pendingLocatorRef.current = null;
    const progress = locator.locations?.totalProgression ?? 0;
    api.saveReadPosition(id, { locator: locator.serialize(), progress }).catch(() => {});
  }

  function prevPage() {
    navRef.current?.goBackward(true, () => {});
  }
  function nextPage() {
    navRef.current?.goForward(true, () => {});
  }

  async function changeFontSize(delta: number) {
    const idx = Math.max(0, Math.min(FONT_SIZES.length - 1, fontSizeIdx + delta));
    if (idx === fontSizeIdx || !navRef.current) return;
    setFontSizeIdx(idx);
    await navRef.current.submitPreferences(new EpubPreferences({ fontSize: FONT_SIZES[idx] }));
    api.updateSettings({ readerFontSize: FONT_SIZES[idx] }).catch(() => {});
  }

  /** Navigate to the player at the point the text has reached — the reader-
   *  side half of the cross-format jump (docs/SYNC_API.md §3). */
  function jumpToAudio() {
    if (!itemId || !readAlong.map) return;
    const t = timeAtProgression(readAlong.map, progressionRef.current);
    if (t === null) return;
    navigate(`/play/${itemId}?atTime=${t}`);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowRight" || e.key === "PageDown") nextPage();
    else if (e.key === "ArrowLeft" || e.key === "PageUp") prevPage();
  }

  const [discarding, setDiscarding] = useState(false);
  async function discardProgress() {
    if (!itemId) return;
    if (!window.confirm("Discard your progress on this book? This can't be undone.")) return;
    setDiscarding(true);
    try {
      // Cancel whatever's pending BEFORE discarding — the debounce timer or
      // the unmount-flush below firing afterward would PATCH the position
      // straight back, resurrecting what was just cleared.
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      pendingLocatorRef.current = null;
      await api.discardReadProgress(itemId);
      navigate("/");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't discard progress.");
      setDiscarding(false);
    }
  }

  if (error) {
    return (
      <div className="reader-wrap">
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

  return (
    <div className="reader-wrap" onKeyDown={onKeyDown} tabIndex={-1}>
      <header className="reader-head">
        <button className="reader-back" onClick={() => navigate("/")}>
          ← Library
        </button>
        <div className="reader-head-title">
          <span className="reader-book-title">{title}</span>
          {chapterTitle && <span className="reader-chapter-title"> · {chapterTitle}</span>}
        </div>
        <div className="reader-head-right">
          <button className="reader-font-btn" onClick={() => changeFontSize(-1)} aria-label="Smaller text" disabled={fontSizeIdx === 0}>
            A-
          </button>
          <button className="reader-font-btn" onClick={() => changeFontSize(1)} aria-label="Larger text" disabled={fontSizeIdx === FONT_SIZES.length - 1}>
            A+
          </button>
          <button className="reader-font-btn" onClick={discardProgress} disabled={discarding} aria-label="Discard progress">
            {discarding ? "…" : "⟲"}
          </button>
        </div>
      </header>

      {loading && <p className="sub" style={{ padding: "2rem" }}>Loading…</p>}

      <div className="reader-frame-wrap">
        <button className="reader-nav-edge reader-nav-prev" onClick={prevPage} aria-label="Previous page">
          ‹
        </button>
        <div ref={containerRef} className="reader-frame" />
        <button className="reader-nav-edge reader-nav-next" onClick={nextPage} aria-label="Next page">
          ›
        </button>
      </div>

      {progressPct !== null && (
        <div className="reader-progress">
          <div className="reader-progress-bar">
            <div className="reader-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="reader-progress-pct">{progressPct}%</span>
        </div>
      )}

      {resumeNotice && <p className="reader-resume-notice">{resumeNotice}</p>}

      {hasAudio && (
        <div className="reader-readalong">
          {readAlong.map ? (
            <button className="reader-readalong-jump" onClick={jumpToAudio}>
              Jump to audio ↦
            </button>
          ) : (
            // No read-along map yet (or none configured) — a plain format
            // switch shouldn't have to wait on that; it just opens the
            // player at wherever your own listening position last was.
            <button className="reader-readalong-jump" onClick={() => navigate(`/play/${itemId}`)}>
              Listen to this book ↦
            </button>
          )}
          {!readAlong.map &&
            (readAlong.status && readAlong.status.state !== "none" && readAlong.status.state !== "error" ? (
              <span className="reader-readalong-status">Building word sync…</span>
            ) : (
              <button className="reader-readalong-build" onClick={() => readAlong.requestBuild()}>
                Build read-along
              </button>
            ))}
          {readAlong.error && <span className="reader-readalong-status">{readAlong.error}</span>}
        </div>
      )}
    </div>
  );
}
