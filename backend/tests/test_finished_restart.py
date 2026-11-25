from app.api.play import finished_audio


def test_flag_counts():
    assert finished_audio({"isFinished": True}, 10, 3600)


def test_progress_995_counts_even_without_flag():
    assert finished_audio({"progress": 0.996}, 10, 3600)


def test_last_30_seconds_counts():
    assert finished_audio({}, 3580, 3600)


def test_mid_book_does_not():
    assert not finished_audio({"progress": 0.5}, 1800, 3600)
