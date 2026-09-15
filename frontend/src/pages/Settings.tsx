import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, Me } from "../api/client";

export default function Settings({ me, onChanged, onSignedOut }: { me: Me; onChanged: () => void; onSignedOut: () => void }) {
  const navigate = useNavigate();
  const [codexToken, setCodexToken] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);

  async function linkCodex() {
    if (!codexToken.trim()) return;
    setCodexBusy(true);
    setCodexError(null);
    try {
      await api.linkCodex(codexToken.trim());
      setCodexToken("");
      onChanged();
    } catch (e) {
      setCodexError(e instanceof Error ? e.message : "Couldn't link Codex.");
    } finally {
      setCodexBusy(false);
    }
  }

  async function unlinkCodex() {
    setCodexBusy(true);
    try {
      await api.unlinkCodex();
      onChanged();
    } finally {
      setCodexBusy(false);
    }
  }

  async function signOut() {
    await api.logout();
    onSignedOut();
  }

  return (
    <div className="settings">
      <header className="settings-head">
        <button className="settings-back" onClick={() => navigate("/")}>
          ← Library
        </button>
        <h1 className="settings-title">Settings</h1>
      </header>

      <section className="settings-section">
        <h2 className="settings-section-title">Account</h2>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">{me.displayName || me.absUsername || "Signed in"}</div>
            {me.email && <div className="settings-row-sub">{me.email}</div>}
          </div>
          <span className={`tag ${me.ssoLinked ? "ok" : ""}`}>{me.ssoLinked ? "SSO" : "Local sign-in"}</span>
        </div>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">Audiobookshelf</div>
            <div className="settings-row-sub">{me.absUsername}</div>
          </div>
          <span className="tag ok">Connected</span>
        </div>
        <button className="btn btn-secondary" style={{ width: "auto", marginTop: "0.8rem" }} onClick={signOut}>
          Sign out
        </button>
      </section>

      <section className="settings-section">
        <h2 className="settings-section-title">Codex sync</h2>
        <p className="settings-help">
          When you listen, audex-web sends your position to Codex right away (via its Audiobookshelf webhook) so it
          doesn't wait for Codex's periodic sync. Create the token in Codex → Settings → API Keys.
        </p>
        {!me.codexConfigured ? (
          <p className="settings-help">This server hasn't been set up with a Codex instance.</p>
        ) : me.codexLinked ? (
          <div className="settings-row">
            <div>
              <div className="settings-row-label">Codex</div>
              <div className="settings-row-sub">Linked</div>
            </div>
            <button className="btn btn-secondary" style={{ width: "auto" }} onClick={unlinkCodex} disabled={codexBusy}>
              Unlink
            </button>
          </div>
        ) : (
          <div className="settings-codex-form">
            <input
              className="settings-input"
              type="password"
              placeholder="Codex API token"
              value={codexToken}
              onChange={(e) => setCodexToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && linkCodex()}
            />
            <button className="btn btn-primary" style={{ width: "auto" }} onClick={linkCodex} disabled={codexBusy || !codexToken.trim()}>
              {codexBusy ? "Linking…" : "Link"}
            </button>
          </div>
        )}
        {codexError && <div className="error" style={{ marginTop: "0.6rem" }}>{codexError}</div>}
      </section>
    </div>
  );
}
