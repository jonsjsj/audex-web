import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api/client";
import { useShell } from "../components/Shell";

export default function Settings() {
  const navigate = useNavigate();
  const { me, onChanged, onSignedOut } = useShell();
  const [codexToken, setCodexToken] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportResult, setReportResult] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then((h) => setVersion(h.version)).catch(() => {});
    api.updateAvailable().then((r) => setUpdateAvailable(r.available)).catch(() => {});
    api.reportAvailable().then((r) => setReportAvailable(r.available)).catch(() => {});
  }, []);

  async function submitReport() {
    if (!reportNote.trim() || reportBusy) return;
    setReportBusy(true);
    setReportError(null);
    try {
      await api.submitReport({
        message: "User-submitted report from Settings",
        note: reportNote.trim(),
        url: window.location.pathname,
        automatic: false,
      });
      setReportResult("Sent — thanks. It's filed as a GitHub issue, no personal data included.");
      setReportNote("");
      setReportOpen(false);
    } catch (e) {
      setReportError(e instanceof Error ? e.message : "Couldn't send the report.");
    } finally {
      setReportBusy(false);
    }
  }

  // Rebuilds itself from the freshly-pulled GHCR image (see
  // backend/app/api/admin.py) — this page WILL go offline for a few seconds
  // partway through, that's expected, not a failure.
  async function triggerUpdate() {
    setUpdating(true);
    setUpdateError(null);
    try {
      const res = await api.triggerUpdate();
      setUpdateMessage(res.message);
    } catch (e) {
      setUpdateError(e instanceof Error ? e.message : "Couldn't start the update.");
      setUpdating(false);
    }
  }

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

      <section className="settings-section">
        <h2 className="settings-section-title">About</h2>
        <div className="settings-row">
          <div>
            <div className="settings-row-label">audex-web</div>
            <div className="settings-row-sub">
              {version ? `v${version}` : "…"} ·{" "}
              <a href="/CHANGELOG.md" target="_blank" rel="noreferrer">
                Changelog
              </a>
            </div>
          </div>
          {updateAvailable ? (
            <button className="btn btn-secondary" style={{ width: "auto" }} onClick={triggerUpdate} disabled={updating}>
              {updating ? "Updating…" : "Update now"}
            </button>
          ) : (
            <span className="settings-row-sub">Self-update not set up on this deploy</span>
          )}
        </div>
        {updateMessage && <p className="settings-help">{updateMessage}</p>}
        {updateError && <div className="error" style={{ marginTop: "0.6rem" }}>{updateError}</div>}
      </section>

      {reportAvailable && (
        <section className="settings-section">
          <h2 className="settings-section-title">Report a problem</h2>
          <p className="settings-help">
            Send a note about something that's wrong or looks off. It's filed as a GitHub issue — no book title,
            author, or account info goes with it; anything book-related is replaced with a one-way code before it
            ever leaves this server, so a repeated report about the same book can still be noticed without anyone
            being able to tell what book it is.
          </p>
          <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setReportOpen(true)}>
            Report a problem
          </button>
          {reportResult && <p className="settings-help" style={{ color: "var(--accent)" }}>{reportResult}</p>}
        </section>
      )}

      {reportOpen && (
        <div className="player-dialog-backdrop" onClick={() => setReportOpen(false)}>
          <div className="player-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Report a problem</h3>
            <textarea
              className="settings-input"
              style={{ minHeight: "6rem", resize: "vertical" }}
              placeholder="What happened?"
              value={reportNote}
              onChange={(e) => setReportNote(e.target.value)}
              autoFocus
            />
            {reportError && <div className="error" style={{ marginTop: "0.6rem" }}>{reportError}</div>}
            <div className="player-dialog-actions">
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setReportOpen(false)}>
                Cancel
              </button>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={submitReport} disabled={reportBusy || !reportNote.trim()}>
                {reportBusy ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
