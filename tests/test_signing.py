"""Task progress lines are signed with the author's name, date and time when saved.
Run: python -m unittest discover -s tests -v"""
import datetime as dt
import os
import re
import sys
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402

W = dt.datetime(2026, 11, 11, 10, 3)
SIG = r"^\[\d{2}/\d{2}/\d{4} \d{2}:\d{2} %s\] "


class SignTests(unittest.TestCase):
    def test_only_new_or_changed_lines_are_signed(self):
        old = "Preparing Report\nZena done"
        new = "Log collected\nPreparing Report\nZena done\n\n[10/11/2026 09:00 Khaidir] earlier note"
        self.assertEqual(server.sign_progress(old, new, "Izuan", W),
                         "[11/11/2026 10:03 Izuan] Log collected\nPreparing Report\nZena done\n\n[10/11/2026 09:00 Khaidir] earlier note")
        # an edited line counts as new; an untouched duplicate line keeps its place
        self.assertEqual(server.sign_progress("a\na", "a\nb", "Izuan", W), "a\n[11/11/2026 10:03 Izuan] b")
        # saving again changes nothing
        once = server.sign_progress("", "x", "Izuan", W)
        self.assertEqual(server.sign_progress(once, once, "Ena", W), once)

    def test_signed_through_the_api(self):
        T = test_api.TrackerTest
        if not hasattr(T, "admin"):
            T.setUpClass()
        M = T.member  # Bob leads task 3 in the fixture
        t = next(x for x in M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["no"] == 3)
        body = {k: t[k] for k in ("category", "title", "customer", "urgency", "percent", "lead", "support")}
        body.update(progress="Called the customer\n" + (t["progress"] or ""), startDate=t["startDate"], actualDate=t["actualDate"] or "")
        s, r, _ = M.req("PUT", "/api/tasks/%d" % t["id"], body)
        self.assertEqual(s, 200, r)
        saved = next(x for x in M.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["no"] == 3)["progress"]
        first = saved.split("\n")[0]
        self.assertRegex(first, SIG % "Bob")
        self.assertTrue(first.endswith("Called the customer"))
        # the lead adding a line signs only that line
        L = T.lead
        body["progress"] = saved + "\nLead note"
        self.assertEqual(L.req("PUT", "/api/tasks/%d" % t["id"], body)[0], 200)
        lines = next(x for x in L.req("GET", "/api/teams/automation/tasks")[1]["tasks"] if x["no"] == 3)["progress"].split("\n")
        self.assertEqual(lines[0], first)
        self.assertRegex(lines[-1], SIG % "Alice")


if __name__ == "__main__":
    unittest.main()
