import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { HttpFetcher, Locator, Manifest, Publication } from "@readium/shared";
import { EpubNavigator, EpubNavigatorListeners, EpubPreferences } from "@readium/navigator";
import { api } from "../api/client";

// @readium/navigator's HttpFetcher.get() resolves each Link's href against
// THIS base itself (WHATWG URL resolution — see epub.py's build_manifest()
// docstring on the backend for why hrefs in the manifest are plain
// zip-relative paths, not pre-joined with this prefix).
const RES_BASE = (itemId: string) => `/api/read/${itemId}/res/`;

const FONT_SIZES = [87.5, 100, 112.5, 125, 137.5, 150, 175, 200]; // percent, Readium's own default preset steps
const SAVE_DEBOUNCE_MS = 2000;

export default function Reader() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<EpubNavigator | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [title, setTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [fontSizeIdx, setFontSizeIdx] = useState(1); // index into FONT_SIZES, 100% default
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);

  useEffect(() => {
    if (!itemId || !containerRef.current) return;
    let cancelled = false;
    let nav: EpubNavigator | null = null;

    async function open() {
      try {
        const [manifestJson, positionRes, prefs] = await Promise.all([
          api.readManifest(itemId!),
          api.readPosition(itemId!),
          api.settings().catch(() => null),
        ]);
        if (cancelled) return;

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

        const positions = await pub.positionsFromManifest();
        const initialLocator = positionRes.locator
          ? Locator.deserialize(positionRes.locator)
          : undefined;

        const listeners: EpubNavigatorListeners = {
          frameLoaded: () => {},
          positionChanged: (locator) => {
            const loc = nav?.currentLocator ?? locator;
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
    const progress = locator.locations.totalProgression ?? 0;
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
    </div>
  );
}
