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

    def test_clients_for_leads_and_admins(self):
        # members can't manage clients
        self.assertEqual(self.member.req("GET", "/api/admin/customers")[0], 403)
        self.assertEqual(self.member.req("PUT", "/api/admin/customers", {"name": "X", "teams": ["automation"]})[0], 403)
        # a team lead sees only the teams they lead, and can add a client with its full name to their team
        s, r, _ = self.lead.req("GET", "/api/admin/customers")
        self.assertEqual((s, [t["id"] for t in r["teams"]]), (200, ["automation"]))
        s, r, _ = self.lead.req("PUT", "/api/admin/customers", {"name": "RHB", "fullName": "RHB Bank Bhd", "teams": ["automation"]})
        self.assertEqual(s, 200, r)
        rhb = next(c for c in self.lead.req("GET", "/api/admin/customers")[1]["customers"] if c["name"] == "RHB")
        self.assertEqual((rhb["fullName"], rhb["teams"]), ("RHB Bank Bhd", ["automation"]))
        # ...but not to a team they don't lead, and removing it from their team leaves other teams alone
        self.assertEqual(self.lead.req("PUT", "/api/admin/customers", {"name": "RHB", "teams": ["automation", "kpi-check"]})[0], 403)
        self.admin.req("PUT", "/api/admin/customers", {"name": "RHB", "teams": ["automation", "kpi-check"]})
        self.assertEqual(self.lead.req("PUT", "/api/admin/customers", {"name": "RHB", "teams": []})[0], 200)
        rhb = next(c for c in self.admin.req("GET", "/api/admin/customers")[1]["customers"] if c["name"] == "RHB")
        self.assertEqual(rhb["teams"], ["kpi-check"])
        self.admin.req("PUT", "/api/admin/customers", {"name": "RHB", "teams": []})

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

    def test_old_approval_history_is_folded(self):
        con = server.connect()
        t = con.execute("SELECT id FROM tasks WHERE team_id='kpi-check' AND no=1").fetchone()["id"]
        approver = server.connect().execute("SELECT id FROM users WHERE login='admin'").fetchone()["id"]
        member = server.connect().execute("SELECT id FROM users WHERE login='bob'").fetchone()["id"]
        with server.Tx(con):
            at = "2026-11-11T02:03:00+00:00"
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)", (t, at, approver, "target", '{"from": "2026-09-20", "to": "2026-11-13"}'))
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)", (t, at, approver, "approve", '{"request": "edit", "of": %d}' % member))
        hist = self.admin.req("GET", "/api/tasks/%d/history" % t)[1]["entries"]
        ap = next(e for e in hist if e["kind"] == "approve" and e["at"] == at)
        self.assertEqual(ap["changes"]["of"], "Bob")
        self.assertEqual(ap["changes"]["applied"], [["target", "2026-09-20", "2026-11-13"]])
        self.assertFalse(any(e["kind"] == "target" and e["at"] == at for e in hist))  # folded into the approval

    def test_request_history_shows_dates(self):
        # a member proposing a target on a task that has none: the request is in the history with its date
        T = test_api.TrackerTest
        s, r, _ = T.member.req("POST", "/api/teams/automation/tasks", {"category": "Tickets", "title": "New with target", "lead": ["bob"],
                                                                     "startDate": "2026-11-01"})
        t = next(x for x in T.member.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == r["id"])
        body = {k: t[k] for k in ("category", "title", "urgency", "percent", "progress", "lead", "support")}
        s, r2, _ = T.member.req("PUT", "/api/tasks/%d" % r["id"], dict(body, startDate="2026-11-01", target="2026-12-01"))
        self.assertEqual((s, r2["pending"]), (200, ["target"]))
        hist = T.member.req("GET", "/api/tasks/%d/history" % r["id"])[1]["entries"]
        req = next(e for e in hist if e["kind"] == "request")
        self.assertEqual((req["by"], req["changes"]["fields"]), ("Bob", [["target", None, "2026-12-01"]]))
        # entries saved by the earlier version held only the requested value
        con = server.connect()
        bob = con.execute("SELECT id FROM users WHERE login='bob'").fetchone()["id"]
        with server.Tx(con):
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)", (r["id"], "2026-11-10T15:08:00+00:00", bob, "create", "[]"))
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)", (r["id"], "2026-11-10T15:08:00+00:00", bob, "request", '{"target": "2026-11-13"}'))
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)", (r["id"], "2026-11-10T16:00:00+00:00", bob, "request", '{"target": "2026-11-20"}'))
        hist = T.member.req("GET", "/api/tasks/%d/history" % r["id"])[1]["entries"]
        old = {e["at"]: e["changes"]["fields"] for e in hist if e["kind"] == "request" and e["at"].startswith("2026-11-10")}
        self.assertEqual(old["2026-11-10T15:08:00+00:00"], [["target", None, "2026-11-13"]])  # asked with the new task: nothing before
        self.assertEqual(old["2026-11-10T16:00:00+00:00"], [["target", "?", "2026-11-20"]])   # earlier date wasn't saved


if __name__ == "__main__":
    unittest.main()
