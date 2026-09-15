// Thin fetch wrapper for the /api surface (see the plan §4). credentials:"include"
// so the httpOnly session cookie rides along — there is never a token in JS to attach.

export interface Health {
  status: string;
  version: string;
  absConfigured: boolean;
  codexConfigured: boolean;
  ssoEnabled: boolean;
}

export interface Me {
  id: number;
  displayName: string | null;
  email: string | null;
  ssoLinked: boolean;
  absLinked: boolean;
  absUsername: string | null;
  codexLinked: boolean;
  codexConfigured: boolean; // whether the SERVER has a Codex instance set up at all
}

export interface Library {
  id: string;
  name: string;
  mediaType: string;
}

export interface Chapter {
  id: number;
  startS: number;
  endS: number;
  title: string;
}

export interface Book {
  id: string;
  title: string;
  subtitle: string | null;
  author: string | null;
  series: string | null;
  durationS: number | null;
  mediaType: string;
  hasEbook: boolean;
  numAudioFiles: number;
  coverUrl: string;
  progress: number; // 0..1, furthest of audio/ebook progress
  isFinished: boolean;
  lastUpdate: number | null; // epoch ms, null if never opened
}

export interface BookDetail extends Book {
  chapters: Chapter[];
}

export interface PlayTrack {
  index: number;
  startOffsetS: number;
  durationS: number;
  streamUrl: string;
}

export interface PlaySession {
  sessionId: string;
  currentTimeS: number;
  durationS: number;
  tracks: PlayTrack[];
  chapters: Chapter[];
}

export interface Bookmark {
  timeS: number;
  title: string;
  createdAt: number | null;
}

// A Readium Web Publication Manifest — deliberately untyped (`unknown`) here.
// It's handed straight to @readium/shared's Manifest.deserialize(), which
// owns the real shape (https://readium.org/webpub-manifest/); duplicating
// that as a TS interface would just be a second copy to keep in sync.
export type ReadiumManifest = Record<string, unknown>;

// Same reasoning: a Readium Locator, straight to/from Locator.deserialize()/
// .serialize() — see @readium/shared's own Locator.ts for the real shape.
export type ReadiumLocator = Record<string, unknown>;

class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.detail || `Request failed (${res.status})`);
  }
  return res.json();
}

export const api = {
  health: () => request<Health>("/api/health"),
  me: () => request<Me>("/api/auth/me"),
  loginAbs: (username: string, password: string) =>
    request<{ ok: true }>("/api/auth/login/abs", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  linkAbs: (username: string, password: string) =>
    request<{ ok: true; absUsername: string }>("/api/auth/link/abs", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  linkCodex: (token: string) =>
    request<{ ok: true }>("/api/auth/link/codex", { method: "POST", body: JSON.stringify({ token }) }),
  unlinkCodex: () => request<{ ok: true }>("/api/auth/unlink/codex", { method: "POST" }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),

  libraries: () => request<Library[]>("/api/library/libraries"),
  items: (libraryId: string, search = "") =>
    request<{ items: Book[]; total: number }>(
      `/api/library/items?libraryId=${encodeURIComponent(libraryId)}&search=${encodeURIComponent(search)}`,
    ),
  item: (itemId: string) => request<BookDetail>(`/api/library/items/${itemId}`),

  play: (itemId: string) => request<PlaySession>(`/api/play/${itemId}`, { method: "POST" }),
  sync: (itemId: string, body: { sessionId: string; currentTimeS: number; timeListenedS: number; durationS?: number }) =>
    request<{ ok: true }>(`/api/play/${itemId}/sync`, { method: "POST", body: JSON.stringify(body) }),
  close: (itemId: string, body: { sessionId: string; currentTimeS: number; timeListenedS: number; durationS?: number }) =>
    request<{ ok: true }>(`/api/play/${itemId}/close`, { method: "POST", body: JSON.stringify(body) }),
  discardAudioProgress: (itemId: string) =>
    request<{ ok: true }>(`/api/play/${itemId}/progress`, { method: "DELETE" }),
  bookmarks: (itemId: string) => request<Bookmark[]>(`/api/play/${itemId}/bookmarks`),
  addBookmark: (itemId: string, body: { timeS: number; title: string }) =>
    request<{ ok: true }>(`/api/play/${itemId}/bookmarks`, { method: "POST", body: JSON.stringify(body) }),
  removeBookmark: (itemId: string, timeS: number) =>
    request<{ ok: true }>(`/api/play/${itemId}/bookmarks/${Math.round(timeS)}`, { method: "DELETE" }),

  readManifest: (itemId: string) => request<ReadiumManifest>(`/api/read/${itemId}/manifest`),
  readPosition: (itemId: string) =>
    request<{ locator: ReadiumLocator | null }>(`/api/read/${itemId}/position`),
  saveReadPosition: (itemId: string, body: { locator: ReadiumLocator; progress: number }) =>
    request<{ ok: true }>(`/api/read/${itemId}/position`, { method: "PUT", body: JSON.stringify(body) }),
  discardReadProgress: (itemId: string) =>
    request<{ ok: true }>(`/api/read/${itemId}/position`, { method: "DELETE" }),
};

export { ApiError };
