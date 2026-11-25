from app.core import ebook_pace


def test_moves_the_ebook_forward_to_the_audio():
    assert ebook_pace.pace_target(0.10, 0.4237) == 0.4237


def test_never_rewinds_reading_ahead_of_the_audio():
    assert ebook_pace.pace_target(0.60, 0.40) is None
    assert ebook_pace.pace_target(0.40, 0.4003) is None  # already there


def test_never_above_the_audio_so_codex_has_nothing_to_push():
    t = ebook_pace.pace_target(0.0, 0.123456)
    assert t <= 0.123456 and 0.123456 - t < 0.001


def test_stops_short_of_the_end_and_ignores_the_very_start():
    assert ebook_pace.pace_target(0.0, 0.999) == ebook_pace.PACE_CAP
    assert ebook_pace.pace_target(0.0, 0.003) is None
    assert ebook_pace.pace_target(None, 0.5) == 0.5


def test_throttled_per_book():
    key = ("u", "book-x")
    assert ebook_pace.due(key, now=1000.0)
    assert not ebook_pace.due(key, now=1030.0)
    assert ebook_pace.due(key, now=1030.0, force=True)
    assert ebook_pace.due(key, now=1100.0)
