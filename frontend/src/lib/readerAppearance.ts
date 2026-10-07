// Reader appearance — the model in docs/READER_APPEARANCE.md, shared with the Audex app so the
// reader looks and behaves the same in both: text size in points like any word processor (12 pt is
// the book's normal size), a theme that follows the device's light/dark mode by default (or Light /
// Sepia / Dark / your own colours), and a font.
import { useEffect, useState } from "react";
import { EpubPreferences } from "@readium/navigator";

export type ThemeChoice = "auto" | "light" | "dark" | "sepia" | "custom";
export type FontChoice = "publisher" | "serif" | "sans" | "mono";

export interface ReaderAppearance {
  fontSizePt: number; // points; 12 = the book's normal size
  theme: ThemeChoice;
  font: FontChoice;
  textColor: string; // used when theme === "custom"
  backgroundColor: string; // used when theme === "custom"
}

export const FONT_MIN_PT = 9; // Readium's smallest scale (0.75×) is ~9 pt
export const FONT_MAX_PT = 48; // Readium's largest scale is 4× = 48 pt
export const NORMAL_PT = 12;
/** The sizes a size list offers and A−/A+ step through — the familiar word-processor ladder. */
export const FONT_LADDER = [9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24, 28, 32, 36, 40, 44, 48];

export const DEFAULT_APPEARANCE: ReaderAppearance = {
  fontSizePt: NORMAL_PT,
  theme: "auto",
  font: "publisher",
  textColor: "#1a1a1a",
  backgroundColor: "#ffffff",
};

/** The exact colours of each preset — the same values the Audex app uses. */
export const PRESETS: Record<"light" | "dark" | "sepia", { text: string; background: string }> = {
  light: { text: "#1a1a1a", background: "#ffffff" },
  dark: { text: "#e4e4e4", background: "#121212" },
  sepia: { text: "#433422", background: "#f4ecd8" },
};

/** CSS font-family for each choice; null = leave the book's own font alone. */
export const FONT_CSS: Record<FontChoice, string | null> = {
  publisher: null,
  serif: "serif",
  sans: "sans-serif",
  mono: "monospace",
};

export const FONT_LABELS: Record<FontChoice, string> = {
  publisher: "Book's own",
  serif: "Serif",
  sans: "Sans-serif",
  mono: "Monospace",
};

export const clampFont = (pt: number) => Math.max(FONT_MIN_PT, Math.min(FONT_MAX_PT, Math.round(pt)));

/** The next size up/down the ladder from `pt` (works for sizes typed in between rungs). */
export function stepFont(pt: number, direction: 1 | -1): number {
  const next = direction === 1 ? FONT_LADDER.find((s) => s > pt) : [...FONT_LADDER].reverse().find((s) => s < pt);
  return next ?? clampFont(pt);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const THEMES: ThemeChoice[] = ["auto", "light", "dark", "sepia", "custom"];
const FONTS: FontChoice[] = ["publisher", "serif", "sans", "mono"];

/** Anything stored or received → a valid appearance (bad/missing fields fall back to defaults). */
export function sanitizeAppearance(raw: unknown): ReaderAppearance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Older saves stored a percent (`fontSize`, 100 = normal): 100% is 12 pt.
  const pt = Number(r.fontSizePt ?? (r.fontSize !== undefined ? (Number(r.fontSize) * NORMAL_PT) / 100 : NaN));
  return {
    fontSizePt: Number.isFinite(pt) ? clampFont(pt) : DEFAULT_APPEARANCE.fontSizePt,
    theme: THEMES.includes(r.theme as ThemeChoice) ? (r.theme as ThemeChoice) : DEFAULT_APPEARANCE.theme,
    font: FONTS.includes(r.font as FontChoice) ? (r.font as FontChoice) : DEFAULT_APPEARANCE.font,
    textColor: typeof r.textColor === "string" && HEX.test(r.textColor) ? r.textColor : DEFAULT_APPEARANCE.textColor,
    backgroundColor:
      typeof r.backgroundColor === "string" && HEX.test(r.backgroundColor) ? r.backgroundColor : DEFAULT_APPEARANCE.backgroundColor,
  };
}

/** The colours actually shown: auto follows the device's dark/light setting. */
export function resolveColors(a: ReaderAppearance, systemDark: boolean): { text: string; background: string } {
  if (a.theme === "custom") return { text: a.textColor, background: a.backgroundColor };
  const key = a.theme === "auto" ? (systemDark ? "dark" : "light") : a.theme;
  return PRESETS[key];
}

/** Readium's fontSize is a multiplier (1 = the book's normal size = 12 pt), valid 0.7–4. */
export function toEpubPreferences(a: ReaderAppearance, columnCount: 1 | 2, systemDark: boolean): EpubPreferences {
  const c = resolveColors(a, systemDark);
  return new EpubPreferences({
    fontSize: a.fontSizePt / NORMAL_PT,
    fontFamily: FONT_CSS[a.font],
    textColor: c.text,
    backgroundColor: c.background,
    columnCount,
  });
}

/** Is the device in dark mode right now (and live as it changes)? */
export function usePrefersDark(): boolean {
  const query = "(prefers-color-scheme: dark)";
  const read = () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false);
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(query);
    const onChange = () => setDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}
