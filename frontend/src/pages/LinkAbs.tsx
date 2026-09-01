import { FormEvent, useState } from "react";
import { api, ApiError, Me } from "../api/client";

export default function LinkAbs({ me, onLinked }: { me: Me; onLinked: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api.linkAbs(username, password);
      onLinked();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centerpane">
      <div className="card">
        <h1 className="brand">One more step</h1>
        <p className="sub">
          Signed in as <strong>{me.displayName || me.email}</strong>. Connect your Audiobookshelf
          account so audex-web can see your library — this only happens once.
        </p>
        <form onSubmit={onSubmit}>
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
            {busy ? "Connecting…" : "Connect"}
          </button>
          {error && <div className="error">{error}</div>}
        </form>
      </div>
    </div>
  );
}
