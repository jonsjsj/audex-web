import { api, Me } from "../api/client";

export default function Home({ me, onSignedOut }: { me: Me; onSignedOut: () => void }) {
  async function signOut() {
    await api.logout();
    onSignedOut();
  }

  return (
    <div className="home">
      <h1>
        Aud<em style={{ color: "var(--accent)", fontStyle: "italic" }}>ex</em> Web
      </h1>
      <p className="sub">
        Signed in as <strong>{me.displayName || me.absUsername}</strong>.
      </p>
      <div className="row">
        <span className={`tag ${me.ssoLinked ? "ok" : ""}`}>{me.ssoLinked ? "SSO" : "Local sign-in"}</span>
        <span className={`tag ${me.absLinked ? "ok" : ""}`}>
          Audiobookshelf: {me.absLinked ? `connected (${me.absUsername})` : "not connected"}
        </span>
      </div>
      <p className="sub">
        Phase 0 — sign-in only. The library, player, and reader arrive in the next phases (see the
        plan).
      </p>
      <button className="btn btn-secondary" style={{ width: "auto", padding: "0.6rem 1.2rem" }} onClick={signOut}>
        Sign out
      </button>
    </div>
  );
}
