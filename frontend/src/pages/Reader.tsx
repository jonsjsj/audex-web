import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { HttpFetcher, Locator, LocatorLocations, Manifest, Publication } from "@readium/shared";
import { EpubNavigator, EpubNavigatorListeners } from "@readium/navigator";
import { api, BookDetail } from "../api/client";
import { useShell } from "../components/Shell";
import { labelTocTitles } from "../lib/chapters";
import { usePlayback } from "../lib/PlaybackContext";
import { useReadAlong } from "../lib/useReadAlong";
import {
  clampFont,
  DEFAULT_APPEARANCE,
  FONT_CSS,
  FONT_LABELS,
  FONT_LADDER,
  FONT_MAX_PT,
  FONT_MIN_PT,
  fontFamilyFor,
  FontChoice,
  NORMAL_PT,
  PRESETS,
  ReaderAppearance,
  resolveColors,
  sanitizeAppearance,
  SPACING,
  SpacingKey,
  stepFont,
  ThemeChoice,
  toEpubPreferences,
  usePrefersDark,
} from "../lib/readerAppearance";
import { progressionAt, timeAtProgression } from "../lib/syncMap";
import { buildSpineWeights, locationFromTotal, SpineWeights, totalFromLocation } from "../lib/readerProgress";
import {
  absStore,
  bookmarkTitle,
  BookmarkStore,
  dropLeftOff,
  JUMP_THRESHOLD,
  ebookStore,
  moveLocalBookmarks,
  ReaderBookmark,
} from "../lib/readerBookmarks";
import { madeAt } from "../lib/bookmarkTitle";

// @readium/navigator's HttpFetcher.get() resolves each Link's href against
// THIS base itself (WHATWG URL resolution — see epub.py's build_manifest()
// docstring on the backend for why hrefs in the manifest are plain
// zip-relative paths, not pre-joined with this prefix).
const RES_BASE = (itemId: string) => `/api/read/${itemId}/res/`;

// Appearance (text size in free 5% steps, theme, font, colours) lives in
// lib/readerAppearance.ts — Readium's fontSize is a multiplier (1 = 100%, valid
// 0.7–4), which that module converts from the stored percent.
const SAVE_APPEARANCE_MS = 600;

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

const FOLLOW_KEY = "audexweb.reader.follow";
function loadFollow(): boolean {
  try {
    return localStorage.getItem(FOLLOW_KEY) !== "0"; // on unless switched off
  } catch {
    return true;
  }
}
// After you turn a page yourself, leave it alone for this long before the page
// starts following the audio again.
const FOLLOW_PAUSE_MS = 8000;

const ALIGN_RUNNING = new Set(["queued", "downloading", "extracting", "transcribing", "aligning"]);
// What the alignment service is doing, in words for the person who asked for it.
const ALIGN_PHASE: Record<string, string> = {
  queued: "Waiting in the queue",
  downloading: "Downloading the audiobook",
  extracting: "Reading the book's text",
  transcribing: "Listening to the audiobook",
  aligning: "Matching the audio to the text",
};
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
const KEY_BOOKMARK = "audex-bookmark";
const KEYBOARD_PERIPHERALS = [
  { type: KEY_NEXT, keyCombos: [{ keyCode: 39 }, { keyCode: 34 }, { keyCode: 32 }] }, // →  PageDown  Space
  { type: KEY_PREV, keyCombos: [{ keyCode: 37 }, { keyCode: 33 }, { keyCode: 32, shift: true }] }, // ←  PageUp  Shift+Space
  { type: KEY_ESCAPE, keyCombos: [{ keyCode: 27 }] },
  { type: KEY_FULLSCREEN, keyCombos: [{ keyCode: 70 }] }, // F
  { type: KEY_BOOKMARK, keyCombos: [{ keyCode: 66 }] }, // B
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

/** A font-size box like a word processor's: type any size in points, or pick one from the list. */
function SizeBox({ id, value, onCommit }: { id: string; value: number; onCommit: (pt: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Number(text.replace(",", "."));
    if (Number.isFinite(n) && n > 0) onCommit(clampFont(n));
    else setText(String(value));
  };
  return (
    <span className="reader-ap-size">
      <input
        id={id}
        type="text"
        inputMode="numeric"
        list={`${id}-list`}
        value={text}
        aria-label="Font size in points"
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
      <span className="reader-ap-unit">pt</span>
      <datalist id={`${id}-list`}>
        {FONT_LADDER.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
    </span>
  );
}

export default function Reader() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { immersive, setImmersive } = useShell();
  const playback = usePlayback();
  const containerRef = useRef<HTMLDivElement>(null);
  const navRef = useRef<EpubNavigator | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [title, setTitle] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [reportSent, setReportSent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [appearance, setAppearanceState] = useState<ReaderAppearance>(DEFAULT_APPEARANCE);
  const systemDark = usePrefersDark();
  const bookColors = resolveColors(appearance, systemDark);
  const [pages, setPages] = useState<PageCount>(loadPages);
  const [progressPct, setProgressPct] = useState<number | null>(null);
  const [fraction, setFraction] = useState(0); // whole-book 0..1, drives the slider
  const [scrub, setScrub] = useState<number | null>(null); // slider value while dragging, before it's committed
  const [chapterTitle, setChapterTitle] = useState<string | null>(null);
  const [currentIdx, setCurrentIdx] = useState(0); // reading-order index of the chapter on screen
  const [toc, setToc] = useState<TocItem[]>([]);
  const [topPinned, setTopPinned] = useState(false); // the top bar was tapped open (no hover on a phone)
  // A tapped-open top bar folds itself away again after a few seconds (a phone has no hover to leave).
  useEffect(() => {
    if (!topPinned) return;
    const t = window.setTimeout(() => setTopPinned(false), 5000);
    return () => window.clearTimeout(t);
  }, [topPinned]);
  const [panel, setPanel] = useState<"chapters" | "bookmarks" | "readalong" | "appearance" | null>(null);
  const [follow, setFollow] = useState(loadFollow);
  const [store, setStore] = useState<BookmarkStore | null>(null);
  const [bookmarks, setBookmarks] = useState<ReaderBookmark[]>([]);
  const [toast, setToast] = useState<string | null>(null);
  const [bookDetail, setBookDetail] = useState<BookDetail | null>(null);
  const hasAudio = (bookDetail?.numAudioFiles ?? 0) > 0;
  // Mirrors progressPct as a raw 0..1 fraction — progressPct is rounded for
  // display, too coarse to feed back into progressionAt/timeAtProgression.
  const progressionRef = useRef(0);
  // Chapter lengths from the manifest, for whole-book progress (null → fall
  // back to Readium's chapter-granular value).
  const weightsRef = useRef<SpineWeights | null>(null);
  // The latest preference values, readable from the async open() closure and
  // from handlers without waiting on a re-render.
  const appearanceRef = useRef<ReaderAppearance>(DEFAULT_APPEARANCE);
  const systemDarkRef = useRef(systemDark);
  const saveAppearanceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Follow-the-audio bookkeeping: when a manual page turn last happened, how much
  // of the book one page is (learned from your own page turns), and whether the
  // position change being reported was one WE caused by following.
  const followPausedUntilRef = useRef(0);
  const pageSpanRef = useRef(0.004);
  const lastTotalRef = useRef(0);
  const selfNavRef = useRef(false);
  const pagesRef = useRef<PageCount>(pages);
  // Readium's fixed-size position list from this load — stashed for the
  // auto-resume effect below, which runs later (once the map arrives) and
  // needs the same list the initial ?atProgression= handling used.
  const positionsRef = useRef<Locator[]>([]);
  // Set when the load effect applies an explicit ?atProgression= jump (from
  // the Player's "Jump to text") — the auto-resume effect must not then ALSO
  // override the position from listening progress, fighting that jump.
  const explicitProgressionRef = useRef(false);

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
    } else if (action === KEY_BOOKMARK) {
      void addBookmarkHere();
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

        // The saved appearance (or defaults: normal size, theme follows the device). Set on the ref FIRST —
        // this effect only runs once per item, so the navigator below is built from the ref, not state.
        const initialAppearance = sanitizeAppearance(
          prefs?.readerAppearance ?? { ...DEFAULT_APPEARANCE, fontSize: prefs?.readerFontSize ?? 100 },
        );
        appearanceRef.current = initialAppearance;
        setAppearanceState(initialAppearance);

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
        let resumeNote: string | null = null;
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
          // One work, one progress: `detail` already folds in the other
          // edition's saved progress (see library.py _share_twin_progress), so
          // a book you read in another app — or listened to — opens where you are.
          const savedFraction = Math.max(positionRes.progress ?? 0, detail?.ebookProgress ?? 0);
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
          // Listened further than you've read? Carry the audio position over —
          // exactly through the read-along map when there is one, otherwise by
          // fraction (the audio's % through the book is a close stand-in).
          if (detail && detail.audioProgress > savedFraction + 0.01 && detail.audioProgress < 0.999) {
            const audioId = detail.numAudioFiles > 0 ? itemId! : detail.pairedItemId;
            const map = audioId ? await api.readAlongMap(audioId).catch(() => null) : null;
            const exact = map ? progressionAt(map, detail.audioTimeS) : null;
            const target = locatorAtTotal(exact ?? detail.audioProgress);
            if (target) {
              initialLocator = target;
              resumeNote = exact !== null ? "Resumed from your listening progress" : "Resumed near your listening progress";
            }
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
            const step = total - lastTotalRef.current;
            if (!selfNavRef.current && step > 0 && step < 0.05) pageSpanRef.current = step; // one page, as turned by hand
            selfNavRef.current = false;
            lastTotalRef.current = total;
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
            preferences: toEpubPreferences(initialAppearance, pagesRef.current, systemDarkRef.current),
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
        setLoading(false);
        if (resumeNote) flash(resumeNote, 4500);
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

  // ── Follow the audio ────────────────────────────────────────────────────
  // With a read-along map and THIS book's audiobook playing, turn the page to
  // wherever the narration has reached. "On the page you're looking at" is the
  // span from the page's start to one page further (learned from your own page
  // turns, so a two-page spread or a bigger font is accounted for); only when
  // the narration leaves that span does the page move. Turning a page yourself
  // pauses this briefly (pauseFollow) so it never fights you.
  const followingThisBook = !!readAlongAnchorId && playback.itemId === readAlongAnchorId && playback.isPlaying;
  useEffect(() => {
    if (!follow || !readAlong.map || !followingThisBook) return;
    if (Date.now() < followPausedUntilRef.current) return;
    const p = progressionAt(readAlong.map, playback.positionS);
    if (p === null) return;
    const here = progressionRef.current;
    const slack = Math.max(0.002, pageSpanRef.current * 1.1);
    if (p >= here - 0.0005 && p <= here + slack) return; // the narrator is on this page
    const target = locatorAtTotal(p);
    if (!target) return;
    selfNavRef.current = true; // so this jump isn't mistaken for a page turn by hand
    navRef.current?.go(target, false, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playback.positionS, follow, readAlong.map, followingThisBook]);

  function toggleFollow() {
    setFollow((v) => {
      try {
        localStorage.setItem(FOLLOW_KEY, v ? "0" : "1");
      } catch {
        /* per-device convenience only */
      }
      return !v;
    });
  }

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

  /** A deliberate move by the reader: don't let following the audio yank the
   *  page straight back for a few seconds. */
  function pauseFollow() {
    followPausedUntilRef.current = Date.now() + FOLLOW_PAUSE_MS;
  }

  function prevPage() {
    pauseFollow();
    navRef.current?.goBackward(true, () => {});
  }
  function nextPage() {
    pauseFollow();
    navRef.current?.goForward(true, () => {});
  }

  /** Header/toolbar buttons hand focus back to the page after a click, so Space
   *  and the arrow keys keep turning pages instead of re-pressing the button
   *  you last clicked. */
  const act = (fn: () => void) => (e: React.MouseEvent<HTMLElement>) => {
    fn();
    e.currentTarget.blur();
  };

  /** Change any part of the appearance: applied to the open book at once, saved a moment later. */
  function updateAppearance(patch: Partial<ReaderAppearance>) {
    const next = sanitizeAppearance({ ...appearanceRef.current, ...patch });
    appearanceRef.current = next;
    setAppearanceState(next);
    void navRef.current?.submitPreferences(toEpubPreferences(next, pagesRef.current, systemDarkRef.current));
    if (saveAppearanceTimerRef.current) clearTimeout(saveAppearanceTimerRef.current);
    saveAppearanceTimerRef.current = setTimeout(() => {
      api.updateSettings({ readerAppearance: appearanceRef.current }).catch(() => {});
    }, SAVE_APPEARANCE_MS);
  }

  /** A−/A+ : the next size up/down the usual ladder (9, 10, 11, 12, 14, 16, 18 … pt). */
  const changeFontSize = (direction: 1 | -1) => updateAppearance({ fontSizePt: stepFont(appearanceRef.current.fontSizePt, direction) });

  // Auto theme: re-apply when the device flips between light and dark.
  useEffect(() => {
    systemDarkRef.current = systemDark;
    if (appearanceRef.current.theme === "auto") {
      void navRef.current?.submitPreferences(toEpubPreferences(appearanceRef.current, pagesRef.current, systemDark));
    }
  }, [systemDark]);

  async function changePages(count: PageCount) {
    if (count === pagesRef.current) return;
    pagesRef.current = count;
    setPages(count);
    try {
      localStorage.setItem(PAGES_KEY, String(count));
    } catch {
      /* per-device convenience only — fine if it doesn't stick */
    }
    await navRef.current?.submitPreferences(toEpubPreferences(appearanceRef.current, count, systemDarkRef.current));
  }

  // ── Bookmarks ───────────────────────────────────────────────────────────
  /** A short message over the bottom bar. An overlay, not a line in the page
   *  flow: a line that appears and disappears resizes the book underneath it. */
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function flash(message: string, ms = 2600) {
    setToast(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), ms);
  }

  // Where this book's bookmarks live: always in Audiobookshelf, so Audex and Codex show them too — on the
  // audio item when there's an audiobook edition (this item's own audio, or a paired audio item), otherwise
  // on this ebook item (see lib/readerBookmarks.ts and docs/BOOKMARKS.md).
  useEffect(() => {
    if (!itemId || !bookDetail) return;
    let cancelled = false;
    (async () => {
      let next: BookmarkStore;
      if (bookDetail.numAudioFiles > 0 && (bookDetail.durationS ?? 0) > 0) {
        next = absStore(itemId, bookDetail.durationS!);
      } else {
        const other = bookDetail.pairedItemId ? await api.item(bookDetail.pairedItemId).catch(() => null) : null;
        next =
          other && other.numAudioFiles > 0 && (other.durationS ?? 0) > 0
            ? absStore(other.id, other.durationS!)
            : ebookStore(itemId);
        // Bookmarks an older version kept only in this app's own database go into Audiobookshelf too.
        if (!other || other.numAudioFiles === 0) await moveLocalBookmarks(itemId, next);
      }
      if (cancelled) return;
      setStore(next);
      next.list().then((rows) => !cancelled && setBookmarks(rows)).catch(() => {});
    })();
    return () => {
      cancelled = true;
    };
  }, [itemId, bookDetail]);

  async function refreshBookmarks() {
    if (store) setBookmarks(await store.list().catch(() => bookmarks));
  }

  async function addBookmarkHere() {
    if (!store) return;
    const at = progressionRef.current;
    try {
      await store.add(at, bookmarkTitle(at));
      flash(`Bookmarked at ${Math.round(at * 100)}%`);
      await refreshBookmarks();
    } catch (e) {
      flash(e instanceof Error ? e.message : "Couldn't save that bookmark.");
    }
  }

  async function removeBookmark(b: ReaderBookmark) {
    if (!store) return;
    await store.remove(b).catch(() => {});
    await refreshBookmarks();
  }

  /** Before a big jump (slider, chapter, bookmark): remember where you WERE, so an
   *  accidental jump never loses your place. */
  function leftOffBeforeJump(to: number) {
    pauseFollow();
    const from = progressionRef.current;
    if (!store || Math.abs(to - from) <= JUMP_THRESHOLD) return;
    void dropLeftOff(store, bookmarks, from)
      .then(refreshBookmarks)
      .catch(() => {});
  }

  function goBookmark(b: ReaderBookmark) {
    leftOffBeforeJump(b.fraction);
    const target = locatorAtTotal(b.fraction);
    if (target) navRef.current?.go(target, true, () => {});
    setPanel(null);
  }

  /** Jump to a chapter from the Chapters list. */
  function goToc(item: TocItem) {
    const [base, fragment] = item.href.split("#");
    const w = weightsRef.current;
    const at = w ? w.hrefs.indexOf(base) : -1;
    if (w && at >= 0) leftOffBeforeJump(w.starts[at] / w.total);
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
    leftOffBeforeJump(value);
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
        case "b":
        case "B":
          action = KEY_BOOKMARK;
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
  // The chapter name comes from the table of contents, not from the locator
  // Readium reports: a locator we built ourselves (a chapter-list pick, the
  // slider, a resume from a saved %) carries no title of its own. A title that
  // names its number reads "Chapter 33: The Gate", like the audio player's
  // chapter line (lib/chapters.ts); anything else is shown as the book has it.
  const tocTitle = activeToc >= 0 ? toc[activeToc]?.title : null;
  const labelled = (tocTitle ? labelTocTitles([tocTitle])[0] : null) ?? chapterTitle;
  const shownChapter = labelled && labelled !== "Untitled" ? labelled : null; // flattenToc's stand-in for a blank title

  // Read-along (word sync): what to show for this book. Only books that have an
  // audiobook edition — its own, or a paired one — can ever be aligned.
  const canAlign = hasAudio || !!bookDetail?.pairedItemId;
  const raStatus = readAlong.status;
  const raReady = !!readAlong.map;
  const raRunning = !raReady && !!raStatus && ALIGN_RUNNING.has(raStatus.state);
  const raFailed = !raReady && raStatus?.state === "error";
  const raOff = !raReady && raStatus?.configured === false;
  const raText = raReady ? (follow && followingThisBook ? "Following" : "Read-along") : raRunning ? "Aligning…" : "Read-along";
  const raMark = raReady
    ? follow && followingThisBook
      ? ""
      : "✓"
    : raRunning
      ? `${Math.round((raStatus?.progress ?? 0) * 100)}%`
      : raFailed
        ? "⚠"
        : "";

  return (
    <div className="reader-wrap" tabIndex={-1}>
      {/* Top bar: folds away like the bottom controls — a thin strip stays, the title bar appears when the
          mouse is over it (or focus is inside it, a list is open, or the strip was tapped). */}
      <div className={`reader-top ${topPinned ? "open" : ""} ${shownChapter ? "has-chapter" : ""}`}>
      <div className="reader-top-handle" aria-hidden onClick={() => setTopPinned((v) => !v)} />
      {/* Where you are, always on screen while reading — the title bar below (which also names the chapter)
          only slides in on hover, so on its own you'd never see the chapter you're in. */}
      {shownChapter && <div className="reader-top-chapter">{shownChapter}</div>}
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
            title={`Smaller text (now ${appearance.fontSizePt} pt)`}
            disabled={appearance.fontSizePt <= FONT_MIN_PT}
          >
            A-
          </button>
          <button
            className="reader-font-btn"
            onClick={act(() => changeFontSize(1))}
            aria-label="Larger text"
            title={`Larger text (now ${appearance.fontSizePt} pt)`}
            disabled={appearance.fontSizePt >= FONT_MAX_PT}
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
      </div>

      {loading && <p className="sub" style={{ padding: "2rem" }}>Loading…</p>}

      <div className="reader-frame-wrap">
        <button className="reader-nav-edge reader-nav-prev" onClick={act(prevPage)} aria-label="Previous page">
          ‹
        </button>
        <div ref={containerRef} className="reader-frame" style={{ background: bookColors.background }} />
        <button className="reader-nav-edge reader-nav-next" onClick={act(nextPage)} aria-label="Next page">
          ›
        </button>
      </div>

      {/* Bottom bar: a thin progress line is always there; the controls appear
          when the mouse is over it (or focus is inside it, or a list is open). */}
      <div className={`reader-bottom ${panel ? "open" : ""}`}>
        {toast && (
          <div className="reader-toast" role="status">
            {toast}
          </div>
        )}
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
        {panel === "appearance" && (
          <div className="reader-panel reader-appearance" role="dialog" aria-label="Appearance">
            <div className="reader-panel-title">Appearance</div>

            <label className="reader-ap-label" htmlFor="ap-size">
              Font size
            </label>
            <div className="reader-ap-row">
              <button className="reader-font-btn" onClick={act(() => changeFontSize(-1))} aria-label="Smaller text" disabled={appearance.fontSizePt <= FONT_MIN_PT}>
                A−
              </button>
              <SizeBox id="ap-size" value={appearance.fontSizePt} onCommit={(pt) => updateAppearance({ fontSizePt: pt })} />
              <button className="reader-font-btn" onClick={act(() => changeFontSize(1))} aria-label="Larger text" disabled={appearance.fontSizePt >= FONT_MAX_PT}>
                A+
              </button>
              <button className="reader-font-btn" onClick={act(() => updateAppearance({ fontSizePt: NORMAL_PT }))} disabled={appearance.fontSizePt === NORMAL_PT}>
                Normal
              </button>
            </div>

            <label className="reader-ap-label" htmlFor="ap-font">
              Font
            </label>
            <div className="reader-ap-row">
              <select
                id="ap-font"
                className="reader-ap-select"
                value={appearance.font}
                onChange={(e) => updateAppearance({ font: e.target.value as FontChoice })}
              >
                {(Object.keys(FONT_LABELS) as FontChoice[]).map((f) => (
                  <option key={f} value={f} style={{ fontFamily: f === "custom" ? undefined : FONT_CSS[f] ?? undefined }}>
                    {FONT_LABELS[f]}
                  </option>
                ))}
              </select>
              {appearance.font === "custom" && (
                <input
                  className="reader-ap-fontname"
                  type="text"
                  aria-label="Font name"
                  placeholder="Font name, e.g. Garamond"
                  defaultValue={appearance.fontName}
                  onBlur={(e) => updateAppearance({ fontName: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                  }}
                />
              )}
            </div>
            {appearance.font === "custom" && (
              <p className="reader-panel-note">Any font installed on this device. If it isn't, the book falls back to a serif font.</p>
            )}

            <div className="reader-ap-label">Spacing</div>
            {(Object.keys(SPACING) as SpacingKey[]).map((key) => {
              const sp = SPACING[key];
              const value = appearance[key];
              return (
                <div className="reader-ap-row reader-ap-spacing" key={key}>
                  <label htmlFor={`ap-${key}`}>{sp.label}</label>
                  <input
                    id={`ap-${key}`}
                    type="range"
                    min={sp.min}
                    max={sp.max}
                    step={sp.step}
                    value={value ?? sp.start}
                    onChange={(e) => updateAppearance({ [key]: Number(e.target.value) })}
                  />
                  <span className="reader-ap-value">{value === null ? "Book's own" : value.toFixed(key === "letterSpacing" ? 2 : key === "wordSpacing" ? 3 : key === "paragraphSpacing" ? 2 : 1)}</span>
                  <button
                    className="reader-font-btn"
                    onClick={act(() => updateAppearance({ [key]: null }))}
                    disabled={value === null}
                    aria-label={`${sp.label}: use the book's own`}
                  >
                    Reset
                  </button>
                </div>
              );
            })}

            <div className="reader-ap-label">Colours</div>
            <div className="reader-ap-row reader-ap-chips" role="group" aria-label="Theme">
              {(["auto", "light", "sepia", "dark", "custom"] as ThemeChoice[]).map((t) => (
                <button
                  key={t}
                  className={`reader-font-btn ${appearance.theme === t ? "active" : ""}`}
                  aria-pressed={appearance.theme === t}
                  onClick={act(() => {
                    // Switching to Custom starts from the colours you're looking at now.
                    if (t === "custom") {
                      const c = resolveColors(appearanceRef.current, systemDark);
                      updateAppearance({ theme: "custom", textColor: c.text, backgroundColor: c.background });
                    } else updateAppearance({ theme: t });
                  })}
                >
                  {t === "auto" ? "Auto (device)" : t[0].toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
            <div className="reader-ap-row">
              <label className="reader-ap-color">
                Text
                <input
                  type="color"
                  value={appearance.theme === "custom" ? appearance.textColor : bookColors.text}
                  onChange={(e) => updateAppearance({ theme: "custom", textColor: e.target.value, backgroundColor: bookColors.background })}
                  aria-label="Text colour"
                />
              </label>
              <label className="reader-ap-color">
                Background
                <input
                  type="color"
                  value={appearance.theme === "custom" ? appearance.backgroundColor : bookColors.background}
                  onChange={(e) => updateAppearance({ theme: "custom", backgroundColor: e.target.value, textColor: bookColors.text })}
                  aria-label="Background colour"
                />
              </label>
              <span
                className="reader-ap-sample"
                style={{
                  color: bookColors.text,
                  background: bookColors.background,
                  fontFamily: fontFamilyFor(appearance) ?? undefined,
                  lineHeight: appearance.lineSpacing ?? undefined,
                  letterSpacing: appearance.letterSpacing !== null ? `${appearance.letterSpacing}em` : undefined,
                  wordSpacing: appearance.wordSpacing !== null ? `${appearance.wordSpacing}em` : undefined,
                }}
              >
                Sample text
              </span>
            </div>
            <div className="reader-ap-row">
              <button className="reader-font-btn" onClick={act(() => updateAppearance({ ...DEFAULT_APPEARANCE }))}>
                Reset to defaults
              </button>
            </div>
          </div>
        )}
        {panel === "readalong" && canAlign && (
          <div className="reader-panel" role="dialog" aria-label="Read-along">
            <div className="reader-panel-title">Read-along</div>
            {raReady ? (
              <>
                <p className="reader-ra-line">✓ Aligned — the text and the audiobook are in sync.</p>
                <button className="reader-panel-item reader-panel-add" onClick={act(jumpToAudio)}>
                  🎧 Listen from here
                </button>
                <label className="reader-ra-check">
                  <input type="checkbox" checked={follow} onChange={toggleFollow} />
                  <span>Follow the audiobook while it plays</span>
                </label>
                <p className="reader-panel-note">
                  {follow
                    ? followingThisBook
                      ? "Following the audio — the page turns to keep up. Turn a page yourself and it waits a few seconds."
                      : "Start the audiobook (🎧 Listen) and the page will follow it."
                    : "Off — the page stays where you leave it."}
                </p>
              </>
            ) : raOff ? (
              <p className="reader-ra-line">
                Read-along isn't set up on this server. It needs a Codex instance with the alignment service connected.
              </p>
            ) : raRunning ? (
              <>
                <p className="reader-ra-line">{ALIGN_PHASE[raStatus!.state] ?? "Working"}…</p>
                <div className="reader-ra-bar" aria-hidden>
                  <div style={{ width: `${Math.round((raStatus!.progress ?? 0) * 100)}%` }} />
                </div>
                <p className="reader-panel-note">
                  {raStatus!.etaSeconds != null ? `About ${Math.max(1, Math.round(raStatus!.etaSeconds / 60))} min left. ` : ""}
                  This can take a while for a long book — you can keep reading, and it'll be ready next time you look.
                </p>
              </>
            ) : raFailed ? (
              <>
                <p className="reader-ra-line reader-ra-error">
                  Alignment didn't finish{raStatus?.error?.stage ? ` (while ${raStatus.error.stage})` : ""}.
                </p>
                {raStatus?.error?.message && <p className="reader-panel-empty">{raStatus.error.message}</p>}
                {raStatus?.error?.hint && <p className="reader-ra-hint">{raStatus.error.hint}</p>}
                <button className="reader-panel-item reader-panel-add" onClick={act(() => void readAlong.requestBuild(hasAudio ? undefined : itemId))}>
                  Try again
                </button>
              </>
            ) : (
              <>
                <p className="reader-ra-line">Not aligned yet.</p>
                <p className="reader-panel-empty">
                  Aligning matches the audiobook to the text, so you can switch between listening and reading at exactly the same spot,
                  and the page can follow the narration.
                </p>
                <button className="reader-panel-item reader-panel-add" onClick={act(() => void readAlong.requestBuild(hasAudio ? undefined : itemId))}>
                  Request alignment
                </button>
              </>
            )}
            {readAlong.error && <p className="reader-ra-hint">{readAlong.error}</p>}
          </div>
        )}
        {panel === "bookmarks" && (
          <div className="reader-panel" role="dialog" aria-label="Bookmarks">
            <div className="reader-panel-title">Bookmarks</div>
            <button className="reader-panel-item reader-panel-add" onClick={act(() => void addBookmarkHere())} disabled={!store}>
              ＋ Bookmark this spot ({Math.round(fraction * 100)}%)
            </button>
            {bookmarks.length === 0 ? (
              <p className="reader-panel-empty">No bookmarks yet. Press B to add one.</p>
            ) : (
              bookmarks.map((b) => (
                <div key={b.key} className="reader-panel-row">
                  <button className="reader-panel-item" onClick={act(() => goBookmark(b))}>
                    <span className="reader-bm-main">
                      <span className={b.auto ? "reader-bm-auto" : ""}>{b.title}</span>
                      {/* When it was made, and by which app and device. */}
                      <span className="reader-bm-meta">{[madeAt(b.createdAt), b.origin && `via ${b.origin}`].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className="reader-bm-pct">{Math.round(b.fraction * 100)}%</span>
                  </button>
                  <button className="reader-bm-del" onClick={act(() => void removeBookmark(b))} aria-label={`Delete bookmark ${b.title}`}>
                    ×
                  </button>
                </div>
              ))
            )}
            {store && (
              <p className="reader-panel-note">
                Saved to Audiobookshelf with the time and where you made them, so the Audex app shows them too.
              </p>
            )}
          </div>
        )}
        <div className="reader-controls">
          <button
            className="reader-font-btn"
            onClick={act(() => setPanel((p) => (p === "chapters" ? null : "chapters")))}
            aria-expanded={panel === "chapters"}
          >
            ☰ <span className="reader-lbl">Chapters</span>
          </button>
          <button
            className="reader-font-btn"
            onClick={act(() => setPanel((p) => (p === "bookmarks" ? null : "bookmarks")))}
            aria-expanded={panel === "bookmarks"}
          >
            🔖 <span className="reader-lbl">Bookmarks</span>
            {bookmarks.some((b) => !b.auto) ? ` (${bookmarks.filter((b) => !b.auto).length})` : ""}
          </button>
          <button
            className="reader-font-btn"
            onClick={act(() => setPanel((p) => (p === "appearance" ? null : "appearance")))}
            aria-expanded={panel === "appearance"}
            title="Text size, font and colours"
          >
            Aa <span className="reader-lbl">Appearance</span>
          </button>
          {canAlign && (
            <button
              className="reader-font-btn"
              onClick={act(() => setPanel((p) => (p === "readalong" ? null : "readalong")))}
              aria-expanded={panel === "readalong"}
              title="Word-synced read-along"
            >
              🎧 <span className="reader-lbl">{raText}</span>
              {raMark ? ` ${raMark}` : ""}
            </button>
          )}
          <div className="reader-slider-wrap">
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
            {bookmarks.map((b) => (
              <span
                key={b.key}
                className={`reader-tick ${b.auto ? "auto" : ""}`}
                style={{ left: `calc(8px + (100% - 16px) * ${b.fraction})` }}
                title={b.title}
                aria-hidden
              />
            ))}
          </div>
          <span className="reader-progress-pct">{Math.round(shownFraction * 100)}%</span>
          <button className="reader-font-btn" onClick={act(() => void addBookmarkHere())} disabled={!store} title="Bookmark this spot (B)">
            ＋ <span className="reader-lbl">Bookmark</span>
          </button>
        </div>
        <div className="reader-progress-line" aria-hidden>
          <div className="reader-progress-fill" style={{ width: `${(progressPct === null ? 0 : fraction) * 100}%` }} />
        </div>
      </div>
    </div>
  );
}
