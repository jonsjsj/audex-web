import { useEffect, useState } from "react";
import { api, UserPrefs } from "../api/client";

/** The person's app-wide switches (Settings), loaded once and shared, so flipping one in Settings takes effect on
 *  every page at once (the podcasts tab, cover colours, the read-along highlight). */
export interface AppSwitches {
  readAlongHighlight: boolean;
  podcasts: boolean;
  coverColors: boolean;
}

const DEFAULTS: AppSwitches = { readAlongHighlight: true, podcasts: false, coverColors: false };
let current: AppSwitches = DEFAULTS;
let loaded: Promise<void> | null = null;
const listeners = new Set<(s: AppSwitches) => void>();

function from(p: UserPrefs): AppSwitches {
  return {
    readAlongHighlight: p.readAlongHighlight !== false,
    podcasts: p.podcasts === true,
    coverColors: p.coverColors === true,
  };
}

function publish(next: AppSwitches) {
  current = next;
  listeners.forEach((l) => l(next));
}

export function loadSwitches(): Promise<void> {
  if (!loaded) {
    loaded = api
      .settings()
      .then((p) => publish(from(p)))
      .catch(() => {
        loaded = null; // try again next time (signed out, offline…)
      });
  }
  return loaded;
}

/** Flip one switch: shown at once, saved to the server, put back if the save fails. */
export async function setSwitch<K extends keyof AppSwitches>(key: K, value: AppSwitches[K]): Promise<void> {
  const before = current;
  publish({ ...current, [key]: value });
  try {
    await api.updateSettings({ [key]: value } as Partial<UserPrefs>);
  } catch (e) {
    publish(before);
    throw e;
  }
}

export function useSwitches(): AppSwitches {
  const [s, setS] = useState(current);
  useEffect(() => {
    listeners.add(setS);
    setS(current);
    void loadSwitches();
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
