import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, PodcastDetail, PodcastEpisode, PodcastFeedPreview, PodcastFound, PodcastShow, PodcastTarget } from "../api/client";
import { useShell } from "../components/Shell";
import { WithInfo } from "../components/InfoTip";
import { usePlayback, formatTime } from "../lib/PlaybackContext";
import { formatDay } from "../lib/dates";
import { useViewedCover } from "../lib/coverTint";

/** Podcasts (optional — Settings → Extras → Podcasts; Audex has the same). The shows are your Audiobookshelf podcast
 *  libraries; episodes play in the normal player and keep their own place. */
export default function Podcasts() {
  const navigate = useNavigate();
  const { search } = useShell();
  const [shows, setShows] = useState<PodcastShow[] | null>(null);
  const [targets, setTargets] = useState<PodcastTarget[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    api
      .podcasts()
      .then((r) => {
        setShows(r.shows);
        setTargets(r.targets);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load podcasts."));
  }
  useEffect(load, []);

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (!shows) return <p className="sub" style={{ padding: "1.5rem" }}>Loading podcasts…</p>;
  const q = search.trim().toLowerCase();
  const shown = q ? shows.filter((s) => `${s.title} ${s.author ?? ""}`.toLowerCase().includes(q)) : shows;

  return (
    <div className="lib">
      <header className="lib-head">
        <h2 className="group-page-title">Podcasts</h2>
        <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setAdding((v) => !v)} aria-expanded={adding}>
          {adding ? "Close" : "＋ Add a show"}
        </button>
      </header>
      {adding && (
        <AddPodcast
          targets={targets}
          onAdded={() => {
            setAdding(false);
            load();
          }}
        />
      )}
      {targets.length === 0 && shows.length === 0 ? (
        <p className="sub" style={{ padding: "0 1.5rem" }}>
          No podcast library on your Audiobookshelf server yet. Make one there (Libraries → Add → Podcasts) to subscribe
          to shows here.
        </p>
      ) : shown.length === 0 ? (
        <p className="sub" style={{ padding: "0 1.5rem" }}>{q ? `Nothing matches "${search}".` : "No shows yet."}</p>
      ) : (
        <div className="group-grid">
          {shown.map((s) => (
            <button key={s.id} className="group-tile" onClick={() => navigate(`/podcasts/${s.id}`)}>
              <div className="group-tile-poster podcast-poster">
                <img src={s.coverUrl} alt="" loading="lazy" />
              </div>
              <div className="group-tile-name">{s.title}</div>
              <div className="group-tile-count">
                {s.numEpisodes} episode{s.numEpisodes === 1 ? "" : "s"}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function episodeLabel(e: PodcastEpisode): string {
  const parts = [
    e.publishedAt ? formatDay(e.publishedAt) : null,
    e.season && e.episode ? `S${e.season} E${e.episode}` : e.episode ? `Episode ${e.episode}` : null,
    e.durationS ? formatTime(e.durationS) : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

export function PodcastShowPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const navigate = useNavigate();
  const playback = usePlayback();
  const [show, setShow] = useState<PodcastDetail | null>(null);
  useViewedCover(show?.coverUrl);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [hideFinished, setHideFinished] = useState(false);

  function load() {
    if (!itemId) return;
    api
      .podcast(itemId)
      .then(setShow)
      .catch((e) => setError(e instanceof Error ? e.message : "Couldn't load this podcast."));
  }
  useEffect(load, [itemId]);

  async function checkNew() {
    if (!itemId) return;
    setChecking(true);
    setNote(null);
    try {
      const r = await api.podcastCheckNew(itemId);
      setNote(r.newEpisodes > 0 ? `${r.newEpisodes} new episode${r.newEpisodes === 1 ? "" : "s"} — downloading` : "No new episodes.");
      if (r.newEpisodes > 0) window.setTimeout(load, 8000);
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Couldn't check for new episodes.");
    } finally {
      setChecking(false);
    }
  }

  if (error) return <div className="error" style={{ margin: "1.5rem" }}>{error}</div>;
  if (!show) return <p className="sub" style={{ padding: "1.5rem" }}>Loading…</p>;
  const episodes = hideFinished ? show.episodes.filter((e) => !e.isFinished) : show.episodes;
  const playingHere = (e: PodcastEpisode) => playback.itemId === itemId && playback.episodeId === e.id;

  return (
    <div className="podcast-page">
      <div className="podcast-head">
        <img className="podcast-head-cover" src={show.coverUrl} alt="" />
        <div className="podcast-head-text">
          <h1 className="book-detail-title">{show.title}</h1>
          {show.author && <p className="sub">{show.author}</p>}
          <div className="podcast-head-actions">
            <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => void checkNew()} disabled={checking}>
              {checking ? "Checking…" : "Check for new episodes"}
            </button>
            <label className="podcast-hide-finished">
              <input type="checkbox" checked={hideFinished} onChange={(e) => setHideFinished(e.target.checked)} /> Hide played
            </label>
          </div>
          {note && <p className="sub" role="status">{note}</p>}
          {show.description && (
            <WithInfo head={<span className="sub">About this show</span>} what="this show" noteClass="sub">
              {show.description}
            </WithInfo>
          )}
        </div>
      </div>
      {episodes.length === 0 ? (
        <p className="sub" style={{ padding: "1rem 1.5rem" }}>
          {show.episodes.length ? "Every episode is played." : "No episodes downloaded yet. Check for new episodes, or turn on auto-download in Audiobookshelf."}
        </p>
      ) : (
        <div className="podcast-episodes">
          {episodes.map((e) => (
            <button
              key={e.id}
              className={`podcast-episode${e.isFinished ? " played" : ""}${playingHere(e) ? " playing" : ""}`}
              onClick={() => navigate(`/play/${itemId}?episode=${encodeURIComponent(e.id)}`)}
            >
              <span className="podcast-episode-title">{e.title}</span>
              <span className="podcast-episode-meta">
                {episodeLabel(e)}
                {e.isFinished ? " · played" : e.currentTimeS > 5 ? ` · ${formatTime(Math.max(0, e.durationS - e.currentTimeS))} left` : ""}
              </span>
              {!e.isFinished && e.progress > 0 && (
                <span className="podcast-episode-bar" aria-hidden>
                  <span style={{ width: `${Math.round(e.progress * 100)}%` }} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Find a show by name or RSS address, preview it, and subscribe in one of your podcast libraries. */
function AddPodcast({ targets, onAdded }: { targets: PodcastTarget[]; onAdded: () => void }) {
  const usable = targets.filter((t) => t.canSubscribe);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PodcastFound[] | null>(null);
  const [picked, setPicked] = useState<PodcastFeedPreview | null>(null);
  const [target, setTarget] = useState(usable[0]?.id ?? "");
  const [autoDownload, setAutoDownload] = useState(true);

  const isUrl = /^https?:\/\//i.test(q.trim());

  async function find() {
    const term = q.trim();
    if (term.length < 2) return;
    setBusy(true);
    setError(null);
    setPicked(null);
    try {
      if (isUrl) {
        setResults(null);
        setPicked(await api.podcastFeed(term));
      } else {
        setResults((await api.podcastSearch(term)).results);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't search.");
    } finally {
      setBusy(false);
    }
  }

  async function preview(r: PodcastFound) {
    setBusy(true);
    setError(null);
    try {
      setPicked(await api.podcastFeed(r.feedUrl));
    } catch {
      // The feed couldn't be read just now: subscribe from what the search said.
      setPicked({ title: r.title, author: r.author, coverUrl: r.coverUrl, feedUrl: r.feedUrl, description: r.description, episodes: r.episodes, latest: [] });
    } finally {
      setBusy(false);
    }
  }

  async function subscribe() {
    if (!picked || !target) return;
    setBusy(true);
    setError(null);
    try {
      await api.podcastSubscribe({
        target,
        feedUrl: picked.feedUrl,
        title: picked.title,
        author: picked.author,
        description: picked.description,
        imageUrl: picked.coverUrl,
        autoDownload,
      });
      onAdded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't subscribe.");
      setBusy(false);
    }
  }

  return (
    <div className="podcast-add">
      <WithInfo head={<strong>Add a show</strong>} what="adding a show">
        Search by name, or paste the show's RSS address. Audiobookshelf adds it to your podcast library and, with
        auto-download on, fetches new episodes by itself.
      </WithInfo>
      {targets.length > 0 && usable.length === 0 && (
        <p className="error">Your Audiobookshelf account isn't allowed to add podcasts — it needs upload rights.</p>
      )}
      <div className="settings-codex-form">
        <input
          className="settings-input"
          placeholder="Show name or https://… RSS address"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void find()}
          aria-label="Find a podcast"
        />
        <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => void find()} disabled={busy || q.trim().length < 2}>
          {isUrl ? "Look" : "Search"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!picked && results && (
        <div className="podcast-results">
          {results.length === 0 && <p className="sub">Nothing found.</p>}
          {results.map((r) => (
            <button key={r.feedUrl} className="podcast-result" onClick={() => void preview(r)} disabled={busy}>
              {r.coverUrl ? <img src={r.coverUrl} alt="" loading="lazy" /> : <span className="podcast-result-blank" />}
              <span className="podcast-result-text">
                <span className="podcast-result-title">{r.title}</span>
                <span className="podcast-result-meta">{[r.author, r.episodes ? `${r.episodes} episodes` : null].filter(Boolean).join(" · ")}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      {picked && (
        <div className="podcast-preview">
          {picked.coverUrl && <img src={picked.coverUrl} alt="" />}
          <div>
            <div className="podcast-result-title">{picked.title}</div>
            <div className="podcast-result-meta">{[picked.author, picked.episodes ? `${picked.episodes} episodes` : null].filter(Boolean).join(" · ")}</div>
            {picked.latest.length > 0 && (
              <ul className="podcast-preview-latest">
                {picked.latest.map((e, i) => (
                  <li key={i}>
                    {e.title}
                    {e.publishedAt ? <span className="podcast-result-meta"> · {formatDay(e.publishedAt)}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            {usable.length > 1 && (
              <label className="podcast-add-row">
                Library{" "}
                <select className="reader-ap-select" value={target} onChange={(e) => setTarget(e.target.value)}>
                  {usable.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.serverName ? `${t.serverName} · ${t.name}` : t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="podcast-add-row">
              <input type="checkbox" checked={autoDownload} onChange={(e) => setAutoDownload(e.target.checked)} /> Download new
              episodes automatically
            </label>
            <div className="player-dialog-actions" style={{ justifyContent: "flex-start" }}>
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => void subscribe()} disabled={busy || !target}>
                {busy ? "Subscribing…" : "Subscribe"}
              </button>
              <button className="btn btn-secondary" style={{ width: "auto" }} onClick={() => setPicked(null)} disabled={busy}>
                Back
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
