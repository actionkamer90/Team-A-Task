"""Projects: Project Manager role, plans scheduled in working days, At Risk, links from daily tasks, Excel timeline export.
Run: python -m unittest discover -s tests -v"""
import datetime as dt
import io
import os
import re
import sys
import unittest
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402


class ProjectTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        cls.A, cls.L, cls.M = T.admin, T.lead, T.member  # admin, Alice (lead), Bob (member)
        cls.bob_id = next(p["id"] for p in cls.A.req("GET", "/api/teams/automation")[1]["people"] if p["key"] == "bob")
        cls.alice_id = next(p["id"] for p in cls.A.req("GET", "/api/teams/automation")[1]["people"] if p["key"] == "alice")
        cls.A.req("PUT", "/api/admin/customers", {"name": "RHB", "fullName": "RHB Bank Bhd", "teams": ["automation"]})

    def set_role(self, role):
        s, r, _ = self.L.req("PUT", "/api/teams/automation/people/%d" % self.bob_id, {"role": role})
        self.assertEqual(s, 200, r)

    def create(self, cli=None, **kw):
        body = {"name": "Zena Upgrade", "client": "RHB", "startDate": "2026-10-05", "status": "Active", "template": "implementation"}
        body.update(kw)
        s, r, _ = (cli or self.L).req("POST", "/api/teams/automation/projects", body)
        return s, r

    def detail(self, pid, cli=None):
        return (cli or self.L).req("GET", "/api/projects/%d" % pid)[1]

    def test_workdays_follow_excel(self):
        d = server.workday_dates("2026-10-05", {"2026-10-26"}, 48)  # start is a Monday; 26/10 is a public holiday
        self.assertEqual(d[1].isoformat(), "2026-10-05")              # day 1 = start date
        self.assertEqual(d[6].isoformat(), "2026-10-12")              # weekend skipped
        self.assertEqual(d[16].isoformat(), "2026-10-27")             # holiday skipped
        self.assertEqual(d[48].isoformat(), "2026-12-10")

    def test_pm_role_and_permissions(self):
        self.assertEqual(self.create(self.M)[0], 403)                 # a member can't create projects
        self.set_role("pm")
        try:
            team = self.M.req("GET", "/api/teams/automation")[1]
            self.assertTrue(team["isPm"] and team["canCreateProjects"])
            self.assertEqual(next(p["role"] for p in team["people"] if p["key"] == "bob"), "pm")
            s, r = self.create(self.M, name="Bob's project")
            self.assertEqual(s, 200, r)
            mine = self.detail(r["id"], self.M)
            self.assertEqual((mine["pmName"], mine["canEdit"], mine["canDelete"]), ("Bob", True, False))  # the PM manages it
            # a project managed by someone else: the PM can view but not change it
            s, other = self.create(pmPersonId=self.alice_id, name="Alice's project")
            self.assertFalse(self.detail(other["id"], self.M)["canEdit"])
            self.assertEqual(self.M.req("PUT", "/api/projects/%d" % other["id"], {"name": "x"})[0], 403)
            self.assertEqual(self.M.req("DELETE", "/api/projects/%d" % r["id"])[0], 403)
            self.assertEqual(self.L.req("DELETE", "/api/projects/%d" % r["id"])[0], 200)  # the lead can delete
            self.L.req("DELETE", "/api/projects/%d" % other["id"])
        finally:
            self.set_role("member")
        self.assertFalse(self.M.req("GET", "/api/teams/automation")[1]["isPm"])
        # only team leads and PMs can be project managers
        self.assertEqual(self.create(pmPersonId=self.bob_id)[0], 400)

    def test_template_dates_and_at_risk(self):
        s, r = self.create(startDate="2026-10-05")
        self.assertEqual(s, 200, r)
        pid = r["id"]
        p = self.detail(pid)
        self.assertEqual([ph["name"] for ph in p["phases"]][:3], ["Requirement Study", "Development", "System Integration Testing - SIT"])
        self.assertEqual(len(p["phases"]), 6)
        self.assertEqual(p["goLive"], "2026-12-09")                     # day 48 with no holidays
        # registering the project's holidays moves the dates
        plan = {"phases": [dict(ph, items=ph["items"]) for ph in p["phases"]], "holidays": [{"date": "2026-10-26", "name": "Sultan Selangor PH"}]}
        self.assertEqual(self.L.req("PUT", "/api/projects/%d/plan" % pid, plan)[0], 200)
        p = self.detail(pid)
        self.assertEqual(p["goLive"], "2026-12-10")
        # the start date is long past for most activities, so the project is At Risk while they're not completed
        if dt.date.today().isoformat() > "2026-10-09":
            self.assertGreater(p["overdue"], 0)
            self.assertEqual(p["displayStatus"], "At Risk")
            self.assertEqual(p["phases"][0]["status"], "At Risk")
        # mark everything completed: no longer at risk, phase rolls up to Completed
        for ph in plan["phases"]:
            for it in ph["items"]:
                it["status"] = "Completed"
        self.assertEqual(self.L.req("PUT", "/api/projects/%d/plan" % pid, plan)[0], 200)
        p = self.detail(pid)
        self.assertEqual((p["overdue"], p["displayStatus"], p["progress"]), (0, "Active", 1))
        self.assertEqual(p["phases"][0]["status"], "Completed")
        self.L.req("DELETE", "/api/projects/%d" % pid)

    def test_plan_editing_rules(self):
        s, r = self.create(template="", name="Blank")
        pid = r["id"]
        self.assertEqual(self.detail(pid)["phases"], [])
        plan = {"phases": [{"name": "SIT", "startDay": 1, "endDay": 5, "deliverable": "SIT sign-off",
                            "items": [{"kind": "activity", "name": "Testing", "startDay": 1, "endDay": 4, "owner": "RHB / Xmeg"},
                                      {"kind": "milestone", "name": "SIT sign-off", "startDay": 5, "endDay": 5}]}]}
        self.assertEqual(self.L.req("PUT", "/api/projects/%d/plan" % pid, plan)[0], 200)
        p = self.detail(pid)
        self.assertEqual([(i["kind"], i["name"], i["owner"]) for i in p["phases"][0]["items"]], [("activity", "Testing", "RHB / Xmeg"), ("milestone", "SIT sign-off", "")])
        bad = lambda **kw: self.L.req("PUT", "/api/projects/%d/plan" % pid, {"phases": [dict(plan["phases"][0], **kw)]})[0]
        self.assertEqual(bad(startDay=6, endDay=5), 400)                # ends before it starts
        self.assertEqual(bad(items=[{"name": "x", "startDay": 1, "endDay": 1, "status": "Done"}]), 400)  # unknown status
        self.assertEqual(bad(items=[{"name": "x", "kind": "phase", "startDay": 1, "endDay": 1}]), 400)   # no phase inside a phase
        self.assertEqual(self.M.req("PUT", "/api/projects/%d/plan" % pid, plan)[0], 403)  # members can't change plans
        # a daily task linked to an activity keeps its details when that activity is deleted
        item = p["phases"][0]["items"][0]["id"]
        s, t, _ = self.L.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "Run SIT", "lead": ["bob"], "startDate": "2026-10-05",
                                                                     "projectId": pid, "projectItemId": item})
        self.assertEqual(s, 200, t)
        plan["phases"][0]["items"] = plan["phases"][0]["items"][1:]
        self.assertEqual(self.L.req("PUT", "/api/projects/%d/plan" % pid, plan)[0], 200)
        task = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        self.assertEqual((task["projectId"], task["projectItemId"], task["title"]), (pid, None, "Run SIT"))
        self.L.req("DELETE", "/api/projects/%d" % pid)
        task = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        self.assertIsNone(task["projectId"])

    def test_daily_task_links_project(self):
        s, r = self.create()
        pid = r["id"]
        p = self.detail(pid)
        uat = p["phases"][3]
        act = uat["items"][0]
        s, t, _ = self.M.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "UAT Zena server installation", "lead": ["bob"],
                                                                     "customer": "Something else", "startDate": "2026-11-10",
                                                                     "projectId": pid, "projectItemId": act["id"]})
        self.assertEqual(s, 200, t)
        task = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        self.assertEqual((task["customer"], task["projectName"], task["projectPhaseName"], task["projectItemName"]),
                         ("RHB", "Zena Upgrade", uat["name"], act["name"]))       # the client comes from the project
        self.assertEqual(self.detail(pid)["tasks"][0]["id"], t["id"])
        # projects from other teams, or activities from another project, are refused
        other = server.connect().execute("SELECT id FROM project_items WHERE project_id<>? LIMIT 1", (pid,)).fetchone()
        body = {"category": "Project", "title": "x", "lead": ["bob"], "projectId": pid}
        if other:
            self.assertEqual(self.M.req("POST", "/api/teams/automation/tasks", dict(body, projectItemId=other["id"]))[0], 400)
        self.assertEqual(self.M.req("POST", "/api/teams/automation/tasks", dict(body, projectId=999999))[0], 400)
        # history names the project, not its number
        t2 = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        upd = {k: t2[k] for k in ("category", "title", "urgency", "percent", "progress", "lead", "support")}
        upd.update(startDate=t2["startDate"], projectId=None)
        self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % t["id"], upd)[0], 200)
        hist = self.M.req("GET", "/api/tasks/%d/history" % t["id"])[1]["entries"]
        ch = next(e for e in hist if e["kind"] == "edit")["changes"]
        self.assertIn(["project_id", "Zena Upgrade", None], ch)
        self.L.req("DELETE", "/api/projects/%d" % pid)

    def test_export_timeline_layout(self):
        s, r = self.create()
        pid = r["id"]
        s, data, hd = self.L.req("GET", "/api/projects/%d/export.xlsx" % pid, raw=True)
        self.assertEqual(s, 200)
        self.assertIn("Zena Upgrade", hd["Content-Disposition"])
        z = zipfile.ZipFile(io.BytesIO(data))
        plan = z.read("xl/worksheets/sheet1.xml").decode()
        self.assertNotIn("<f>", plan)                                      # values only, no formulas
        for text in ("Project Title : Zena Upgrade", "Phase / Activity", "Requirement Study", "Week 1", "◆", "RHB Bank Bhd"):
            self.assertIn(text, plan)
        self.assertIn('<pane xSplit="2" ySplit="7"', plan)                 # frozen like the sample (C8)
        self.assertIn("mergeCell", plan)
        self.assertIn("1F7A99", z.read("xl/styles.xml").decode())         # phase colours
        self.assertIn("Holidays", z.read("xl/workbook.xml").decode())
        self.L.req("DELETE", "/api/projects/%d" % pid)


if __name__ == "__main__":
    unittest.main()
