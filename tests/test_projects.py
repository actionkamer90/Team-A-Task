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

    def test_status_from_plan_screen(self):
        s, r = self.create()
        pid = r["id"]
        p = self.detail(pid)
        act, phase = p["phases"][1]["items"][0], p["phases"][1]
        url = "/api/projects/%d/items/%d" % (pid, act["id"])
        # a member links a daily task to the activity and completes it; the PM sees it's done and marks the activity Completed
        s, t, _ = self.M.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "Write scripts", "lead": ["bob"],
                                                                     "startDate": "2026-10-12", "projectId": pid, "projectItemId": act["id"]})
        it = self.detail(pid)["phases"][1]["items"][0]
        self.assertEqual((it["tasks"], it["tasksDone"]), (1, 0))
        task = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        upd = {k: task[k] for k in ("category", "title", "urgency", "percent", "progress", "lead", "support", "projectId", "projectItemId")}
        upd.update(startDate=task["startDate"], actualDate=dt.date.today().isoformat(), percent=100)
        self.assertEqual(self.L.req("PUT", "/api/tasks/%d" % t["id"], upd)[0], 200)
        self.assertEqual(self.detail(pid)["phases"][1]["items"][0]["tasksDone"], 1)
        self.assertEqual(self.M.req("PUT", url, {"status": "Completed"})[0], 403)        # members can't
        self.assertEqual(self.L.req("PUT", url, {"status": "Done"})[0], 400)
        self.assertEqual(self.L.req("PUT", "/api/projects/%d/items/%d" % (pid, phase["id"]), {"status": "Completed"})[0], 400)  # phases follow
        s, out, _ = self.L.req("PUT", url, {"status": "Completed"})
        self.assertEqual(s, 200, out)
        out = self.detail(pid)
        self.assertEqual(out["phases"][1]["items"][0]["status"], "Completed")
        self.assertEqual(out["completed"], 1)
        self.L.req("DELETE", "/api/projects/%d" % pid)

    def test_target_follows_activity(self):
        s, r = self.create(startDate="2026-12-01")
        pid = r["id"]
        p = self.detail(pid)
        act = p["phases"][1]["items"][0]                                # Development: script development
        # a member's task linked to the activity: the target is the activity's end date, official at once (no approval)
        s, t, _ = self.M.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "Scripts", "lead": ["bob"], "startDate": "2026-12-01",
                                                                     "target": "2027-06-30", "projectId": pid, "projectItemId": act["id"]})
        self.assertEqual((s, t["pending"]), (200, []))
        task = lambda: next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
        self.assertEqual((task()["target"], task()["effTarget"]), (act["endDate"], act["endDate"]))
        # trying to change it, as a member or the lead, keeps the plan's date
        upd = {k: task()[k] for k in ("category", "title", "urgency", "percent", "progress", "lead", "support", "projectId", "projectItemId")}
        upd.update(startDate="2026-12-01", target="2027-01-31")
        self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % t["id"], dict(upd, progress="note"))[1].get("pending"), [])
        self.assertEqual(self.L.req("PUT", "/api/tasks/%d" % t["id"], dict(upd, progress="note 2"))[0], 200)
        self.assertEqual(task()["target"], act["endDate"])
        self.assertEqual(self.L.req("PUT", "/api/tasks/%d/target" % t["id"], {"target": "2027-01-31"})[0], 400)
        # moving the plan moves the target of open linked tasks
        self.assertEqual(self.L.req("PUT", "/api/projects/%d" % pid, {"name": "Zena Upgrade", "client": "RHB", "startDate": "2026-12-08", "status": "Active"})[1]["tasksMoved"], 1)
        new_end = self.detail(pid)["phases"][1]["items"][0]["endDate"]
        self.assertNotEqual(new_end, act["endDate"])
        self.assertEqual(task()["target"], new_end)
        hist = self.M.req("GET", "/api/tasks/%d/history" % t["id"])[1]["entries"]
        self.assertTrue(any(e["kind"] == "target" and e["changes"].get("plan") and e["changes"]["to"] == new_end for e in hist))
        # unlinking the activity frees the target again (a member's new date then goes to the lead)
        upd.update(projectItemId=None, target="2027-02-26", progress="unlinked")
        self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % t["id"], upd)[1].get("pending"), ["target"])
        self.L.req("DELETE", "/api/tasks/%d" % t["id"])
        self.L.req("DELETE", "/api/projects/%d" % pid)

    def test_pm_assigns_tasks_on_own_project(self):
        self.set_role("pm")
        try:
            s, mine = self.create(self.M, name="Bob runs this")              # Bob is its Project Manager
            s, other = self.create(pmPersonId=self.alice_id, name="Alice runs this")
            act = self.detail(mine["id"], self.M)["phases"][2]["items"][0]
            body = {"category": "Project", "title": "Bob runs this", "lead": ["cara"], "startDate": "2026-11-12", "progress": "Run SIT cases 1-12",
                    "projectId": mine["id"], "projectItemId": act["id"]}
            s, t, _ = self.M.req("POST", "/api/teams/automation/tasks", body)  # assigns Cara, without being on the task
            self.assertEqual((s, t.get("pending")), (200, []), t)
            task = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == t["id"])
            self.assertEqual((task["lead"], task["target"], task["canEdit"]), (["cara"], act["endDate"], True))
            self.assertTrue(task["progress"].startswith("[") and "Bob]" in task["progress"].splitlines()[0])  # signed by the PM
            # the PM can update it later; the project page shows its latest note
            upd = {k: task[k] for k in ("category", "title", "urgency", "percent", "progress", "lead", "support", "projectId", "projectItemId")}
            upd.update(startDate=task["startDate"], urgency="High")
            self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % t["id"], upd)[0], 200)
            pt = next(x for x in self.detail(mine["id"], self.M)["tasks"] if x["id"] == t["id"])
            self.assertIn("Run SIT cases 1-12", pt["lastNote"])
            self.assertEqual(pt["startDate"], "2026-11-12")
            # ...but not on a project someone else manages, nor tasks outside projects
            self.assertEqual(self.M.req("POST", "/api/teams/automation/tasks", dict(body, projectId=other["id"], projectItemId=None))[0], 400)
            self.assertEqual(self.M.req("POST", "/api/teams/automation/tasks", dict(body, projectId=None, projectItemId=None))[0], 400)
            lst = {p["id"]: p["canEdit"] for p in self.M.req("GET", "/api/teams/automation/projects")[1]["projects"]}
            self.assertEqual((lst[mine["id"]], lst[other["id"]]), (True, False))
            self.L.req("DELETE", "/api/tasks/%d" % t["id"])
            self.L.req("DELETE", "/api/projects/%d" % mine["id"]); self.L.req("DELETE", "/api/projects/%d" % other["id"])
        finally:
            self.set_role("member")

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
