// Looking up a word the reader selected (backend: api/dictionary.py).
import { api } from "../api/client";

export interface DictionaryDefinition {
  definition: string;
  example: string;
}
export interface DictionaryMeaning {
  partOfSpeech: string;
  definitions: DictionaryDefinition[];
  synonyms: string[];
}
export interface DictionaryEntry {
  word: string;
  phonetic: string;
  audio: string;
  meanings: DictionaryMeaning[];
  language: string;
  source: string;
  sourceUrl: string;
}

const MAX_WORDS = 3; // a longer selection is being copied or quoted, not looked up
const MAX_CHARS = 40;
const EDGE = /^[^\p{L}]+|[^\p{L}]+$/gu;

/** The word(s) worth looking up in a selection, or null when it isn't one (digits, a sentence, symbols). */
export function lookupTerm(raw: string): string | null {
  const text = (raw || "").replace(/[‘’]/g, "'").replace(EDGE, "").replace(/\s+/g, " ");
  if (!text || text.length > MAX_CHARS) return null;
  if (text.split(" ").length > MAX_WORDS) return null;
  if (!/^\p{L}+(?:[-' ]\p{L}+)*$/u.test(text)) return null;
  return text.toLowerCase();
}

const LOOKUP_KEY = "audexweb.reader.lookup";
/** "Look up selected words" — on unless switched off, per browser. */
export function loadLookupOn(): boolean {
  try {
    return localStorage.getItem(LOOKUP_KEY) !== "0";
  } catch {
    return true;
  }
}
export function saveLookupOn(on: boolean): void {
  try {
    localStorage.setItem(LOOKUP_KEY, on ? "1" : "0");
  } catch {
    /* per-device convenience only */
  }
}

export type Definition = { kind: "found"; entry: DictionaryEntry } | { kind: "none" } | { kind: "error"; message: string };

const cache = new Map<string, Definition>();

/** One lookup; answers (and "no such word") are remembered for the session, a failed attempt is not. */
export async function defineWord(word: string): Promise<Definition> {
  const hit = cache.get(word);
  if (hit) return hit;
  try {
    const entry = await api.define(word);
    const out: Definition = { kind: "found", entry };
    cache.set(word, out);
    return out;
  } catch (e) {
    if ((e as { status?: number }).status === 404) {
      const out: Definition = { kind: "none" };
      cache.set(word, out);
      return out;
    }
    return { kind: "error", message: e instanceof Error ? e.message : "Couldn't look that up." };
  }
}
