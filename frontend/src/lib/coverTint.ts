import { useEffect, useState } from "react";

/** App colours tinted from the cover (optional — Settings → Extras → "Colours from the cover"; Audex has the same).
 *
 *  The cover's most vivid colour becomes the accent, in a lighter shade on a dark screen and a deeper one on a light
 *  screen, so text and buttons in the accent stay readable either way. Only --accent and --accent-soft change; with the
 *  switch off (or a grey cover) nothing is touched and the usual colours stay. */

export interface Tint {
  light: { accent: string; soft: string };
  dark: { accent: string; soft: string };
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h, s, l];
}

function hsl(h: number, s: number, l: number): string {
  return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`;
}

/** The tint for a cover's pixels (RGBA, as from a canvas), or null when the cover is too grey to give one. */
export function tintFromPixels(data: Uint8ClampedArray): Tint | null {
  const BUCKETS = 24; // 15° of hue each
  const weight = new Array<number>(BUCKETS).fill(0);
  const hueX = new Array<number>(BUCKETS).fill(0);
  const hueY = new Array<number>(BUCKETS).fill(0);
  const sat = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    total++;
    if (s < 0.25 || l < 0.12 || l > 0.9) continue; // greys, near-black and near-white say nothing
    const w = s * (1 - Math.abs(l - 0.5) * 1.4);
    const b = Math.floor(h / (360 / BUCKETS)) % BUCKETS;
    weight[b] += w;
    hueX[b] += Math.cos((h * Math.PI) / 180) * w;
    hueY[b] += Math.sin((h * Math.PI) / 180) * w;
    sat[b] += s * w;
  }
  if (!total) return null;
  // The strongest hue, with its neighbours (a hue on a bucket edge counts for both).
  let best = -1;
  let bestW = 0;
  for (let b = 0; b < BUCKETS; b++) {
    const w = weight[b] + 0.5 * (weight[(b + 1) % BUCKETS] + weight[(b + BUCKETS - 1) % BUCKETS]);
    if (w > bestW) {
      bestW = w;
      best = b;
    }
  }
  if (best < 0 || weight[best] / total < 0.02) return null; // under ~2% vivid pixels: keep the usual colours
  const h = ((Math.atan2(hueY[best], hueX[best]) * 180) / Math.PI + 360) % 360;
  const s = Math.min(0.85, Math.max(0.45, sat[best] / weight[best]));
  return {
    light: { accent: hsl(h, s, 0.38), soft: hsl(h, Math.min(0.6, s), 0.9) },
    dark: { accent: hsl(h, Math.min(0.8, s), 0.66), soft: hsl(h, Math.min(0.45, s), 0.17) },
  };
}

const cache = new Map<string, Tint | null>();

export function tintOf(url: string): Promise<Tint | null> {
  if (cache.has(url)) return Promise.resolve(cache.get(url)!);
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = 40;
        c.height = 40;
        const ctx = c.getContext("2d", { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 40, 40);
        const t = tintFromPixels(ctx.getImageData(0, 0, 40, 40).data);
        cache.set(url, t);
        resolve(t);
      } catch {
        resolve(null); // a cover from another origin can't be read: keep the usual colours
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

// The cover of the page being looked at (a book or a show) wins over the one playing.
let viewed: string | null = null;
const viewedListeners = new Set<(u: string | null) => void>();

/** A page showing one book/show calls this with its cover while it's open. */
export function useViewedCover(url: string | null | undefined) {
  useEffect(() => {
    if (!url) return;
    viewed = url;
    viewedListeners.forEach((l) => l(url));
    return () => {
      if (viewed === url) {
        viewed = null;
        viewedListeners.forEach((l) => l(null));
      }
    };
  }, [url]);
}

export function useViewedCoverValue(): string | null {
  const [v, setV] = useState(viewed);
  useEffect(() => {
    viewedListeners.add(setV);
    setV(viewed);
    return () => {
      viewedListeners.delete(setV);
    };
  }, []);
  return v;
}

const VARS = ["--accent", "--accent-soft"];

export function applyTint(t: Tint | null) {
  const root = document.documentElement.style;
  if (!t) {
    VARS.forEach((v) => root.removeProperty(v));
    return;
  }
  const dark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  const pick = dark ? t.dark : t.light;
  root.setProperty("--accent", pick.accent);
  root.setProperty("--accent-soft", pick.soft);
}
