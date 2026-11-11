"""Customers tab (administrators) and KPI rows for removed people.
Run: python -m unittest discover -s tests -v"""
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402
from test_logos import png, b64  # noqa: E402

KPI_TEAM = {
    "team": {"id": "kpi-check", "name": "KPI Check", "categories": ["Project"], "customers": ["Shared Co"]},
    "people": [{"key": "lena", "name": "Lena", "role": "lead"}, {"key": "gone", "name": "Gone Person", "role": "member"}],
    "tasks": [
        {"no": 1, "category": "Project", "title": "Lena job", "lead": ["lena"], "support": [], "target": "2026-03-10", "actualDate": "2026-03-05"},
        {"no": 2, "category": "Project", "title": "Gone job", "lead": ["gone"], "support": ["lena"], "target": "2026-03-10", "actualDate": "2026-03-15"},
    ]}


class CustomerAndKpiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not hasattr(test_api.TrackerTest, "admin"):
            test_api.TrackerTest.setUpClass()
        T = test_api.TrackerTest
        cls.admin, cls.lead, cls.member = T.admin, T.lead, T.member
        if not server.connect().execute("SELECT 1 FROM teams WHERE id='kpi-check'").fetchone():
            server.import_team(server.connect(), KPI_TEAM)

    def kpi(self):
        s, r, _ = self.admin.req("GET", "/api/teams/kpi-check/kpi?from=2026-01-01&to=2026-12-31")
        self.assertEqual(s, 200, r)
        return r

    def test_removed_person_not_in_kpi(self):
        self.assertIn("gone", [row["key"] for row in self.kpi()["rows"]])
        pid = next(p["id"] for p in self.admin.req("GET", "/api/teams/kpi-check")[1]["people"] if p["key"] == "gone")
        s, r, _ = self.admin.req("PUT", "/api/teams/kpi-check/people/%d" % pid, {"active": False})
        self.assertEqual(s, 200, r)
        r = self.kpi()
        self.assertEqual([row["key"] for row in r["rows"]], ["lena"])  # removed person has no row
        self.assertEqual(r["team"]["C"], 2)  # but the team still counts both completed tasks
        self.assertEqual(r["team"]["G"], 1)
        self.admin.req("PUT", "/api/teams/kpi-check/people/%d" % pid, {"active": True})

    def test_customers_admin_only(self):
        self.assertEqual(self.lead.req("GET", "/api/admin/customers")[0], 403)
        self.assertEqual(self.member.req("PUT", "/api/admin/customers", {"name": "X", "teams": ["automation"]})[0], 403)

    def test_assign_customer_to_teams(self):
        s, r, _ = self.admin.req("PUT", "/api/admin/customers", {"name": "Shared Co", "teams": ["automation", "kpi-check"]})
        self.assertEqual(s, 200, r)
        lists = self.admin.req("GET", "/api/admin/customers")[1]
        shared = next(c for c in lists["customers"] if c["name"] == "Shared Co")
        self.assertEqual(sorted(shared["teams"]), ["automation", "kpi-check"])
        self.assertIn("Shared Co", self.member.req("GET", "/api/teams/automation")[1]["customers"])
        # same name in another case keeps the existing spelling
        self.admin.req("PUT", "/api/admin/customers", {"name": "shared co", "teams": ["kpi-check"]})
        self.assertNotIn("Shared Co", self.member.req("GET", "/api/teams/automation")[1]["customers"])
        self.assertIn("Shared Co", self.admin.req("GET", "/api/teams/kpi-check")[1]["customers"])
        self.assertEqual(self.admin.req("PUT", "/api/admin/customers", {"name": "Y", "teams": ["no-such-team"]})[0], 400)

    def test_logo_follows_customer(self):
        self.admin.req("PUT", "/api/admin/customers", {"name": "Logo Co", "teams": ["kpi-check"]})
        s, r, _ = self.admin.req("PUT", "/api/admin/customers/logo", {"name": "Logo Co", "png": b64(png(32, 32))})
        self.assertEqual((s, r.get("teams")), (200, 1))
        # assigning the customer to another team copies its logo there
        self.admin.req("PUT", "/api/admin/customers", {"name": "Logo Co", "teams": ["kpi-check", "automation"]})
        self.assertIn("Logo Co", self.member.req("GET", "/api/teams/automation")[1]["logos"])
        # clearing it removes it everywhere; removing from all teams removes the customer
        self.admin.req("PUT", "/api/admin/customers/logo", {"name": "Logo Co", "png": ""})
        self.assertNotIn("Logo Co", self.member.req("GET", "/api/teams/automation")[1]["logos"])
        self.admin.req("PUT", "/api/admin/customers", {"name": "Logo Co", "teams": []})
        names = [c["name"] for c in self.admin.req("GET", "/api/admin/customers")[1]["customers"]]
        self.assertNotIn("Logo Co", names)


if __name__ == "__main__":
    unittest.main()
