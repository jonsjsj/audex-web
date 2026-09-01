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
};

export { ApiError };
