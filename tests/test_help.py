"""Help tab: the data model diagram must match the real schema, and the help files must be served.
Run: python -m unittest discover -s tests -v"""
import json
import os
import re
import sys
import unittest
import urllib.error
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "app"))
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402

HELP_JS = os.path.join(ROOT, "app", "static", "help_admin.js")


def schema_columns():
    tables = {}
    for name, body in re.findall(r"CREATE TABLE IF NOT EXISTS (\w+)\((.*?)\);", server.SCHEMA, re.S):
        cols = set()
        for part in re.split(r",\s*(?![^()]*\))", body):
            word = re.split(r"[\s(]", part.strip(), 1)[0] if part.strip() else ""
            if word and word.upper() not in ("UNIQUE", "PRIMARY", "FOREIGN", "CHECK"):
                cols.add(word)
        tables[name] = cols
    return tables


def diagram_columns():
    src = open(HELP_JS, encoding="utf-8").read()
    block = src[src.index("const ERD_TABLES"):src.index("const ERD_LINKS")]
    tables = {}
    for name, fields in re.findall(r'\{ n: "(\w+)".*?f: \[(.*?)\] \}', block, re.S):
        cols = set()
        for label in re.findall(r'\["([^"]+)", "[^"]*", "[^"]*"\]', fields):
            parts = [p.strip() for p in re.split(r"[,/]", label) if p.strip()]
            for i, p in enumerate(parts):
                # "target_set_by / _at" means target_set_by and target_set_at
                cols.add(parts[0].rsplit("_", 1)[0] + p if p.startswith("_") else p)
        tables[name] = cols
    return tables


class HelpTests(unittest.TestCase):
    def test_diagram_matches_schema(self):
        real, drawn = schema_columns(), diagram_columns()
        self.assertEqual(set(real), set(drawn), "tables in the Help diagram differ from SCHEMA")
        for t in real:
            self.assertEqual(real[t], drawn[t], "columns of %s in the Help diagram differ from SCHEMA" % t)

    @classmethod
    def setUpClass(cls):
        # reuse the admin, lead and member accounts that test_api creates
        if not hasattr(test_api.TrackerTest, "admin"):
            test_api.TrackerTest.setUpClass()
        cls.admin, cls.lead, cls.member = test_api.TrackerTest.admin, test_api.TrackerTest.lead, test_api.TrackerTest.member

    def test_readme_admin_only(self):
        s, r, _ = self.admin.req("GET", "/api/help/readme")
        self.assertEqual(s, 200)
        self.assertIn("Team Task Tracker", r["markdown"])
        self.assertEqual(self.lead.req("GET", "/api/help/readme")[0], 403)
        self.assertEqual(self.member.req("GET", "/api/help/readme")[0], 403)
        self.assertEqual(test_api.Client().req("GET", "/api/help/readme")[0], 401)

    def test_admin_help_script_admin_only(self):
        s, body, hd = self.admin.req("GET", "/api/help/admin.js", raw=True)
        self.assertEqual(s, 200)
        self.assertIn("javascript", hd["Content-Type"])
        self.assertIn(b"function helpArch", body)
        self.assertIn(b"function helpModel", body)
        self.assertEqual(self.lead.req("GET", "/api/help/admin.js")[0], 403)
        self.assertEqual(test_api.Client().req("GET", "/api/help/admin.js")[0], 401)
        # not reachable as a public static file either
        with self.assertRaises(urllib.error.HTTPError) as cm:
            urllib.request.urlopen(test_api.BASE + "/help_admin.js")
        self.assertEqual(cm.exception.code, 404)

    def test_user_guide_public(self):
        with urllib.request.urlopen(test_api.BASE + "/help.js") as r:
            body = r.read()
        self.assertIn(b"function helpGuide", body)
        self.assertNotIn(b"ERD_TABLES", body)  # admin content is not in the public file
        with urllib.request.urlopen(test_api.BASE + "/") as r:
            self.assertIn(b'src="/help.js"', r.read())


if __name__ == "__main__":
    unittest.main()
