import { FormEvent, useEffect, useState } from "react";
import { api, ApiError, Health } from "../api/client";

export default function Login() {
  const [health, setHealth] = useState<Health | null>(null);
  const [showFallback, setShowFallback] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  async function onFallbackSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.loginAbs(username, password);
      window.location.href = "/";
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const ssoEnabled = health?.ssoEnabled ?? false;

  return (
    <div className="centerpane">
      <div className="card">
        <h1 className="brand">
          Aud<em>ex</em>
        </h1>
        <p className="sub">Your library, player, and read-along — in the browser.</p>

        {ssoEnabled && (
          <a className="btn btn-primary" href="/api/auth/oidc/login">
            Continue with SSO
          </a>
        )}

        {!ssoEnabled && !showFallback && (
          <button className="btn btn-primary" onClick={() => setShowFallback(true)}>
            Sign in
          </button>
        )}

        {ssoEnabled && !showFallback && (
          <>
            <div className="divider">or</div>
            <button className="btn btn-secondary" onClick={() => setShowFallback(true)}>
              Use your Audiobookshelf account
            </button>
          </>
        )}

        {showFallback && (
          <form onSubmit={onFallbackSubmit} style={{ marginTop: ssoEnabled ? "1.2rem" : 0 }}>
            <label htmlFor="username">Audiobookshelf username</label>
            <input id="username" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus required />
            <label htmlFor="password">Password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button className="btn btn-primary" type="submit" disabled={busy} style={{ marginTop: "1.1rem" }}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            {error && <div className="error">{error}</div>}
          </form>
        )}

        {health && !health.absConfigured && (
          <div className="error" style={{ marginTop: "1.2rem" }}>
            This server has no Audiobookshelf URL configured yet — ask whoever runs it to
            set <code>ABS_URL</code>.
          </div>
        )}
      </div>
    </div>
  );
}
