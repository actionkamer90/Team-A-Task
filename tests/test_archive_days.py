"""Each team lead chooses after how many days completed tasks move to the Archive.
Run: python -m unittest discover -s tests -v"""
import datetime as dt
import io
import os
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)


class ArchiveDaysTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        cls.L, cls.M = T.lead, T.member

    def set_days(self, v, cli=None):
        return (cli or self.L).req("PUT", "/api/teams/automation", {"archiveDays": v})

    def task(self, tid):
        return next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == tid)

    def test_team_lead_sets_archive_days(self):
        today = dt.date.today()
        done5 = (today - dt.timedelta(days=5)).isoformat()
        s, r, _ = self.L.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "Done five days ago", "lead": ["bob"],
                                                                    "target": done5, "startDate": done5, "actualDate": done5})
        self.assertEqual(s, 200, r)
        tid = r["id"]
        try:
            team = self.M.req("GET", "/api/teams/automation")[1]
            self.assertEqual((team["archiveDays"], team["archiveDaysDefault"]), (2, 2))
            self.assertTrue(self.task(tid)["archived"])               # default: 2 days
            self.assertFalse(self.task(tid)["canEdit"])               # archived -> lead only

            self.assertEqual(self.set_days(10)[0], 200)
            self.assertEqual(self.M.req("GET", "/api/teams/automation")[1]["archiveDays"], 10)
            t = self.task(tid)
            self.assertFalse(t["archived"])                           # back on the tracker
            self.assertTrue(t["canEdit"])                             # Bob leads it, so he can edit again
            s, data, _ = self.L.req("GET", "/api/teams/automation/export.xlsx", raw=True)
            daily = zipfile.ZipFile(io.BytesIO(data)).read("xl/worksheets/sheet1.xml").decode()
            self.assertIn("Done five days ago", daily)                # the Excel export follows the setting

            self.assertEqual(self.set_days(0)[0], 200)                # 0: archived as soon as it is completed
            s, r2, _ = self.L.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "Done today", "lead": ["bob"],
                                                                         "startDate": today.isoformat(), "actualDate": today.isoformat()})
            self.assertTrue(self.task(r2["id"])["archived"])

            # only the team lead (or an admin) can change it, and only to 0..90 whole days
            self.assertEqual(self.set_days(30, self.M)[0], 403)
            for bad in (91, -1, "abc", 2.5):
                self.assertEqual(self.set_days(bad)[0], 400, bad)
        finally:
            self.assertEqual(self.set_days(None)[0], 200)             # back to the server default
        self.assertEqual(self.M.req("GET", "/api/teams/automation")[1]["archiveDays"], 2)


if __name__ == "__main__":
    unittest.main()
