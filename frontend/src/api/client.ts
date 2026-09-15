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
};

export { ApiError };
