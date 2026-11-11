"""Deleting a team (administrators only).
Run: python -m unittest discover -s tests -v"""
import os
import sqlite3
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402
from test_logos import png, b64  # noqa: E402

DOOMED = {
    "team": {"id": "doomed", "name": "Doomed Team", "categories": ["Project"], "customers": ["Gone Co"]},
    "people": [{"key": "dora", "name": "Dora", "role": "lead"}],
    "tasks": [{"no": 1, "category": "Project", "title": "Old job", "lead": ["dora"], "support": [], "target": "2026-03-10", "actualDate": "2026-03-05"},
              {"no": 2, "category": "Project", "title": "Open job", "lead": ["dora"], "support": []}],
}


class DeleteTeamTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        cls.admin, cls.lead, cls.member = T.admin, T.lead, T.member

    def count(self, sql, *args):
        return server.connect().execute(sql, args).fetchone()[0]

    def test_delete_team(self):
        server.import_team(server.connect(), DOOMED)
        self.assertEqual(self.admin.req("PUT", "/api/admin/customers/logo", {"name": "Gone Co", "png": b64(png(16, 16))})[0], 200)
        tids = [r[0] for r in server.connect().execute("SELECT id FROM tasks WHERE team_id='doomed'")]
        self.assertEqual(len(tids), 2)
        users_before = self.count("SELECT COUNT(*) FROM users")
        other_tasks = self.count("SELECT COUNT(*) FROM tasks WHERE team_id='automation'")
        listed = next(t for t in self.admin.req("GET", "/api/admin/teams")[1]["teams"] if t["id"] == "doomed")
        self.assertEqual((listed["tasks"], listed["open"]), (2, 1))

        # only administrators, and only with the team's name typed
        self.assertEqual(self.lead.req("DELETE", "/api/teams/doomed", {"confirm": "Doomed Team"})[0], 403)
        self.assertEqual(self.member.req("DELETE", "/api/teams/automation", {"confirm": "Team Automation"})[0], 403)
        self.assertEqual(self.admin.req("DELETE", "/api/teams/doomed", {"confirm": "Doomed"})[0], 400)
        self.assertEqual(self.count("SELECT COUNT(*) FROM teams WHERE id='doomed'"), 1)

        s, r, _ = self.admin.req("DELETE", "/api/teams/doomed", {"confirm": "doomed team "})  # case and spaces don't matter
        self.assertEqual(s, 200, r)
        self.assertEqual((r["people"], r["tasks"]), (1, 2))
        # a backup was written first and still contains the team
        backup = os.path.join(os.path.dirname(os.path.abspath(server.DB_PATH)), "backups", os.path.basename(r["backup"]))
        self.assertTrue(os.path.isfile(backup))
        self.assertEqual(sqlite3.connect(backup).execute("SELECT COUNT(*) FROM tasks WHERE team_id='doomed'").fetchone()[0], 2)
        # everything of the team is gone; logins and other teams are untouched
        for sql in ("SELECT COUNT(*) FROM teams WHERE id='doomed'", "SELECT COUNT(*) FROM people WHERE team_id='doomed'",
                    "SELECT COUNT(*) FROM tasks WHERE team_id='doomed'", "SELECT COUNT(*) FROM change_requests WHERE team_id='doomed'",
                    "SELECT COUNT(*) FROM customer_logos WHERE team_id='doomed'"):
            self.assertEqual(self.count(sql), 0, sql)
        self.assertEqual(self.count("SELECT COUNT(*) FROM task_log WHERE task_id IN (%s)" % ",".join(map(str, tids))), 0)
        self.assertEqual(self.count("SELECT COUNT(*) FROM users"), users_before)
        self.assertEqual(self.count("SELECT COUNT(*) FROM tasks WHERE team_id='automation'"), other_tasks)
        self.assertEqual(self.admin.req("GET", "/api/teams/doomed")[0], 404)
        self.assertNotIn("doomed", [t["id"] for t in self.admin.req("GET", "/api/admin/teams")[1]["teams"]])


if __name__ == "__main__":
    unittest.main()
