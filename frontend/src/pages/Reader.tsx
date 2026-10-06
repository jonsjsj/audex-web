import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HttpFetcher, Locator, LocatorLocations, Manifest, Publication } from "@readium/shared";
import { EpubNavigator, EpubNavigatorListeners, EpubPreferences } from "@readium/navigator";
import { api, BookDetail } from "../api/client";
import { useShell } from "../components/Shell";
import { useReadAlong } from "../lib/useReadAlong";
import { progressionAt, timeAtProgression } from "../lib/syncMap";
import { buildSpineWeights, locationFromTotal, SpineWeights, totalFromLocation } from "../lib/readerProgress";

// @readium/navigator's HttpFetcher.get() resolves each Link's href against
// THIS base itself (WHATWG URL resolution — see epub.py's build_manifest()
// docstring on the backend for why hrefs in the manifest are plain
// zip-relative paths, not pre-joined with this prefix).
const RES_BASE = (itemId: string) => `/api/read/${itemId}/res/`;

// Percent — what's stored in the user's settings (and what every client
// writes). Readium itself does NOT take a percent: its fontSize preference is
// a MULTIPLIER (1 = 100%) and only accepts 0.7–4. Handing it 100 or 175 made
// it silently drop the value as out of range, so A+/A- never changed the text.
const FONT_SIZES = [87.5, 100, 112.5, 125, 137.5, 150, 175, 200];
const toReadiumFontSize = (percent: number) => percent / 100;

type PageCount = 1 | 2;
const PAGES_KEY = "audexweb.reader.pages";
function loadPages(): PageCount {
  try {
    return localStorage.getItem(PAGES_KEY) === "2" ? 2 : 1;
  } catch {
    return 1; // storage blocked — per-device convenience only, the default is fine
  }
}

const SAVE_DEBOUNCE_MS = 2000;
// How far a saved locator may disagree with the saved percentage before the
// percentage wins. We always write the two together, so a gap means ANOTHER
// client (the Audex app, Codex's cross-edition sync) moved the position since.
const POSITION_DISAGREE = 0.02;

// Readium keyboard "peripherals": key presses INSIDE the book's iframe never
// reach this page's own key handlers (they stay in the iframe's document), so
// Readium forwards the combos named here to the `peripheral` listener below.
// Modifiers must match exactly (an unlisted one means "not pressed"), which is
// what lets Space and Shift+Space be separate next/previous combos.
const KEY_NEXT = "audex-next";
const KEY_PREV = "audex-prev";
const KEY_ESCAPE = "audex-escape";
const KEY_FULLSCREEN = "audex-fullscreen";
const KEYBOARD_PERIPHERALS = [
  { type: KEY_NEXT, keyCombos: [{ keyCode: 39 }, { keyCode: 34 }, { keyCode: 32 }] }, // →  PageDown  Space
  { type: KEY_PREV, keyCombos: [{ keyCode: 37 }, { keyCode: 33 }, { keyCode: 32, shift: true }] }, // ←  PageUp  Shift+Space
  { type: KEY_ESCAPE, keyCombos: [{ keyCode: 27 }] },
  { type: KEY_FULLSCREEN, keyCombos: [{ keyCode: 70 }] }, // F
];

interface TocItem {
  title: string;
  href: string; // zip-relative path, optionally with a #fragment
  depth: number;
}

/** The manifest's nested table of contents, flattened for a simple indented list. */
function flattenToc(raw: unknown, depth = 0): TocItem[] {
  if (!Array.isArray(raw)) return [];
  const out: TocItem[] = [];
  for (const e of raw as { title?: unknown; href?: unknown; children?: unknown }[]) {
    if (typeof e?.href === "string") {
      const title = typeof e.title === "string" && e.title.trim() ? e.title.trim() : "Untitled";
      out.push({ title, href: e.href, depth });
    }
    out.push(...flattenToc(e?.children, depth + 1));
  }
  return out;
}

/** The position-list entry closest to progression [p] — only the fallback now,
 *  for a server too old to send chapter lengths (see lib/readerProgress.ts):
 *  Readium's own position list is chapter-granular, so this can only ever land
 *  on a chapter start. */
function nearestLocatorForProgression(positions: Locator[], p: number): Locator | undefined {
  if (positions.length === 0) return undefined;
  return positions.reduce((best, loc) => {
    const bestP = best.locations?.totalProgression ?? 0;
    const locP = loc.locations?.totalProgression ?? 0;
    return Math.abs(locP - p) < Math.abs(bestP - p) ? loc : best;
  });
}

const prefsFor = (fontIdx: number, pages: PageCount) =>
  new EpubPreferences({ fontSize: toReadiumFontSize(FONT_SIZES[fontIdx]), columnCount: pages });

export default function Reader() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { immersive, setImmersive } = useShell();
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<EpubNavigator | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [title, setTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [fontSizeIdx, setFontSizeIdx] = useState(1); // index into FONT_SIZES, 100% default
  const [pages, setPages] = useState<PageCount>(loadPages);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [fraction, setFraction] = useState(0); // whole-book 0..1, drives the slider
  const [scrub, setScrub] = useState<number | null>(null); // slider value while dragging, before it's committed
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0); // reading-order index of the chapter on screen
  const [toc, setToc] = useState<TocItem[]>([]);
  const [panel, setPanel] = useState<"chapters" | null>(null);
  const [bookDetail, setBookDetail] = useState<BookDetail | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const hasAudio = (bookDetail?.numAudioFiles ?? 0) > 0;
  // Mirrors progressPct as a raw 0..1 fraction — progressPct is rounded for
  // display, too coarse to feed back into progressionAt/timeAtProgression.
  const progressionRef = useRef(0);
  // Chapter lengths from the manifest, for whole-book progress (null → fall
  // back to Readium's chapter-granular value).
  const weightsRef = useRef<SpineWeights | null>(null);
  // The latest preference values, readable from the async open() closure and
  // from handlers without waiting on a re-render.
  const fontIdxRef = useRef(1);
  const pagesRef = useRef<PageCount>(pages);
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
  // ABS sometimes catalogs this book's audiobook and ebook as two separate
  // library items instead of one with both files (pairedItemId — see
  // catalog_match.py). The align gateway keys status/maps by the AUDIO
  // item's id, so when this ebook item has no native audio, the anchor
  // shifts to its paired audio item instead of itself.
  const readAlongAnchorId = hasAudio ? itemId : bookDetail?.pairedItemId ?? undefined;
  const readAlong = useReadAlong(readAlongAnchorId, hasAudio || !!bookDetail?.pairedItemId);

  /** Whole-book fraction for a Readium locator: chapter-weighted when the
   *  server sent chapter lengths, otherwise Readium's own (coarser) value. */
  function totalOf(loc: Locator): number {
    const w = weightsRef.current;
    const t = w ? totalFromLocation(w, loc.href.toString(), loc.locations?.progression ?? 0) : null;
    return t ?? loc.locations?.totalProgression ?? 0;
  }

  /** A locator at whole-book fraction [total] — inside the right chapter at the
   *  right depth when chapter lengths are known, else the nearest chapter start. */
  function locatorAtTotal(total: number): Locator | undefined {
    const w = weightsRef.current;
    if (w) {
      const at = locationFromTotal(w, total);
      return new Locator({
        href: at.href,
        type: at.type,
        // `position` isn't optional: Readium finds the page to open by looking
        // this number up in the position list (one entry per chapter, numbered
        // from 1 — see open()), and throws "Locator not found in position list"
        // for a locator without one.
        locations: new LocatorLocations({ position: at.index + 1, progression: at.progression, totalProgression: total }),
      });
    }
    return nearestLocatorForProgression(positionsRef.current, total);
  }

  // Latest key-action handler, reachable from the long-lived listeners below
  // (Readium's `peripheral` callback is created once, inside open()).
  const actionRef = useRef<(action: string) => void>(() => {});
  actionRef.current = (action) => {
    if (action === KEY_NEXT) nextPage();
    else if (action === KEY_PREV) prevPage();
    else if (action === KEY_ESCAPE) {
      if (panel) setPanel(null);
      else if (immersive) exitImmersive();
    } else if (action === KEY_FULLSCREEN) {
      if (immersive) exitImmersive();
      else enterImmersive();
    }
  };

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

        weightsRef.current = buildSpineWeights(manifestJson);
        setToc(flattenToc(manifestJson.toc));

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
        fontIdxRef.current = initialFontIdx;

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
        // undefined. (Real in-chapter progress comes from weightsRef, not this.)
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

        // Where to open: an explicit read-along jump, else the saved position.
        // A read-along "jump to text" link (Player.tsx) arrives as
        // ?atProgression=<0..1> — it overrides the saved position for this
        // one load.
        const atProgressionParam = searchParams.get("atProgression");
        const atProgression = atProgressionParam !== null ? Number(atProgressionParam) : null;
        let initialLocator: Locator | undefined;
        if (atProgression !== null && Number.isFinite(atProgression) && positions.length > 0) {
          explicitProgressionRef.current = true;
          initialLocator = locatorAtTotal(atProgression);
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
          const saved = positionRes.locator ? Locator.deserialize(positionRes.locator) : undefined;
          const savedFraction = positionRes.progress ?? 0;
          if (saved && Math.abs(totalOf(saved) - savedFraction) <= POSITION_DISAGREE) {
            initialLocator = saved; // our own, precise position — still in step with the saved %
          } else if (savedFraction > 0.005) {
            // No locator we can open (the Audex app writes its own format) or one
            // that's out of step with the % another client has since written:
            // the percentage is the part every client agrees on.
            initialLocator = locatorAtTotal(savedFraction);
          } else {
            initialLocator = saved;
          }
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
            const total = totalOf(loc);
            progressionRef.current = total;
            setFraction(total);
            setProgressPct(Math.round(total * 100));
            setChapterTitle(loc.title ?? null);
            const w = weightsRef.current;
            if (w) setCurrentIdx(Math.max(0, w.hrefs.indexOf(loc.href.toString().split("#")[0])));
            queueSave(itemId!, loc, total);
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
          peripheral: (data) => actionRef.current(data.type),
        };

        nav = new EpubNavigator(
          containerRef.current!,
          pub,
          listeners,
          positions,
          initialLocator,
          {
            preferences: prefsFor(initialFontIdx, pagesRef.current),
            defaults: {},
            keyboardPeripherals: KEYBOARD_PERIPHERALS,
          },
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
    const target = locatorAtTotal(targetP);
    if (!target) return;
    navRef.current.go(target, true, () => {});
    setResumeNotice("Resumed from your listening progress");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readAlong.map, bookDetail]);

  // Debounced, not on every positionChanged — a fast page-turner would
  // otherwise fire a PATCH per page. Coalesces to the LATEST position only:
  // fine to drop an intermediate position, never fine to drop the final one
  // (the unmount cleanup above flushes it synchronously on the way out).
  const pendingRef = useRef<{ locator: Locator; total: number } | null>(null);
  function queueSave(id: string, locator: Locator, total: number) {
    pendingRef.current = { locator, total };
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => flushSave(id), SAVE_DEBOUNCE_MS);
  }
  function flushSave(id: string) {
    const pending = pendingRef.current;
    if (!pending) return;
    pendingRef.current = null;
    // Readium's own totalProgression in the saved locator is chapter-granular;
    // overwrite it with the whole-book fraction so anything reading the stored
    // locator (not just ebookProgress) sees the real number.
    const locator = pending.locator.serialize() as { locations?: { totalProgression?: number } };
    if (locator.locations) locator.locations.totalProgression = pending.total;
    api.saveReadPosition(id, { locator: locator as Record<string, unknown>, progress: pending.total }).catch(() => {});
  }

  function prevPage() {
    navRef.current?.goBackward(true, () => {});
  }
  function nextPage() {
    navRef.current?.goForward(true, () => {});
  }

  /** Header/toolbar buttons hand focus back to the page after a click, so Space
   *  and the arrow keys keep turning pages instead of re-pressing the button
   *  you last clicked. */
  const act = (fn: () => void) => (e: React.MouseEvent<HTMLElement>) => {
    fn();
    e.currentTarget.blur();
  };

  async function changeFontSize(delta: number) {
    const idx = Math.max(0, Math.min(FONT_SIZES.length - 1, fontIdxRef.current + delta));
    if (idx === fontIdxRef.current || !navRef.current) return;
    fontIdxRef.current = idx;
    setFontSizeIdx(idx);
    await navRef.current.submitPreferences(prefsFor(idx, pagesRef.current));
    api.updateSettings({ readerFontSize: FONT_SIZES[idx] }).catch(() => {});
  }

  async function changePages(count: PageCount) {
    if (count === pagesRef.current) return;
    pagesRef.current = count;
    setPages(count);
    try {
      localStorage.setItem(PAGES_KEY, String(count));
    } catch {
      /* per-device convenience only — fine if it doesn't stick */
    }
    await navRef.current?.submitPreferences(prefsFor(fontIdxRef.current, count));
  }

  /** Jump to a chapter from the Chapters list. */
  function goToc(item: TocItem) {
    const [base, fragment] = item.href.split("#");
    const w = weightsRef.current;
    const at = w ? w.hrefs.indexOf(base) : -1;
    navRef.current?.go(
      new Locator({
        href: base,
        type: at >= 0 && w ? w.types[at] : "application/xhtml+xml",
        locations: new LocatorLocations({
          fragments: fragment ? [fragment] : [],
          progression: 0,
          position: at >= 0 ? at + 1 : undefined,
        }),
      }),
      true,
      () => {},
    );
    setPanel(null);
  }

  /** The slider was released: go to wherever it was dragged to. */
  function commitSeek(e: React.SyntheticEvent<HTMLInputElement>) {
    const value = Number(e.currentTarget.value) / 1000;
    setScrub(null);
    e.currentTarget.blur(); // hand the arrow keys back to page turning
    const target = locatorAtTotal(value);
    if (target) navRef.current?.go(target, true, () => {});
  }

  /** Navigate to the player at the point the text has reached — the reader-
   *  side half of the cross-format jump (docs/SYNC_API.md §3). */
  function jumpToAudio() {
    if (!itemId || !readAlong.map) return;
    const t = timeAtProgression(readAlong.map, progressionRef.current);
    if (t === null) return;
    const playItemId = hasAudio ? itemId : bookDetail?.pairedItemId ?? itemId;
    navigate(`/play/${playItemId}?atTime=${t}`);
  }

  // ── Full-screen reading ────────────────────────────────────────────────
  // Two layers: `immersive` (shell state) hides the side nav / mini-player so
  // the book gets the whole window — that works everywhere. On top of it we
  // ask the browser for REAL fullscreen to also hide its own chrome; that's
  // best-effort (iPhone Safari refuses it for non-video elements, and any
  // browser can deny it), so a refusal just leaves the in-app layout, which
  // is still the "hide the library" behaviour that was asked for.
  function enterImmersive() {
    setImmersive(true);
    try {
      void document.documentElement.requestFullscreen?.()?.catch(() => {});
    } catch {
      /* no Fullscreen API — in-app immersive only */
    }
  }
  function exitImmersive() {
    setImmersive(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }

  // Esc in browser-fullscreen is swallowed by the browser (it exits fullscreen
  // itself and never reaches our key handler) — so follow the browser's own
  // state: once fullscreen is gone, the in-app layout has to come back too.
  // On unmount (leaving the reader) always restore the full UI, or the side
  // nav would stay hidden on every other page.
  useEffect(() => {
    function onFullscreenChange() {
      if (!document.fullscreenElement) setImmersive(false);
    }
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      setImmersive(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    };
  }, [setImmersive]);

  // ── Keyboard ────────────────────────────────────────────────────────────
  // This covers focus ANYWHERE on the page (the header, the bottom bar, the
  // empty margins); a key pressed while focus is inside the book itself goes
  // through Readium's peripherals instead (KEYBOARD_PERIPHERALS above).
  // Text fields, selects and the progress slider keep their own arrow keys,
  // and Space leaves a focused button/link alone so it still activates.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      let action: string | null = null;
      switch (e.key) {
        case "ArrowRight":
        case "PageDown":
          action = KEY_NEXT;
          break;
        case "ArrowLeft":
        case "PageUp":
          action = KEY_PREV;
          break;
        case " ":
          if (tag === "BUTTON" || tag === "A") return;
          action = e.shiftKey ? KEY_PREV : KEY_NEXT;
          break;
        case "Escape":
          action = KEY_ESCAPE;
          break;
        case "f":
        case "F":
          action = KEY_FULLSCREEN;
          break;
      }
      if (!action) return;
      e.preventDefault(); // Space/PageDown would otherwise scroll the app page behind the book
      actionRef.current(action);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
      pendingRef.current = null;
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

  // The chapter-list entry for where you are: the last one that starts at or
  // before the chapter on screen.
  let activeToc = -1;
  const weights = weightsRef.current;
  if (weights) {
    toc.forEach((t, i) => {
      const at = weights.hrefs.indexOf(t.href.split("#")[0]);
      if (at >= 0 && at <= currentIdx) activeToc = i;
    });
  }
  const shownFraction = scrub ?? fraction;
  // The chapter name for the header comes from the table of contents, not from
  // the locator Readium reports: a locator we built ourselves (a chapter-list
  // pick, the slider, a resume from a saved %) carries no title of its own.
  const shownChapter = (activeToc >= 0 ? toc[activeToc]?.title : null) ?? chapterTitle;

  return (
    <div className="reader-wrap" tabIndex={-1}>
      <header className="reader-head">
        <button className="reader-back" onClick={() => navigate("/")}>
          ← Library
        </button>
        <div className="reader-head-title">
          <span className="reader-book-title">{title}</span>
          {shownChapter && <span className="reader-chapter-title"> · {shownChapter}</span>}
        </div>
        <div className="reader-head-right">
          {(hasAudio || bookDetail?.pairedItemId) && (
            <button
              className="reader-listen-btn"
              onClick={() =>
                readAlong.map ? jumpToAudio() : navigate(`/play/${hasAudio ? itemId : bookDetail!.pairedItemId}`)
              }
            >
              🎧 Listen
            </button>
          )}
          <button
            className="reader-font-btn"
            onClick={act(() => changeFontSize(-1))}
            aria-label="Smaller text"
            title={`Smaller text (now ${FONT_SIZES[fontSizeIdx]}%)`}
            disabled={fontSizeIdx === 0}
          >
            A-
          </button>
          <button
            className="reader-font-btn"
            onClick={act(() => changeFontSize(1))}
            aria-label="Larger text"
            title={`Larger text (now ${FONT_SIZES[fontSizeIdx]}%)`}
            disabled={fontSizeIdx === FONT_SIZES.length - 1}
          >
            A+
          </button>
          <div className="reader-seg" role="group" aria-label="Pages per view">
            <button
              className={`reader-font-btn ${pages === 1 ? "active" : ""}`}
              onClick={act(() => changePages(1))}
              aria-label="One page"
              aria-pressed={pages === 1}
              title="One page at a time"
            >
              <svg width="12" height="14" viewBox="0 0 12 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <rect x="1.5" y="1.5" width="9" height="11" rx="1" />
              </svg>
            </button>
            <button
              className={`reader-font-btn ${pages === 2 ? "active" : ""}`}
              onClick={act(() => changePages(2))}
              aria-label="Two pages"
              aria-pressed={pages === 2}
              title="Two pages side by side"
            >
              <svg width="20" height="14" viewBox="0 0 20 14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
                <rect x="1.5" y="1.5" width="7.5" height="11" rx="1" />
                <rect x="11" y="1.5" width="7.5" height="11" rx="1" />
              </svg>
            </button>
          </div>
          <button className="reader-font-btn" onClick={act(discardProgress)} disabled={discarding} aria-label="Discard progress">
            {discarding ? "…" : "⟲"}
          </button>
          <button
            className="reader-font-btn"
            onClick={act(immersive ? exitImmersive : enterImmersive)}
            aria-label={immersive ? "Exit full screen" : "Full screen"}
            title={immersive ? "Exit full screen (Esc)" : "Full screen (F)"}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {immersive ? (
                <path d="M5 1v4H1M13 5H9V1M9 13V9h4M1 9h4v4" />
              ) : (
                <path d="M1 5V1h4M9 1h4v4M13 9v4H9M5 13H1V9" />
              )}
            </svg>
          </button>
        </div>
      </header>

      {loading && <p className="sub" style={{ padding: "2rem" }}>Loading…</p>}

      <div className="reader-frame-wrap">
        <button className="reader-nav-edge reader-nav-prev" onClick={act(prevPage)} aria-label="Previous page">
          ‹
        </button>
        <div ref={containerRef} className="reader-frame" />
        <button className="reader-nav-edge reader-nav-next" onClick={act(nextPage)} aria-label="Next page">
          ›
        </button>
      </div>

      {resumeNotice && <p className="reader-resume-notice">{resumeNotice}</p>}

      {(hasAudio || bookDetail?.pairedItemId) && !readAlong.map && (
        // The switch-to-listening action itself now lives in the header
        // (always visible, no scrolling needed) — this block is just the
        // read-along build prompt/status, which only matters pre-map.
        <div className="reader-readalong">
          {readAlong.status && readAlong.status.state !== "none" && readAlong.status.state !== "error" ? (
            <span className="reader-readalong-status">Building word sync…</span>
          ) : (
            <button className="reader-readalong-build" onClick={() => readAlong.requestBuild(hasAudio ? undefined : itemId)}>
              Build read-along
            </button>
          )}
          {readAlong.error && <span className="reader-readalong-status">{readAlong.error}</span>}
        </div>
      )}

      {/* Bottom bar: a thin progress line is always there; the controls appear
          when the mouse is over it (or focus is inside it, or the chapter list
          is open). */}
      <div className={`reader-bottom ${panel ? "open" : ""}`}>
        {panel === "chapters" && (
          <div className="reader-panel" role="dialog" aria-label="Chapters">
            <div className="reader-panel-title">Chapters</div>
            {toc.length === 0 ? (
              <p className="reader-panel-empty">This book has no table of contents.</p>
            ) : (
              toc.map((t, i) => (
                <button
                  key={`${t.href}-${i}`}
                  className={`reader-panel-item ${i === activeToc ? "active" : ""}`}
                  style={{ paddingLeft: `${0.8 + t.depth * 0.9}rem` }}
                  onClick={act(() => goToc(t))}
                >
                  {t.title}
                </button>
              ))
            )}
          </div>
        )}
        <div className="reader-controls">
          <button
            className="reader-font-btn"
            onClick={act(() => setPanel((p) => (p === "chapters" ? null : "chapters")))}
            aria-expanded={panel === "chapters"}
          >
            ☰ Chapters
          </button>
          <input
            className="reader-slider"
            type="range"
            min={0}
            max={1000}
            value={Math.round(shownFraction * 1000)}
            onChange={(e) => setScrub(Number(e.target.value) / 1000)}
            onPointerUp={commitSeek}
            onKeyUp={(e) => {
              if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(e.key)) commitSeek(e);
            }}
            aria-label="Reading progress"
          />
          <span className="reader-progress-pct">{Math.round(shownFraction * 100)}%</span>
        </div>
        <div className="reader-progress-line" aria-hidden>
          <div className="reader-progress-fill" style={{ width: `${(progressPct === null ? 0 : fraction) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
