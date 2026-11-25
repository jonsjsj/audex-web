from app.api import podcasts
from app.api.play import _progress_id


def test_plain_strips_html_and_trims():
    assert podcasts.plain("<p>Hello &amp; <b>welcome</b></p>") == "Hello & welcome"
    assert podcasts.plain(None) is None
    long = podcasts.plain("word " * 400, limit=50)
    assert len(long) <= 50 and long.endswith("…")


def test_folder_name_has_no_path_tricks():
    assert podcasts.safe_folder_name("A/B: C?") == "A_B_ C_"
    assert podcasts.safe_folder_name("../..") == "_"
    assert "/" not in podcasts.safe_folder_name("../../etc")
    assert podcasts.safe_folder_name("   ") == "Podcast"


def test_who_may_subscribe():
    assert podcasts.can_upload({"type": "admin"})
    assert podcasts.can_upload({"type": "user", "permissions": {"upload": True}})
    assert not podcasts.can_upload({"type": "user", "permissions": {"upload": False}})
    assert not podcasts.can_upload(None)


def test_episode_progress_lives_under_item_and_episode():
    assert _progress_id("li_1", None) == "li_1"
    assert _progress_id("li_1", "ep_9") == "li_1/ep_9"


def test_episode_row_uses_audio_file_duration_and_progress():
    row = podcasts._episode({"id": "e", "title": "T", "audioFile": {"duration": 61.5}, "publishedAt": 5},
                            {"currentTime": 30, "progress": 0.49, "isFinished": False})
    assert row["durationS"] == 61.5 and row["currentTimeS"] == 30 and row["progress"] == 0.49
