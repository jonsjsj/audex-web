"""Don't let a device that has been asleep overwrite a place another device moved on.

Every write to Audiobookshelf says which server position the writer last knew (`known…`: what it loaded when it
opened the book, or what it last saved itself). Nobody but another device changes the stored position in between,
so if the stored value is no longer that one, someone else saved after this device last looked — a newer place —
and an older tab or phone must pick it up rather than replace it. A write with no `known…` is always allowed
(a client that doesn't send it behaves as before)."""
from __future__ import annotations

# Audio: seconds. Our own saves land within one sync interval (15 s) of what we last sent; 30 s of slack covers
# Audiobookshelf's rounding and the odd late request.
AUDIO_TOLERANCE_S = 30.0
# Reading: fraction of the book (1 %). A page turn is a fraction of a percent, and our own saves are stored as sent.
READ_TOLERANCE = 0.01


def moved_elsewhere(known: float | None, stored: float | None, tolerance: float) -> bool:
    """True when the stored position is not the one the writer last knew, i.e. another device saved since."""
    if known is None or stored is None:
        return False
    return abs(stored - known) > tolerance
