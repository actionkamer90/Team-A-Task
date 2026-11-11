"""Help tab: the data model diagram must match the real schema, and the help files must be served.
Run: python -m unittest discover -s tests -v"""
import json
import os
import re
import sys
import unittest
import urllib.request

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "app"))
import test_api  # noqa: E402  (starts the test server and sets TT_DB)
import server  # noqa: E402

HELP_JS = os.path.join(ROOT, "app", "static", "help.js")


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

    def test_readme_served_without_login(self):
        with urllib.request.urlopen(test_api.BASE + "/api/help/readme") as r:
            data = json.loads(r.read())
        self.assertIn("Team Task Tracker", data["markdown"])

    def test_help_script_served(self):
        with urllib.request.urlopen(test_api.BASE + "/help.js") as r:
            self.assertIn("javascript", r.headers["Content-Type"])
            self.assertIn(b"helpView", r.read())
        with urllib.request.urlopen(test_api.BASE + "/") as r:
            self.assertIn(b'src="/help.js"', r.read())


if __name__ == "__main__":
    unittest.main()
