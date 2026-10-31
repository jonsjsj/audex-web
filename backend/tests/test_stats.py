"""Reading stats: a report is validated and clamped before it is added (api/stats.py).
Run:  cd backend && python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from fastapi import HTTPException  # noqa: E402

from app.api import stats  # noqa: E402


def report(**kw):
    base = dict(itemId="li_abc", title="A Book", day="2026-10-31", pages=3, seconds=120.0)
    base.update(kw)
    return stats.ReadingReport(**base)


class CleanReport(unittest.TestCase):
    def test_a_normal_report_passes_through(self):
        self.assertEqual(stats.clean_report(report()), (3, 120.0))

    def test_negative_numbers_become_zero(self):
        self.assertEqual(stats.clean_report(report(pages=-4, seconds=-9.0)), (0, 0.0))

    def test_one_report_cannot_claim_a_day_of_reading(self):
        pages, seconds = stats.clean_report(report(pages=5000, seconds=90000.0))
        self.assertEqual(pages, stats.MAX_PAGES_PER_REPORT)
        self.assertEqual(seconds, stats.MAX_SECONDS_PER_REPORT)

    def test_a_bad_day_or_item_is_refused(self):
        for bad in (report(day="31.10.2026"), report(day=""), report(itemId="")):
            with self.assertRaises(HTTPException) as ctx:
                stats.clean_report(bad)
            self.assertEqual(ctx.exception.status_code, 400)


if __name__ == "__main__":
    unittest.main()
