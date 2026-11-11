"""Support engineers from outside the team (typed-in names).
Run: python -m unittest discover -s tests -v"""
import io
import os
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)


class OutsideSupportTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        cls.L, cls.M = T.lead, T.member

    def test_outside_support(self):
        body = {"category": "Project", "title": "Vendor job", "urgency": "Medium", "lead": ["alice"],
                "support": ["bob", "ext:  Joe from Vendor ", "ext:joe from vendor"], "startDate": "2026-09-01",
                "target": "2026-09-10", "actualDate": "2026-09-05"}
        s, r, _ = self.L.req("POST", "/api/teams/automation/tasks", body)
        self.assertEqual(s, 200, r)
        t = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == r["id"])
        self.assertEqual(t["support"], ["bob", "ext:Joe from Vendor"])  # trimmed, duplicates (any case) dropped
        # outside names are not team members: no KPI row, and a task with only outside support adds no team support
        kpi = self.L.req("GET", "/api/teams/automation/kpi?from=2026-09-01&to=2026-09-30")[1]
        self.assertNotIn("ext:Joe from Vendor", [row["key"] for row in kpi["rows"]])
        before = kpi["team"]["D"]
        body2 = dict(body, title="Vendor only", support=["ext:Joe from Vendor"])
        self.assertEqual(self.L.req("POST", "/api/teams/automation/tasks", body2)[0], 200)
        self.assertEqual(self.L.req("GET", "/api/teams/automation/kpi?from=2026-09-01&to=2026-09-30")[1]["team"]["D"], before)
        # someone picked as lead is dropped from support
        s, r, _ = self.L.req("POST", "/api/teams/automation/tasks", dict(body, title="Overlap", support=["alice", "bob"]))
        t = next(x for x in self.L.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == r["id"])
        self.assertEqual((t["lead"], t["support"]), (["alice"], ["bob"]))
        # leads must be team members; empty or unknown names are refused
        self.assertEqual(self.L.req("POST", "/api/teams/automation/tasks", dict(body, lead=["ext:Joe"]))[0], 400)
        self.assertEqual(self.L.req("POST", "/api/teams/automation/tasks", dict(body, support=["ext:   "]))[0], 400)
        self.assertEqual(self.L.req("POST", "/api/teams/automation/tasks", dict(body, support=["nobody"]))[0], 400)
        # the Excel export shows the plain name
        s, data, _ = self.L.req("GET", "/api/teams/automation/export.xlsx", raw=True)
        xml = zipfile.ZipFile(io.BytesIO(data)).read("xl/worksheets/sheet2.xml").decode()
        self.assertIn("Joe from Vendor", xml)
        self.assertNotIn("ext:Joe", xml)


if __name__ == "__main__":
    unittest.main()
