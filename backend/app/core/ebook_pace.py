"""The ebook keeps pace while you listen (Audex has the same).

As the audiobook plays, the work's ebook — the same Audiobookshelf item, or its paired one — has its saved % nudged
forward to the audio's %, so the two percentages on the book page track each other even if you never open the ebook.

- FORWARD ONLY: listening never rewinds where you've read; an ebook already at/ahead of the audio is left alone.
- Exactly the audio's fraction, never more. Codex's own cross-edition sync makes the editions agree on the FURTHEST
  fraction; were the ebook mirrored ahead of the audio (say through the read-along map), Codex would push the audio
  forward to match — moving your listening place. At the same fraction Codex sees nothing to do.
- Only the % (`ebookProgress`) is written. Audiobookshelf merges it onto the record, so the exact page locator is
  kept; the reader sees the % ran ahead of its page and opens at the listening place (through the map when there is
  one, else proportionally).
- Stops short of the end (`PACE_CAP`): finishing is decided by the audiobook being marked finished, not by a mirror.
- At most once a minute per book, and on close."""
import math
import time

PACE_CAP = 0.99
MIN_INTERVAL_S = 60.0
_last: dict[tuple, float] = {}


def pace_target(stored: float | None, audio_fraction: float) -> float | None:
    """The ebook fraction to write, or None to leave it."""
    if not (0.005 < audio_fraction):
        return None
    target = math.floor(min(audio_fraction, PACE_CAP) * 10000) / 10000  # never above the audio
    if (stored or 0.0) >= target - 0.0005:
        return None
    return target


def due(key: tuple, now: float | None = None, force: bool = False) -> bool:
    now = time.monotonic() if now is None else now
    if not force and now - _last.get(key, -1e9) < MIN_INTERVAL_S:
        return False
    _last[key] = now
    return True
