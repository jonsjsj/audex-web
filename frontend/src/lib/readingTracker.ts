import { api } from "../api/client";
import { localDay } from "./stats";

// Counts what you read for the Stats screen: pages turned forward ONE at a time, and the time the reader was really in
// use. Jumping (contents, chapter skip, the slider, "go to"), going back and flicking past pages aren't counted — the
// caller only calls [page] for a deliberate single page turn forward. The totals are added to today's row on the server
// every half minute and when the tab goes away.

const FLUSH_EVERY_MS = 30_000;
const TICK_MS = 5_000;
/** No page turn, key or click for this long = you stopped reading. */
const IDLE_AFTER_MS = 120_000;
/** Turning pages faster than this is flicking, not reading. */
const MIN_PAGE_GAP_MS = 1_500;

export class ReadingTracker {
  private pages = 0;
  private seconds = 0;
  private lastPageAt = 0;
  private lastActivityAt = Date.now();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFlushAt = Date.now();

  constructor(private itemId: string, private title: () => string) {}

  start() {
    this.stop();
    this.lastActivityAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Any sign you are there (a key, a click, a page turn): reading time keeps counting. */
  activity() {
    this.lastActivityAt = Date.now();
  }

  /** A deliberate single page turn forward. */
  page() {
    const now = Date.now();
    this.lastActivityAt = now;
    if (now - this.lastPageAt >= MIN_PAGE_GAP_MS) this.pages++;
    this.lastPageAt = now;
  }

  private tick() {
    const now = Date.now();
    if (document.visibilityState === "visible" && now - this.lastActivityAt < IDLE_AFTER_MS) this.seconds += TICK_MS / 1000;
    if (now - this.lastFlushAt >= FLUSH_EVERY_MS) this.flush(false);
  }

  /** Send what has been counted since the last send. */
  flush(leaving: boolean) {
    this.lastFlushAt = Date.now();
    const pages = this.pages;
    const seconds = Math.round(this.seconds);
    if (pages === 0 && seconds === 0) return;
    this.pages = 0;
    this.seconds = 0;
    api
      .addReading({ itemId: this.itemId, title: this.title(), day: localDay(), pages, seconds }, { keepalive: leaving })
      .catch(() => {
        // Not lost: put it back for the next send (the server caps one report, so a long outage sends in pieces).
        this.pages += pages;
        this.seconds += seconds;
      });
  }
}
