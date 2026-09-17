import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AbsServerInfo, api, UpdateCheck } from "../api/client";
import { useShell } from "../components/Shell";

interface ChangelogEntry {
  version: string;
  date: string | null; // ISO "YYYY-MM-DD" from the "## [x.y.z] - DATE" header, if present
  body: string;
}

/** Parses a Keep-a-Changelog file into its release sections. Client-side so
 *  the About panel can show this build's own release date + notes and the
 *  full history, from the same /CHANGELOG.md the app already ships. */
function parseChangelog(md: string): ChangelogEntry[] {
  return md
    .split(/^## \[/m)
    .slice(1)
    .map((section) => {
      const nl = section.indexOf("\n");
      const header = nl === -1 ? section : section.slice(0, nl);
      const body = nl === -1 ? "" : section.slice(nl + 1).trim();
      const vEnd = header.indexOf("]");
      const version = (vEnd === -1 ? header : header.slice(0, vEnd)).trim();
      const date = header.slice(vEnd + 1).match(/\d{4}-\d{2}-\d{2}/)?.[0] ?? null;
      return { version, date, body };
    });
}

export default function Settings() {
  const navigate = useNavigate();
  const { me, onChanged, onSignedOut, refreshLibraries } = useShell();
  const [servers, setServers] = useState<AbsServerInfo[] | null>(null);
  const [addServerOpen, setAddServerOpen] = useState(false);
  const [serverForm, setServerForm] = useState({ url: "", username: "", password: "", name: "" });
  const [serverBusy, setServerBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [codexToken, setCodexToken] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexInfoOpen, setCodexInfoOpen] = useState(false);
  const [updateCapable, setUpdateCapable] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheck | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [changelog, setChangelog] = useState<ChangelogEntry[] | null>(null);
  const [changelogOpen, setChangelogOpen] = useState(false);
  const [reportAvailable, setReportAvailable] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [reportNote, setReportNote] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportResult, setReportResult] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  useEffect(() => {
    api.updateAvailable().then((r) => setUpdateCapable(r.available)).catch(() => {});
    api.reportAvailable().then((r) => setReportAvailable(r.available)).catch(() => {});
    api.absServers().then(setServers).catch(() => {});
    // The shipped changelog — powers the "last updated" date, this build's
    // notes, and the expand-to-full view. Best-effort: a failed fetch just
    // hides those extras, the version number still shows.
    api.changelog().then((md) => setChangelog(parseChangelog(md))).catch(() => {});
  }, []);

  // Separate from the capability check above — this is "is there an actual
  // newer release," which is what decides whether the button can be clicked
  // at all, not just whether self-update is wired up on this deploy.
  useEffect(() => {
    setCheckingUpdate(true);
    api.checkUpdate().then(setUpdateCheck).catch(() => {}).finally(() => setCheckingUpdate(false));
  }, []);

  const currentVersion = updateCheck?.currentVersion ?? null;
  const currentEntry =
    changelog?.find((e) => e.version === currentVersion) ?? changelog?.[0] ?? null;

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

  async function addServer() {
    if (serverBusy || !serverForm.url.trim() || !serverForm.username.trim() || !serverForm.password) return;
    setServerBusy(true);
    setServerError(null);
    try {
      await api.addAbsServer({
        url: serverForm.url.trim(),
        username: serverForm.username.trim(),
        password: serverForm.password,
        name: serverForm.name.trim() || undefined,
      });
      setServerForm({ url: "", username: "", password: "", name: "" });
      setAddServerOpen(false);
      setServers(await api.absServers().catch(() => servers));
      refreshLibraries(); // so the new server's libraries show in the picker right away
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Couldn't connect that server.");
    } finally {
      setServerBusy(false);
    }
  }

  async function removeServer(key: string) {
    setServerBusy(true);
    try {
      await api.removeAbsServer(key);
      setServers(await api.absServers().catch(() => servers));
      refreshLibraries();
    } finally {
      setServerBusy(false);
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
        <button className="btn btn-secondary" style={{ width: "auto", marginTop: "0.8rem" }} onClick={signOut}>
          Sign out
        </button>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">Audiobookshelf servers</h2>
        </div>
        <p className="settings-help">
          Connect more than one Audiobookshelf server to see every library in one place — the Library, Series,
          Authors and Narrators views combine them, and each server keeps its own sign-in.
        </p>
        {(servers ?? []).map((s) => (
          <div className="settings-row" key={s.key || "primary"}>
            <div>
              <div className="settings-row-label">{s.name}</div>
              <div className="settings-row-sub">
                {s.url}
                {s.username ? ` · ${s.username}` : ""}
              </div>
            </div>
            {s.primary ? (
              <span className="tag ok">Primary</span>
            ) : (
              <button
                className="btn btn-secondary"
                style={{ width: "auto" }}
                onClick={() => removeServer(s.key)}
                disabled={serverBusy}
              >
                Remove
              </button>
            )}
          </div>
        ))}
        {addServerOpen ? (
          <div className="settings-server-form">
            <input
              className="settings-input"
              placeholder="Server URL (https://abs.example.com)"
              value={serverForm.url}
              onChange={(e) => setServerForm((f) => ({ ...f, url: e.target.value }))}
            />
            <input
              className="settings-input"
              placeholder="Name (optional)"
              value={serverForm.name}
              onChange={(e) => setServerForm((f) => ({ ...f, name: e.target.value }))}
            />
            <input
              className="settings-input"
              placeholder="Username"
              value={serverForm.username}
              onChange={(e) => setServerForm((f) => ({ ...f, username: e.target.value }))}
            />
            <input
              className="settings-input"
              type="password"
              placeholder="Password"
              value={serverForm.password}
              onChange={(e) => setServerForm((f) => ({ ...f, password: e.target.value }))}
              onKeyDown={(e) => e.key === "Enter" && addServer()}
            />
            {serverError && <div className="error">{serverError}</div>}
            <div className="player-dialog-actions">
              <button
                className="btn btn-secondary"
                style={{ width: "auto" }}
                onClick={() => {
                  setAddServerOpen(false);
                  setServerError(null);
                }}
              >
                Cancel
              </button>
              <button
                className="btn btn-primary"
                style={{ width: "auto" }}
                onClick={addServer}
                disabled={serverBusy || !serverForm.url.trim() || !serverForm.username.trim() || !serverForm.password}
              >
                {serverBusy ? "Connecting…" : "Connect server"}
              </button>
            </div>
          </div>
        ) : (
          <button className="btn btn-secondary" style={{ width: "auto", marginTop: "0.4rem" }} onClick={() => setAddServerOpen(true)}>
            Add a server
          </button>
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h2 className="settings-section-title">Codex sync</h2>
          <button
            className="settings-info-toggle"
            onClick={() => setCodexInfoOpen((v) => !v)}
            aria-expanded={codexInfoOpen}
            aria-label="What is Codex sync?"
            title="What is Codex sync?"
          >
            ⓘ
          </button>
        </div>
        {/* The wordy explanation is tucked behind the ⓘ — the default view is
            just a status, per the "just a connected" ask. */}
        {codexInfoOpen && (
          <p className="settings-help">
            When you listen, audex-web sends your position to Codex right away (via its Audiobookshelf webhook) so it
            doesn't wait for Codex's periodic sync. Create the token in Codex → Settings → API Keys.
          </p>
        )}
        {!me.codexConfigured ? (
          <p className="settings-help">This server hasn't been set up with a Codex instance.</p>
        ) : me.codexLinked ? (
          <div className="settings-row">
            <div>
              <div className="settings-row-label">Codex</div>
            </div>
            <span className="tag ok">Connected</span>
            <button className="btn btn-secondary" style={{ width: "auto", marginLeft: "0.6rem" }} onClick={unlinkCodex} disabled={codexBusy}>
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
              {currentVersion ? `v${currentVersion}` : "…"}
              {currentEntry?.date && ` · Updated ${currentEntry.date}`}
            </div>
          </div>
          {!updateCapable ? (
            <span className="settings-row-sub">Self-update not set up on this deploy</span>
          ) : checkingUpdate ? (
            <span className="settings-row-sub">Checking…</span>
          ) : updateCheck?.updateAvailable ? (
            <button className="btn btn-secondary" style={{ width: "auto" }} onClick={triggerUpdate} disabled={updating}>
              {updating ? "Updating…" : `Update to v${updateCheck.latestVersion}`}
            </button>
          ) : (
            <span className="settings-row-sub">Up to date</span>
          )}
        </div>

        {/* This build's own notes. */}
        {currentEntry?.body && (
          <div className="settings-changelog-block">
            <div className="settings-changelog-ver">What's in v{currentEntry.version}</div>
            <p className="settings-help settings-changelog-body">{currentEntry.body}</p>
          </div>
        )}

        {/* The next release waiting to be installed — name + notes, right here. */}
        {updateCheck?.updateAvailable && updateCheck.changelogEntry && (
          <div className="settings-changelog-block settings-changelog-next">
            <div className="settings-changelog-ver">Next: v{updateCheck.latestVersion}</div>
            <p className="settings-help settings-changelog-body">{updateCheck.changelogEntry}</p>
          </div>
        )}

        {changelog && changelog.length > 0 && (
          <>
            <button className="settings-link-btn" onClick={() => setChangelogOpen((v) => !v)} aria-expanded={changelogOpen}>
              {changelogOpen ? "Hide full changelog" : "Expand to full changelog"}
            </button>
            {changelogOpen && (
              <div className="settings-changelog-full">
                {changelog.map((e) => (
                  <div key={e.version} className="settings-changelog-block">
                    <div className="settings-changelog-ver">
                      v{e.version}
                      {e.date && <span className="settings-changelog-date"> · {e.date}</span>}
                    </div>
                    <p className="settings-help settings-changelog-body">{e.body}</p>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

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
