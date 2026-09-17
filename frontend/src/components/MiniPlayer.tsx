import { useLocation, useNavigate } from "react-router-dom";
import { usePlayback } from "../lib/PlaybackContext";

/** The persistent "now playing" bar — follows you around the app while
 *  audio keeps going in the background (see PlaybackContext). Hidden on the
 *  full Player page itself (that page already shows everything this does),
 *  and whenever nothing's loaded. */
export default function MiniPlayer() {
  const playback = usePlayback();
  const navigate = useNavigate();
  const location = useLocation();

  if (!playback.itemId || !playback.book || !playback.session) return null;
  if (location.pathname === `/play/${playback.itemId}`) return null;

  const { book, session, positionS } = playback;
  const progressFrac = session.durationS > 0 ? positionS / session.durationS : 0;

  return (
    <div className="mini-player" role="complementary" aria-label="Now playing">
      <button className="mini-player-body" onClick={() => navigate(`/play/${playback.itemId}`)}>
        <img className="mini-player-cover" src={book.coverUrl} alt="" />
        <div className="mini-player-info">
          <span className="mini-player-title">{book.title}</span>
          {book.author && <span className="mini-player-author">{book.author}</span>}
        </div>
      </button>
      <button
        className="mini-player-play"
        aria-label={playback.isPlaying ? "Pause" : "Play"}
        onClick={(e) => {
          e.stopPropagation();
          playback.togglePlayPause();
        }}
      >
        {playback.isPlaying ? "❚❚" : "▶"}
      </button>
      <button
        className="mini-player-close"
        aria-label="Stop playing"
        onClick={(e) => {
          e.stopPropagation();
          playback.stop();
        }}
      >
        ×
      </button>
      <div className="mini-player-progress">
        <div className="mini-player-progress-fill" style={{ width: `${Math.round(progressFrac * 100)}%` }} />
      </div>
    </div>
  );
}
