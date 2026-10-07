// Reader appearance — the model in docs/READER_APPEARANCE.md, shared with the Audex app so the
// reader looks and behaves the same in both: text size in points like any word processor (12 pt is
// the book's normal size), a theme that follows the device's light/dark mode by default (or Light /
// Sepia / Dark / your own colours), and a font.
import { useEffect, useState } from "react";
import { EpubPreferences } from "@readium/navigator";

export type ThemeChoice = "auto" | "light" | "dark" | "sepia" | "custom";
export type FontChoice =
  | "publisher"
  | "serif"
  | "sans"
  | "mono"
  | "georgia"
  | "palatino"
  | "times"
  | "arial"
  | "verdana"
  | "courier"
  | "custom";

export interface ReaderAppearance {
  fontSizePt: number; // points; 12 = the book's normal size
  theme: ThemeChoice;
  font: FontChoice;
  fontName: string; // the font's name, used when font === "custom" (must be installed on this device)
  /** Spacing — null means "the book's own". */
  lineSpacing: number | null;
  paragraphSpacing: number | null;
  letterSpacing: number | null;
  wordSpacing: number | null;
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
  fontName: "",
  lineSpacing: null,
  paragraphSpacing: null,
  letterSpacing: null,
  wordSpacing: null,
  textColor: "#1a1a1a",
  backgroundColor: "#ffffff",
};

/** The four spacing controls: ranges and steps, identical in the Audex app (docs/READER_APPEARANCE.md). */
export type SpacingKey = "lineSpacing" | "paragraphSpacing" | "letterSpacing" | "wordSpacing";
export const SPACING: Record<SpacingKey, { label: string; min: number; max: number; step: number; start: number }> = {
  lineSpacing: { label: "Line spacing", min: 1, max: 2.5, step: 0.1, start: 1.4 },
  paragraphSpacing: { label: "Paragraph spacing", min: 0, max: 2, step: 0.25, start: 0.5 },
  letterSpacing: { label: "Letter spacing", min: 0, max: 0.5, step: 0.05, start: 0.05 },
  wordSpacing: { label: "Word spacing", min: 0, max: 1, step: 0.125, start: 0.25 },
};
const clampSpacing = (key: SpacingKey, v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const { min, max } = SPACING[key];
  return Math.round(Math.max(min, Math.min(max, n)) * 1000) / 1000;
};
const FONT_NAME = /^[A-Za-z0-9 _'-]{1,60}$/;

/** The exact colours of each preset — the same values the Audex app uses. */
export const PRESETS: Record<"light" | "dark" | "sepia", { text: string; background: string }> = {
  light: { text: "#1a1a1a", background: "#ffffff" },
  dark: { text: "#e4e4e4", background: "#121212" },
  sepia: { text: "#433422", background: "#f4ecd8" },
};

/** CSS font-family for each choice (a named font + a generic fallback); null = leave the book's own font alone. */
export const FONT_CSS: Record<Exclude<FontChoice, "custom">, string | null> = {
  publisher: null,
  serif: "serif",
  sans: "sans-serif",
  mono: "monospace",
  georgia: "Georgia, serif",
  palatino: 'Palatino, "Palatino Linotype", "Book Antiqua", serif',
  times: '"Times New Roman", Times, serif',
  arial: "Arial, Helvetica, sans-serif",
  verdana: "Verdana, sans-serif",
  courier: '"Courier New", Courier, monospace',
};

export const FONT_LABELS: Record<FontChoice, string> = {
  publisher: "Book's own",
  serif: "Serif",
  sans: "Sans-serif",
  mono: "Monospace",
  georgia: "Georgia",
  palatino: "Palatino",
  times: "Times New Roman",
  arial: "Arial",
  verdana: "Verdana",
  courier: "Courier New",
  custom: "Other…",
};

/** The CSS font-family for the current choice (null = the book's own font). */
export function fontFamilyFor(a: ReaderAppearance): string | null {
  if (a.font === "custom") return a.fontName ? `"${a.fontName}", serif` : null;
  return FONT_CSS[a.font];
}

export const clampFont = (pt: number) => Math.max(FONT_MIN_PT, Math.min(FONT_MAX_PT, Math.round(pt)));

/** The next size up/down the ladder from `pt` (works for sizes typed in between rungs). */
export function stepFont(pt: number, direction: 1 | -1): number {
  const next = direction === 1 ? FONT_LADDER.find((s) => s > pt) : [...FONT_LADDER].reverse().find((s) => s < pt);
  return next ?? clampFont(pt);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const THEMES: ThemeChoice[] = ["auto", "light", "dark", "sepia", "custom"];
const FONTS: FontChoice[] = ["publisher", "serif", "sans", "mono", "georgia", "palatino", "times", "arial", "verdana", "courier", "custom"];

/** Anything stored or received → a valid appearance (bad/missing fields fall back to defaults). */
export function sanitizeAppearance(raw: unknown): ReaderAppearance {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  // Older saves stored a percent (`fontSize`, 100 = normal): 100% is 12 pt.
  const pt = Number(r.fontSizePt ?? (r.fontSize !== undefined ? (Number(r.fontSize) * NORMAL_PT) / 100 : NaN));
  return {
    fontSizePt: Number.isFinite(pt) ? clampFont(pt) : DEFAULT_APPEARANCE.fontSizePt,
    theme: THEMES.includes(r.theme as ThemeChoice) ? (r.theme as ThemeChoice) : DEFAULT_APPEARANCE.theme,
    font: FONTS.includes(r.font as FontChoice) ? (r.font as FontChoice) : DEFAULT_APPEARANCE.font,
    fontName: typeof r.fontName === "string" && FONT_NAME.test(r.fontName.trim()) ? r.fontName.trim() : "",
    lineSpacing: clampSpacing("lineSpacing", r.lineSpacing),
    paragraphSpacing: clampSpacing("paragraphSpacing", r.paragraphSpacing),
    letterSpacing: clampSpacing("letterSpacing", r.letterSpacing),
    wordSpacing: clampSpacing("wordSpacing", r.wordSpacing),
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
    fontFamily: fontFamilyFor(a),
    lineHeight: a.lineSpacing,
    paragraphSpacing: a.paragraphSpacing,
    letterSpacing: a.letterSpacing,
    wordSpacing: a.wordSpacing,
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
