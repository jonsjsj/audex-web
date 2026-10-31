import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import {
  Bucket,
  byBook,
  DayTotal,
  formatDuration,
  Grain,
  history,
  localDay,
  perDay,
  periods,
  records,
  StatsData,
} from "../lib/stats";

type View = "overview" | "history" | "records";
type HistoryKind = Grain | "book";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const SHORT_WEEKDAYS = ["M", "T", "W", "T", "F", "S", "S"];

function Total({ label, t }: { label: string; t: DayTotal }) {
  return (
    <div className="stats-card">
      <div className="stats-card-label">{label}</div>
      <div className="stats-card-row">
        <span className="stats-card-num">{formatDuration(t.listenS)}</span>
        <span className="stats-card-unit">listened</span>
      </div>
      <div className="stats-card-row">
        <span className="stats-card-num">{t.pages.toLocaleString()}</span>
        <span className="stats-card-unit">pages{t.readS >= 60 ? ` · ${formatDuration(t.readS)} reading` : ""}</span>
      </div>

      <details className="stats-about">
        <summary>About these numbers</summary>
        <p>
          Listening comes from Audiobookshelf, so it includes every device since the start. Pages are counted by this reader as
          you turn them one at a time, from the first time you read here; jumping, going back and flicking past pages don't count.
          A day counts towards a streak with a minute of listening or a page read.
        </p>
      </details>
    </div>
  );
}

/** A row with a bar that shows how it compares with the biggest row on screen. */
function BarRow({ label, listenS, pages, maxListen, maxPages, sub }: { label: string; listenS: number; pages: number; maxListen: number; maxPages: number; sub?: string }) {
  return (
    <div className="stats-row">
      <div className="stats-row-head">
        <span className="stats-row-label">{label}</span>
        <span className="stats-row-values">
          {listenS > 0 && <span>{formatDuration(listenS)}</span>}
          {pages > 0 && <span>{pages.toLocaleString()} pages</span>}
        </span>
      </div>
      {sub && <div className="stats-row-sub">{sub}</div>}
      <div className="stats-bars" aria-hidden>
        <div className="stats-bar stats-bar-listen" style={{ width: `${maxListen > 0 ? (listenS / maxListen) * 100 : 0}%` }} />
        <div className="stats-bar stats-bar-read" style={{ width: `${maxPages > 0 ? (pages / maxPages) * 100 : 0}%` }} />
      </div>
    </div>
  );
}

export default function Stats() {
  const [data, setData] = useState<StatsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("overview");
  const [kind, setKind] = useState<HistoryKind>("day");

  useEffect(() => {
    let live = true;
    api.stats().then((d) => live && setData(d)).catch((e) => live && setError(e instanceof Error ? e.message : "Couldn't load your stats."));
    return () => { live = false; };
  }, []);

  const today = localDay();
  const days = useMemo(() => (data ? perDay(data) : null), [data]);
  const totals = useMemo(() => (days ? periods(days, today) : null), [days, today]);
  const rec = useMemo(() => (days ? records(days, today) : null), [days, today]);
  const buckets: Bucket[] = useMemo(() => (days && kind !== "book" ? history(days, kind).slice(0, 60) : []), [days, kind]);
  const books = useMemo(() => (data && kind === "book" ? byBook(data).slice(0, 80) : []), [data, kind]);

  if (error) return <p className="sub" style={{ padding: "2rem" }}>{error}</p>;
  if (!data || !days || !totals || !rec) return <p className="sub" style={{ padding: "2rem" }}>Loading…</p>;

  const maxListen = Math.max(1, ...(kind === "book" ? books.map((b) => b.listenS) : buckets.map((b) => b.listenS)));
  const maxPages = Math.max(1, ...(kind === "book" ? books.map((b) => b.pages) : buckets.map((b) => b.pages)));

  return (
    <div className="stats-wrap">
      <h1 className="settings-title" style={{ padding: "1.2rem 1.5rem 0" }}>Stats</h1>
      <div className="player-tabs" style={{ padding: "0 1.5rem" }}>
        {(["overview", "history", "records"] as View[]).map((v) => (
          <button key={v} className={`player-tab ${view === v ? "active" : ""}`} onClick={() => setView(v)}>
            {v === "overview" ? "Overview" : v === "history" ? "History" : "Records"}
          </button>
        ))}
      </div>

      <div className="stats-body">
        {!data.listening && <p className="stats-note">Listening history unavailable right now.</p>}

        {view === "overview" && (
          <>
            <div className="stats-cards">
              <Total label="Today" t={totals.today} />
              <Total label="This week" t={totals.week} />
              <Total label="This month" t={totals.month} />
              <Total label="All time" t={totals.all} />
            </div>
          </>
        )}

        {view === "history" && (
          <>
            <div className="reader-seg stats-seg" role="group" aria-label="Group by">
              {(["day", "week", "month", "year", "book"] as HistoryKind[]).map((k) => (
                <button key={k} className={`reader-font-btn ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                  {k[0].toUpperCase() + k.slice(1)}
                </button>
              ))}
            </div>
            <div className="stats-list">
              {kind !== "book" &&
                buckets.map((b) => (
                  <BarRow key={b.key} label={b.label} listenS={b.listenS} pages={b.pages} maxListen={maxListen} maxPages={maxPages} sub={b.readS >= 60 ? `${formatDuration(b.readS)} reading` : undefined} />
                ))}
              {kind === "book" &&
                books.map((b) => (
                  <BarRow key={b.itemId + b.title} label={b.title} listenS={b.listenS} pages={b.pages} maxListen={maxListen} maxPages={maxPages} sub={b.readS >= 60 ? `${formatDuration(b.readS)} reading` : undefined} />
                ))}
              {(kind === "book" ? books.length === 0 : buckets.length === 0) && <p className="stats-note">Nothing recorded yet.</p>}
            </div>
          </>
        )}

        {view === "records" && (
          <div className="stats-records">
            <section>
              <h2 className="settings-section-title">Streaks</h2>
              <p className="stats-line"><b>{rec.currentStreak}</b> day{rec.currentStreak === 1 ? "" : "s"} in a row now · longest <b>{rec.longestStreak}</b></p>
            </section>

            <section>
              <h2 className="settings-section-title">Best listening</h2>
              {(["week", "month", "year"] as const).map((g) => (
                <p key={g} className="stats-line">Best {g}: {rec.bestListen[g] ? <><b>{formatDuration(rec.bestListen[g]!.value)}</b> · {rec.bestListen[g]!.label}</> : "—"}</p>
              ))}
            </section>

            <section>
              <h2 className="settings-section-title">Best reading</h2>
              {(["week", "month", "year"] as const).map((g) => (
                <p key={g} className="stats-line">Best {g}: {rec.bestPages[g] ? <><b>{rec.bestPages[g]!.value.toLocaleString()} pages</b> · {rec.bestPages[g]!.label}</> : "—"}</p>
              ))}
            </section>

            <section>
              <h2 className="settings-section-title">Your days</h2>
              {rec.busiestDay && (
                <p className="stats-line">Busiest day: <b>{rec.busiestDay.day}</b> · {formatDuration(rec.busiestDay.listenS)} listened, {rec.busiestDay.pages} pages</p>
              )}
              {rec.busiestWeekday !== null && <p className="stats-line">Busiest weekday: <b>{WEEKDAYS[rec.busiestWeekday]}</b></p>}
              <div className="stats-weekdays" role="img" aria-label="Average per weekday">
                {rec.weekdayAvg.map((a, i) => {
                  const score = a.listenS + a.pages * 120;
                  const top = Math.max(1, ...rec.weekdayAvg.map((x) => x.listenS + x.pages * 120));
                  return (
                    <div key={i} className="stats-weekday">
                      <div className="stats-weekday-bar" style={{ height: `${(score / top) * 100}%` }} title={`${WEEKDAYS[i]}: ${formatDuration(a.listenS)}, ${a.pages.toFixed(1)} pages on average`} />
                      <span>{SHORT_WEEKDAYS[i]}</span>
                    </div>
                  );
                })}
              </div>
              {rec.perActiveDay.days > 0 && (
                <p className="stats-line">On a day you do it ({rec.perActiveDay.days} so far): <b>{formatDuration(rec.perActiveDay.listenS)}</b> listened, <b>{Math.round(rec.perActiveDay.pages)}</b> pages</p>
              )}
            </section>

            <section>
              <h2 className="settings-section-title">Pace</h2>
              <p className="stats-line">Reading pace: {rec.pace.all !== null ? <><b>{Math.round(rec.pace.all)}</b> pages/hour</> : "—"}{rec.pace.last30 !== null && <> · last 30 days <b>{Math.round(rec.pace.last30)}</b></>}</p>
              {rec.split && (
                <p className="stats-line">Your time: <b>{Math.round(rec.split.listen * 100)}%</b> listening · <b>{Math.round(rec.split.read * 100)}%</b> reading</p>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
