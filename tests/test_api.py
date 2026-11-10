"""End-to-end API tests. Run: python -m unittest discover -s tests -v   (standard library only)"""
import io
import json
import os
import re
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
import zipfile
from http.cookiejar import CookieJar

TMP = tempfile.mkdtemp()
os.environ["TT_DB"] = os.path.join(TMP, "t.db")
os.environ["TT_BASE_URL"] = "http://tracker.test"
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
import server  # noqa: E402

server.init_db()
SRV = server.ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
threading.Thread(target=SRV.serve_forever, daemon=True).start()
BASE = "http://127.0.0.1:%d" % SRV.server_address[1]


class Client:
    def __init__(self):
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

    def req(self, method, path, body=None, headers=None, raw=False):
        hd = {} if method == "GET" else {"Content-Type": "application/json", "X-Requested-With": "tt"}
        hd.update(headers or {})
        data = None if method == "GET" else json.dumps(body or {}).encode()
        r = urllib.request.Request(BASE + path, data=data, headers=hd, method=method)
        try:
            with self.op.open(r) as res:
                b = res.read()
                return res.status, (b if raw else json.loads(b)), res.headers
        except urllib.error.HTTPError as e:
            b = e.read()
            return e.code, json.loads(b) if b else {}, e.headers


FIXTURE = {
    "team": {"id": "automation", "name": "Team Automation", "categories": ["Pre-Sales", "Project", "Tickets", "Internal"], "customers": ["Acme"]},
    "people": [{"key": "alice", "name": "Alice", "role": "lead"}, {"key": "bob", "name": "Bob", "role": "member"},
               {"key": "cara", "name": "Cara", "role": "member"}],
    "tasks": [
        {"no": 1, "category": "Project", "title": "Early job", "lead": ["alice"], "support": ["bob"], "target": "2026-03-10", "actualDate": "2026-03-05"},
        {"no": 2, "category": "Project", "title": "On-time job", "lead": ["alice"], "support": [], "target": "2026-03-10", "actualDate": "2026-03-10"},
        {"no": 3, "category": "Tickets", "title": "Late job", "lead": ["bob"], "support": ["alice"], "target": "2026-03-10", "actualDate": "2026-03-15"},
        {"no": 4, "category": "Tickets", "title": "Health Check", "lead": ["cara"], "support": ["bob"], "target": "2026-03-10", "percent": 50},
        {"no": 5, "category": "Internal", "title": "No target job", "lead": ["cara"], "support": []},
    ]}


def link_token(url):
    return re.search(r"#invite=(.+)$", url).group(1)


class TrackerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # admin setup link, as printed by `server.py admin-link`
        con = server.connect()

        class H:
            pass
        h = H()
        h.con = con
        with server.Tx(con):
            tok, _ = server.make_link(h, "setup")
        con.close()
        server.import_team(server.connect(), FIXTURE)
        cls.admin = Client()
        s, r, _ = cls.admin.req("POST", "/api/invite/accept", {"token": tok, "name": "Admin", "login": "admin", "password": "admin-pass-123"})
        assert s == 200, r
        # make Alice (seeded lead) an account, and Bob a member
        cls.team = cls.admin.req("GET", "/api/teams/automation")[1]
        ppl = {p["key"]: p for p in cls.team["people"]}
        cls.lead, cls.member, cls.outsider = Client(), Client(), Client()
        for cli, key, login in ((cls.lead, "alice", "alice"), (cls.member, "bob", "bob")):
            s, r, _ = cls.admin.req("POST", "/api/teams/automation/people/%d/link" % ppl[key]["id"])
            assert s == 200 and r["kind"] == "invite", r
            assert r["url"].startswith("http://tracker.test/#invite=")
            s, r, _ = cli.req("POST", "/api/invite/accept", {"token": link_token(r["url"]), "name": key.title(), "login": login, "password": "password-%s-1" % key})
            assert s == 200, r
        cls.ppl = ppl

    def test_import_and_statuses(self):
        s, r, _ = self.member.req("GET", "/api/teams/automation/tasks")
        self.assertEqual(s, 200)
        by_no = {t["no"]: t for t in r["tasks"]}
        self.assertTrue({1, 2, 3, 4, 5} <= set(by_no))
        self.assertEqual(by_no[1]["status"], "Completed Early")
        self.assertEqual(by_no[2]["status"], "Completed On Time")
        self.assertEqual(by_no[3]["status"], "Completed Late")
        self.assertEqual(by_no[4]["status"], "Delay")
        self.assertEqual(by_no[4]["percent"], 50)
        self.assertEqual(by_no[5]["status"], "No Target")
        self.assertIsNone(by_no[5]["effTarget"])
        self.assertTrue(by_no[1]["archived"])  # completed long ago -> archive

    def test_import_rejects_duplicates_and_unknown_people(self):
        with self.assertRaises(SystemExit):
            server.import_team(server.connect(), FIXTURE)
        bad = {"team": {"name": "Other"}, "people": [], "tasks": [{"no": 1, "title": "x", "lead": ["ghost"]}]}
        with self.assertRaises(SystemExit):
            server.import_team(server.connect(), bad)

    def test_roles(self):
        self.assertEqual(self.lead.req("GET", "/api/teams/automation")[1]["role"], "lead")
        self.assertEqual(self.member.req("GET", "/api/teams/automation")[1]["role"], "member")
        self.assertEqual(self.admin.req("GET", "/api/me")[1]["teams"][0]["role"], "admin")

    def test_unauthenticated_blocked(self):
        c = Client()
        self.assertEqual(c.req("GET", "/api/teams/automation/tasks")[0], 401)
        self.assertEqual(self.outsider.req("GET", "/api/teams/automation")[0], 401)

    def test_csrf_header_required(self):
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks", {"title": "x"}, headers={"X-Requested-With": "nope"})
        self.assertEqual(s, 403)

    def test_member_task_flow_and_target_rules(self):
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks",
                                  {"category": "Tickets", "title": "Member task", "urgency": "High", "lead": ["bob"], "support": [], "target": "2026-12-31", "startDate": "2026-11-01"})
        self.assertEqual(s, 200, r)
        tid = r["id"]
        t = self._task(self.member, tid)
        self.assertIsNone(t["target"])            # member's date is only a request
        self.assertEqual(t["requestedTarget"], "2026-12-31")
        self.assertTrue(t["pending"])
        # member cannot set the official target
        self.assertEqual(self.member.req("PUT", "/api/tasks/%d/target" % tid, {"target": "2027-01-15"})[0], 403)
        # lead can, and it is logged
        self.assertEqual(self.lead.req("PUT", "/api/tasks/%d/target" % tid, {"target": "2027-01-15"})[0], 200)
        t = self._task(self.member, tid)
        self.assertEqual(t["target"], "2027-01-15")
        self.assertFalse(t["pending"])
        # once official, a member's requestedTarget is ignored
        body = self._body(t)
        body["requestedTarget"] = "2030-01-01"
        body["percent"] = 40
        self.assertEqual(self.member.req("PUT", "/api/tasks/%d" % tid, body)[0], 200)
        t = self._task(self.member, tid)
        self.assertEqual(t["effTarget"], "2027-01-15")
        self.assertEqual(t["percent"], 40)
        hist = self.member.req("GET", "/api/tasks/%d/history" % tid)[1]["entries"]
        kinds = [e["kind"] for e in hist]
        self.assertEqual(kinds, ["edit", "target", "create"])
        self.assertIn(["percent", 0, 40], hist[0]["changes"])
        self.assertEqual(hist[1]["changes"], {"from": None, "to": "2027-01-15"})
        self.assertEqual(hist[1]["by"], "Alice")
        # members can't delete; leads can
        self.assertEqual(self.member.req("DELETE", "/api/tasks/%d" % tid)[0], 403)
        self.assertEqual(self.lead.req("DELETE", "/api/tasks/%d" % tid)[0], 200)

    def test_member_cannot_edit_others_task(self):
        tasks = self.member.req("GET", "/api/teams/automation/tasks")[1]["tasks"]
        other = next(t for t in tasks if "bob" not in t["lead"] + t["support"])
        self.assertFalse(other["canEdit"])
        s, r, _ = self.member.req("PUT", "/api/tasks/%d" % other["id"], self._body(other))
        self.assertEqual(s, 403)

    def test_validation(self):
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks", {"category": "Nope", "title": "x", "lead": []})
        self.assertEqual(s, 400)
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "x", "lead": ["ghost"]})
        self.assertEqual(s, 400)
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks", {"category": "Project", "title": "x", "target": "2026-11-31"})
        self.assertEqual(s, 400)

    def test_kpi_lead_only_and_formula(self):
        self.assertEqual(self.member.req("GET", "/api/teams/automation/kpi")[0], 403)
        s, k, _ = self.lead.req("GET", "/api/teams/automation/kpi?from=2026-01-01&to=2026-12-31")
        self.assertEqual(s, 200)
        rows = {r["key"]: r for r in k["rows"]}
        # Workbook formula: KPI = 80% x (E - lead late - support late)/E + 20% x early involvements/E
        al = rows["alice"]   # leads 1 (early) + 2 (on time), supports 3 (late)
        self.assertEqual((al["C"], al["D"], al["E"], al["F"], al["G"], al["I"], al["J"], al["M"]), (2, 1, 3, 2, 0, 0, 1, 1))
        self.assertAlmostEqual(al["O"], 0.8 * 2 / 3 + 0.2 * 1 / 3)
        bo = rows["bob"]       # leads 3 (late), supports 1 (early)
        self.assertEqual((bo["C"], bo["D"], bo["G"], bo["M"]), (1, 1, 1, 1))
        self.assertAlmostEqual(bo["O"], 0.5)
        self.assertEqual(bo["rating"], "At Risk")
        T = k["team"]
        self.assertEqual((T["C"], T["F"], T["G"], T["D"], T["I"], T["J"], T["E"], T["M"]), (3, 2, 1, 2, 1, 1, 5, 2))
        self.assertAlmostEqual(T["O"], 0.8 * 0.6 + 0.2 * 0.4)
        self.assertEqual(rows["cara"]["rating"], "No Data")
        k2 = self.lead.req("GET", "/api/teams/automation/kpi?from=2026-03-11&to=2026-03-31")[1]
        self.assertEqual(k2["team"]["C"], 1)  # only the late job finished in that window

    def test_export(self):
        s, data, hd = self.member.req("GET", "/api/teams/automation/export.xlsx", raw=True)
        self.assertEqual(s, 200)
        self.assertIn("attachment", hd["Content-Disposition"])
        z = zipfile.ZipFile(io.BytesIO(data))
        names = z.namelist()
        self.assertIn("xl/worksheets/sheet2.xml", names)
        self.assertNotIn("xl/worksheets/sheet3.xml", names)  # members don't get KPI sheets
        import xml.dom.minidom
        for n in names:
            if n.endswith(".xml") or n.endswith(".rels"):
                xml.dom.minidom.parseString(z.read(n))  # well-formed
        s, data, _ = self.lead.req("GET", "/api/teams/automation/export.xlsx?from=2026-01-01&to=2026-12-31", raw=True)
        z = zipfile.ZipFile(io.BytesIO(data))
        self.assertIn("xl/worksheets/sheet4.xml", z.namelist())
        self.assertIn(b"KPI Scorecard", z.read("xl/workbook.xml"))

    def test_people_rules(self):
        # a lead cannot create another lead or touch a lead's record
        s, r, _ = self.lead.req("POST", "/api/teams/automation/people", {"name": "New Lead", "role": "lead"})
        self.assertEqual(s, 403)
        s, r, _ = self.lead.req("POST", "/api/teams/automation/people", {"name": "Newbie", "role": "member"})
        self.assertEqual(s, 200)
        self.assertEqual(self.member.req("POST", "/api/teams/automation/people", {"name": "X"})[0], 403)
        # team settings: lead yes, member no
        self.assertEqual(self.member.req("PUT", "/api/teams/automation", {"name": "Hacked"})[0], 403)
        # only admin creates teams
        self.assertEqual(self.lead.req("POST", "/api/teams", {"name": "Team Network"})[0], 403)
        s, r, _ = self.admin.req("POST", "/api/teams", {"name": "Team Network", "categories": ["Project"], "customers": []})
        self.assertEqual(s, 200)
        self.assertEqual(self.lead.req("GET", "/api/teams/%s/tasks" % r["id"])[0], 403)  # other team's data is closed

    def test_invite_single_use_and_reset(self):
        s, r, _ = self.lead.req("POST", "/api/teams/automation/people", {"name": "Izz Two"})
        pid = r["id"]
        url = self.lead.req("POST", "/api/teams/automation/people/%d/link" % pid)[1]["url"]
        tok = link_token(url)
        c = Client()
        self.assertEqual(c.req("POST", "/api/invite/info", {"token": tok})[1]["team"], "Team Automation")
        self.assertEqual(c.req("POST", "/api/invite/accept", {"token": tok, "name": "Izz", "login": "izz2", "password": "short"})[0], 400)
        self.assertEqual(c.req("POST", "/api/invite/accept", {"token": tok, "name": "Izz", "login": "izz2", "password": "long-enough-pw"})[0], 200)
        self.assertEqual(Client().req("POST", "/api/invite/accept", {"token": tok, "name": "X", "login": "x9", "password": "long-enough-pw"})[0], 410)
        # reset link for a joined person
        r = self.lead.req("POST", "/api/teams/automation/people/%d/link" % pid)[1]
        self.assertEqual(r["kind"], "reset")
        c2 = Client()
        self.assertEqual(c2.req("POST", "/api/invite/accept", {"token": link_token(r["url"]), "password": "brand-new-pass"})[0], 200)
        self.assertEqual(c.req("GET", "/api/teams/automation")[0], 401)  # old session revoked
        self.assertEqual(Client().req("POST", "/api/login", {"login": "izz2", "password": "brand-new-pass"})[0], 200)

    def test_login_rate_limit(self):
        c = Client()
        codes = [c.req("POST", "/api/login", {"login": "nobody-x", "password": "wrong"})[0] for _ in range(6)]
        self.assertEqual(codes[:5], [401] * 5)
        self.assertEqual(codes[5], 429)

    def test_security_headers_and_static(self):
        r = urllib.request.urlopen(BASE + "/")
        self.assertIn("default-src 'self'", r.headers["Content-Security-Policy"])
        self.assertEqual(r.headers["Referrer-Policy"], "no-referrer")
        self.assertEqual(urllib.request.urlopen(BASE + "/app.js").status, 200)

    def test_approval_flow(self):
        M, L = self.member, self.lead
        new = {"category": "Project", "title": "Needs approval", "urgency": "High", "lead": ["bob"], "support": [], "target": "2026-12-15",
               "startDate": "2026-11-01", "percent": 10}
        # members may only create tasks they lead
        self.assertEqual(M.req("POST", "/api/teams/automation/tasks", dict(new, lead=["alice"]))[0], 400)
        s, r, _ = M.req("POST", "/api/teams/automation/tasks", new)
        self.assertEqual(s, 200)
        self.assertTrue(r["pending"])
        tid = r["id"]
        t = self._task(M, tid)
        self.assertFalse(t["approved"])
        self.assertIsNone(t["target"])
        reqs = L.req("GET", "/api/teams/automation/requests")[1]["requests"]
        create = next(x for x in reqs if x["taskId"] == tid)
        self.assertEqual((create["kind"], create["by"]), ("create", "Bob"))
        self.assertEqual(M.req("POST", "/api/requests/%d/approve" % create["id"])[0], 403)  # members can't approve
        self.assertEqual(L.req("POST", "/api/requests/%d/approve" % create["id"])[0], 200)
        t = self._task(M, tid)
        self.assertTrue(t["approved"])
        self.assertEqual(t["target"], "2026-12-15")  # proposed target became official on approval

        # member edit -> change request; task unchanged until approved
        body = dict(self._body(t), percent=60, target="2026-12-20")
        s, r, _ = M.req("PUT", "/api/tasks/%d" % tid, body)
        self.assertTrue(r["pending"])
        body["percent"] = 70  # a second save replaces the pending request
        M.req("PUT", "/api/tasks/%d" % tid, body)
        t = self._task(M, tid)
        self.assertEqual((t["percent"], t["target"]), (10, "2026-12-15"))
        self.assertTrue(t["changePending"])
        self.assertTrue(t["request"]["mine"])
        reqs = [x for x in L.req("GET", "/api/teams/automation/requests")[1]["requests"] if x["taskId"] == tid]
        self.assertEqual(len(reqs), 1)
        self.assertIn(["percent", 10, 70], reqs[0]["changes"])
        self.assertIn(["target", "2026-12-15", "2026-12-20"], reqs[0]["changes"])
        self.assertEqual(L.req("POST", "/api/requests/%d/approve" % reqs[0]["id"])[0], 200)
        self.assertEqual(L.req("POST", "/api/requests/%d/approve" % reqs[0]["id"])[0], 409)  # only once
        t = self._task(M, tid)
        self.assertEqual((t["percent"], t["target"]), (70, "2026-12-20"))
        self.assertFalse(t["changePending"])
        hist = M.req("GET", "/api/tasks/%d/history" % tid)[1]["entries"]
        edit = next(e for e in hist if e["kind"] == "edit")
        self.assertEqual(edit["by"], "Bob")               # credited to the member who asked
        self.assertTrue(any(e["kind"] == "approve" and e["by"] == "Alice" for e in hist))

        # rejection keeps the task as it was and tells the member why
        M.req("PUT", "/api/tasks/%d" % tid, dict(self._body(t), percent=90))
        rq = next(x for x in L.req("GET", "/api/teams/automation/requests")[1]["requests"] if x["taskId"] == tid)
        self.assertEqual(L.req("POST", "/api/requests/%d/reject" % rq["id"], {"note": "Not done yet"})[0], 200)
        self.assertEqual(self._task(M, tid)["percent"], 70)
        mine = M.req("GET", "/api/teams/automation/requests")[1]["requests"]
        rej = next(x for x in mine if x["id"] == rq["id"])
        self.assertEqual((rej["status"], rej["note"], rej["decidedBy"]), ("rejected", "Not done yet", "Alice"))

        # leads edit directly, no approval
        s, r, _ = L.req("PUT", "/api/tasks/%d" % tid, dict(self._body(t), percent=80))
        self.assertNotIn("pending", r)
        self.assertEqual(self._task(M, tid)["percent"], 80)

    def test_support_engineer_is_read_only(self):
        tasks = self.member.req("GET", "/api/teams/automation/tasks")[1]["tasks"]
        t1 = next(t for t in tasks if t["no"] == 1)  # lead alice, support bob
        self.assertFalse(t1["canEdit"])
        self.assertEqual(self.member.req("PUT", "/api/tasks/%d" % t1["id"], self._body(t1))[0], 403)
        t3 = next(t for t in tasks if t["no"] == 3)  # bob leads
        self.assertTrue(t3["canEdit"])

    def test_kpi_ignores_unapproved_tasks(self):
        before = self.lead.req("GET", "/api/teams/automation/kpi?from=2026-01-01&to=2026-12-31")[1]["team"]["C"]
        s, r, _ = self.member.req("POST", "/api/teams/automation/tasks", {"category": "Tickets", "title": "Done, unapproved", "lead": ["bob"],
                                                                         "target": "2026-02-01", "startDate": "2026-01-20", "actualDate": "2026-01-30"})
        self.assertEqual(s, 200)
        after = self.lead.req("GET", "/api/teams/automation/kpi?from=2026-01-01&to=2026-12-31")[1]["team"]["C"]
        self.assertEqual(before, after)
        # the member can withdraw their own pending task
        rq = next(x for x in self.member.req("GET", "/api/teams/automation/requests")[1]["requests"] if x["taskId"] == r["id"])
        self.assertEqual(self.member.req("DELETE", "/api/requests/%d" % rq["id"])[0], 200)
        self.assertFalse(any(t["id"] == r["id"] for t in self.member.req("GET", "/api/teams/automation/tasks")[1]["tasks"]))

    def test_teams_are_isolated_and_users_can_join_several(self):
        A = self.admin
        s, r, _ = A.req("POST", "/api/teams", {"name": "Team Isolated", "categories": ["Project"]})
        tid = r["id"]
        A.req("POST", "/api/teams/%s/tasks" % tid, {"category": "Project", "title": "Secret", "lead": []})  # no people yet -> 400, fine
        s, p, _ = A.req("POST", "/api/teams/%s/people" % tid, {"name": "Bob", "login": "bob"})  # existing account, linked directly
        self.assertTrue(p["joined"])
        self.assertEqual(A.req("POST", "/api/teams/%s/people" % tid, {"name": "Ghost", "login": "nobody-here"})[0], 400)
        s, r, _ = A.req("POST", "/api/teams/%s/tasks" % tid, {"category": "Project", "title": "Secret", "lead": ["bob"]})
        self.assertEqual(s, 200)
        # Bob now has two teams and sees both; he is a member in the new team, so no KPI there
        teams = {t["id"]: t["role"] for t in self.member.req("GET", "/api/me")[1]["teams"]}
        self.assertEqual(teams, {"automation": "member", tid: "member"})
        self.assertEqual(self.member.req("GET", "/api/teams/%s/tasks" % tid)[0], 200)
        self.assertEqual(self.member.req("GET", "/api/teams/%s/kpi" % tid)[0], 403)
        # Alice leads Automation but is not in the new team: no tasks, no KPI, no export, no history
        self.assertEqual(self.lead.req("GET", "/api/teams/%s/tasks" % tid)[0], 403)
        self.assertEqual(self.lead.req("GET", "/api/teams/%s/kpi" % tid)[0], 403)
        self.assertEqual(self.lead.req("GET", "/api/teams/%s/export.xlsx" % tid)[0], 403)
        self.assertEqual(self.lead.req("GET", "/api/tasks/%d/history" % r["id"])[0], 403)
        self.assertEqual(self.lead.req("PUT", "/api/tasks/%d" % r["id"], {"category": "Project", "title": "x", "lead": ["bob"]})[0], 403)
        # an invite can be accepted with an existing login, adding the team to that account
        s, p, _ = A.req("POST", "/api/teams/%s/people" % tid, {"name": "Alice"})
        url = A.req("POST", "/api/teams/%s/people/%d/link" % (tid, p["id"]))[1]["url"]
        c = Client()
        self.assertEqual(c.req("POST", "/api/invite/accept", {"token": link_token(url), "existingLogin": "alice", "existingPassword": "wrong-password"})[0], 401)
        self.assertEqual(c.req("POST", "/api/invite/accept", {"token": link_token(url), "existingLogin": "alice", "existingPassword": "password-alice-1"})[0], 200)
        self.assertEqual(self.lead.req("GET", "/api/teams/%s/tasks" % tid)[0], 200)

    def test_import_from_workbook(self):
        import xlsx
        import xlsm_import
        D = xlsx.Date
        head = ["Task No", "Categories", "Main Task / Project", "Task Progress", "Task Percentage", "Urgency", "Customer",
                "Lead Engineer", "Support Engineer", "Start Date", "Target Date", "Actual Date", "Status"]
        tracker = [head, [7, "Project", "Open job", "note", 0.4, "High", "Acme", "Dana", "Eli / Fay", D("2026-10-01"), "31-11-2026", None, "On-Going"]]
        archive = [head, [3, "Tickets", "Closed job", "", 1, "Low", "Acme", "Eli", "", D("2026-01-02"), D("2026-01-10"), D("2026-01-09"), "x"]]
        path = os.path.join(TMP, "wb.xlsx")
        with open(path, "wb") as f:
            f.write(xlsx.build([xlsx.Sheet("Daily Task Tracker", tracker), xlsx.Sheet("Archive", archive), xlsx.Sheet("Customer", [["Acme"], ["Beta"]])]))
        data, problems = xlsm_import.read_workbook(path, "Team Workbook", ["dana"])
        self.assertEqual(len(data["tasks"]), 2)
        self.assertEqual({p["key"]: p["role"] for p in data["people"]}, {"dana": "lead", "eli": "member", "fay": "member"})
        t7 = next(t for t in data["tasks"] if t["no"] == 7)
        self.assertEqual((t7["percent"], t7["lead"], t7["support"], t7["startDate"], t7["target"]), (40, ["dana"], ["eli", "fay"], "2026-10-01", None))
        self.assertTrue(any("31-11-2026" in p for p in problems))
        self.assertEqual(data["team"]["customers"], ["Acme", "Beta"])
        tid, n_people, n_tasks = server.import_team(server.connect(), data)
        self.assertEqual((tid, n_people, n_tasks), ("team-workbook", 3, 2))

    def test_sync_from_newer_workbook(self):
        con = server.connect()
        base = {"team": {"id": "sync-team", "name": "Sync Team", "categories": ["Project"], "customers": ["Acme"]},
                "people": [{"key": "dan", "name": "Dan", "role": "lead"}],
                "tasks": [{"no": 1, "category": "Project", "title": "One", "lead": ["dan"], "support": [], "percent": 10, "target": "2026-05-01"},
                          {"no": 2, "category": "Project", "title": "Two", "lead": ["dan"], "support": [], "target": "2026-05-01"},
                          {"no": 3, "category": "Project", "title": "Three", "lead": ["dan"], "support": []}]}
        server.import_team(con, base)
        con.execute("UPDATE tasks SET target='2026-06-01' WHERE team_id='sync-team' AND no=3")  # set in the app
        newer = {"team": {"customers": ["Acme", "Beta"]}, "people": [{"key": "dan", "name": "Dan"}, {"key": "eve", "name": "Eve"}],
                 "tasks": [dict(base["tasks"][0], percent=60, progress="moved on", target="2026-05-09"),
                           dict(base["tasks"][2], target=None),  # workbook date missing: keep the tracker's
                           {"no": 4, "category": "Project", "title": "Four", "lead": ["eve"], "support": [], "target": None,
                            "startDate": None, "actualDate": None, "progress": "", "percent": 0, "urgency": "Low", "customer": ""}]}
        for t in newer["tasks"]:
            for k in ("startDate", "actualDate", "progress", "urgency", "customer", "percent"):
                t.setdefault(k, None if k.endswith("Date") else 0 if k == "percent" else "Medium" if k == "urgency" else "")
        with self.assertRaises(server._DryRun):
            server.sync_team(con, "sync-team", newer, dry_run=True)
        self.assertEqual(con.execute("SELECT percent FROM tasks WHERE team_id='sync-team' AND no=1").fetchone()[0], 10)  # dry run saved nothing
        rep = server.sync_team(con, "sync-team", newer)
        self.assertEqual((rep["updated"], rep["added"], rep["kept_target"], rep["missing"], rep["new_people"]), ([1], [4], [3], [2], ["Eve"]))
        row = con.execute("SELECT percent, target, progress FROM tasks WHERE team_id='sync-team' AND no=1").fetchone()
        self.assertEqual(tuple(row), (60, "2026-05-09", "moved on"))
        self.assertEqual(con.execute("SELECT target FROM tasks WHERE team_id='sync-team' AND no=3").fetchone()[0], "2026-06-01")
        self.assertEqual(server.sync_team(con, "sync-team", newer)["updated"], [])  # running again changes nothing

    # helpers
    def _task(self, cli, tid):
        return next(t for t in cli.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if t["id"] == tid)

    def _body(self, t):
        return {k: t[k] for k in ("category", "title", "customer", "urgency", "percent", "progress", "lead", "support", "startDate", "actualDate")}


if __name__ == "__main__":
    unittest.main()
