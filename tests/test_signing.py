"""Signed progress notes, archived tasks locked for members, and backdated completions on late tasks.
Run: python -m unittest discover -s tests -v"""
import datetime as dt
import os
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402

W = dt.datetime(2026, 11, 10, 19, 22)
SIG = r"^\[\d{2}/\d{2}/\d{4} \d{2}:\d{2} %s\] "


def task_body(t, **kw):
    b = {k: t[k] for k in ("category", "title", "customer", "urgency", "percent", "progress", "lead", "support")}
    b.update(startDate=t["startDate"], actualDate=t["actualDate"] or "")
    b.update(kw)
    return b


class SignTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        cls.L, cls.M = T.lead, T.member  # Alice (lead), Bob (member)

    def task(self, cli, tid):
        return next(x for x in cli.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["id"] == tid)

    def new_task(self, **kw):
        body = {"category": "Project", "title": "Signing check", "urgency": "Medium", "lead": ["bob"], "support": [], "startDate": "2026-09-01"}
        body.update(kw)
        s, r, _ = self.L.req("POST", "/api/teams/automation/tasks", body)
        self.assertEqual(s, 200, r)
        return r["id"]

    def test_signature_format(self):
        old = "Preparing Report\n[11/11/2026 02:09 Izuan] Zenith log collected\nVendor replied — Ena (10/11/2026 18:00)"
        new = ("khaidir to add comment\nPreparing Report\n[11/11/2026 02:09 Izuan] Zenith log collected\n"
               "Vendor replied — Ena (10/11/2026 18:00)\n[01/01/2026 09:00 Izuan] fake")
        self.assertEqual(server.sign_progress(old, new, "Khaidir", W).split("\n"), [
            "[10/11/2026 19:22 Khaidir] khaidir to add comment",   # new line signed at the start
            "Preparing Report",                                     # untouched line stays as it was
            "[11/11/2026 02:09 Izuan] Zenith log collected",        # untouched signed line stays as it was
            "[10/11/2026 18:00 Ena] Vendor replied",                # end-of-line format: same signature, start-of-line layout
            "[10/11/2026 19:22 Khaidir] fake",                      # a typed signature is replaced by the real author
        ])
        once = server.sign_progress("", "x", "Izuan", W)
        self.assertEqual(server.sign_progress(once, once, "Ena", W), once)  # saving again changes nothing
        # editing someone else's signed line re-signs it with the editor
        self.assertEqual(server.sign_progress(once, "[11/11/2026 10:00 Izuan] x and more", "Ena", W), "[10/11/2026 19:22 Ena] x and more")

    def test_signed_through_the_api(self):
        tid = self.new_task()
        t = self.task(self.M, tid)
        self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % tid, task_body(t, progress="Called the customer"))[0], 200)
        first = self.task(self.M, tid)["progress"]
        self.assertRegex(first, SIG % "Bob" + "Called the customer$")
        t = self.task(self.L, tid)
        self.assertEqual(self.L.req("PUT", "/api/tasks/%d" % tid, task_body(t, progress=first + "\nLead note"))[0], 200)
        lines = self.task(self.L, tid)["progress"].split("\n")
        self.assertEqual(lines[0], first)
        self.assertRegex(lines[1], SIG % "Alice" + "Lead note$")

    def test_archived_task_lead_only(self):
        t = next(x for x in self.M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["no"] == 3)  # Bob leads it; completed in March
        self.assertTrue(t["archived"])
        self.assertFalse(t["canEdit"])
        s, r, _ = self.M.req("PUT", "/api/tasks/%d" % t["id"], task_body(t, percent=99))
        self.assertEqual(s, 403)
        self.assertIn("archived", r["error"])
        t = self.task(self.L, t["id"])
        self.assertTrue(t["canEdit"])
        self.assertEqual(self.L.req("PUT", "/api/tasks/%d" % t["id"], task_body(t, progress=t["progress"] + "\nlead correction"))[0], 200)

    def test_backdated_completion_on_late_task_needs_lead(self):
        today = dt.date.today()
        target = (today - dt.timedelta(days=20)).isoformat()
        tid = self.new_task(target=target)          # set by the lead, so it is the official target
        t = self.task(self.M, tid)
        self.assertEqual(t["status"], "Delay")
        # Bob claims it was done before the target: this must wait for the lead
        early = (today - dt.timedelta(days=21)).isoformat()
        s, r, _ = self.M.req("PUT", "/api/tasks/%d" % tid, task_body(t, actualDate=early, percent=100))
        self.assertEqual((s, r["pending"]), (200, ["actual_date"]))
        t = self.task(self.M, tid)
        self.assertIsNone(t["actualDate"])          # nothing changes until the lead approves
        self.assertEqual(t["status"], "Delay")
        rq = next(x for x in self.L.req("GET", "/api/teams/automation/requests")[1]["requests"] if x["taskId"] == tid and x["status"] == "pending")
        self.assertEqual(rq["lateCheck"]["target"], target)
        self.assertEqual(rq["lateCheck"]["ifApproved"], "Completed Early")
        self.assertEqual(self.L.req("POST", "/api/requests/%d/reject" % rq["id"], {"note": "Delivered late"})[0], 200)
        # completing it today needs no approval and is honestly late
        t = self.task(self.M, tid)
        self.assertEqual(self.M.req("PUT", "/api/tasks/%d" % tid, task_body(t, actualDate=today.isoformat(), percent=100))[1]["pending"], [])
        self.assertEqual(self.task(self.M, tid)["status"], "Completed Late")


if __name__ == "__main__":
    unittest.main()
