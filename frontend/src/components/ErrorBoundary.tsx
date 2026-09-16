import { Component, ReactNode } from "react";
import { api } from "../api/client";

/** Catches a render crash anywhere below it and auto-files an anonymous
 *  report (backend/app/api/report.py de-dupes repeats of the same error on
 *  the same book within 24h, so this can't spam GitHub). No personal data
 *  leaves the browser: whatever itemId is embedded in the current URL is
 *  sent alongside the message so the SERVER can replace it with the one-way
 *  10-digit code before filing — the raw id/title never reaches GitHub. */
export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    const itemMatch = /\/(?:play|read|book)\/([^/?#]+)/.exec(window.location.pathname);
    api
      .submitReport({
        message: error.message || String(error),
        stack: [error.stack, info.componentStack].filter(Boolean).join("\n\n"),
        url: window.location.pathname,
        itemId: itemMatch?.[1],
        automatic: true,
      })
      .catch(() => {}); // reporting itself must never throw into the fallback UI
  }

  render() {
    if (this.state.error) {
      return (
        <div className="centerpane">
          <div className="card" style={{ textAlign: "center" }}>
            <h1 className="brand">
              Aud<em>ex</em>
            </h1>
            <p className="sub">Something went wrong. It's been reported automatically.</p>
            <button className="btn btn-primary" onClick={() => window.location.assign("/")}>
              Back to library
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
