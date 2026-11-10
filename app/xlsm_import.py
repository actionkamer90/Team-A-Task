"""Read a team's Daily Task Tracker workbook (.xlsm/.xlsx, the 2026 template) into the import format.

Sheets used: 'Daily Task Tracker' (open tasks), 'Archive' (completed tasks) and 'Customer' (optional).
Columns A-M: Task No, Categories, Main Task / Project, Task Progress, Task Percentage, Urgency, Customer,
Lead Engineer, Support Engineer, Start Date, Target Date, Actual Date, Status (Status is recalculated).
Standard library only; macros are never run.
"""
import datetime as dt
import posixpath
import re
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PNS = "{http://schemas.openxmlformats.org/package/2006/relationships}"
EPOCH = dt.date(1899, 12, 30)


def _sheets(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).iter(PNS + "Relationship")}
    out = {}
    for s in wb.iter(NS + "sheet"):
        t = rels[s.get(RNS + "id")]
        out[s.get("name").strip().lower()] = t.lstrip("/") if t.startswith("/") else posixpath.normpath(posixpath.join("xl", t))
    return out


def _rows(z, path, shared):
    rows = []
    for row in ET.fromstring(z.read(path)).iter(NS + "row"):
        rec = {}
        for c in row:
            col = re.match(r"[A-Z]+", c.get("r")).group()
            v = c.find(NS + "v")
            if c.get("t") == "inlineStr":
                rec[col] = "".join(t.text or "" for t in c.iter(NS + "t"))
            elif v is not None:
                rec[col] = shared[int(v.text)] if c.get("t") == "s" else v.text
        rows.append(rec)
    return rows


def _date(v, ctx, problems):
    if v in (None, ""):
        return None
    try:
        return (EPOCH + dt.timedelta(days=int(float(v)))).isoformat()
    except ValueError:
        pass
    m = re.match(r"^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*$", v)
    if m:
        try:
            return dt.date(int(m[3]), int(m[2]), int(m[1])).isoformat()
        except ValueError:
            pass
    problems.append("%s: '%s' is not a real date, left empty" % (ctx, v))
    return None


def read_workbook(path, team_name, lead_names=(), team_id=None):
    problems = []
    with zipfile.ZipFile(path) as z:
        shared = []
        if "xl/sharedStrings.xml" in z.namelist():
            shared = ["".join(t.text or "" for t in si.iter(NS + "t")) for si in ET.fromstring(z.read("xl/sharedStrings.xml"))]
        sheets = _sheets(z)
        for need in ("daily task tracker", "archive"):
            if need not in sheets:
                raise SystemExit("The workbook has no '%s' sheet." % need.title())
        customers = []
        if "customer" in sheets:
            customers = [r["A"].strip() for r in _rows(z, sheets["customer"], shared) if r.get("A", "").strip()]
        people, tasks, seen_no = {}, [], set()

        def ppl(v):
            keys = []
            for part in re.split(r"[/,&]|\band\b", v or ""):
                name = part.strip()
                if not name:
                    continue
                key = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:40] or "x"
                people.setdefault(key, name)
                if key not in keys:
                    keys.append(key)
            return keys

        for sheet in ("daily task tracker", "archive"):
            for i, r in enumerate(_rows(z, sheets[sheet], shared)[1:], start=2):
                title = (r.get("C") or "").strip()
                if not title:
                    continue
                ctx = "%s row %d" % (sheet.title(), i)
                try:
                    no = int(float(r.get("A") or 0))
                except ValueError:
                    no = 0
                if not no or no in seen_no:
                    problems.append("%s: task number '%s' missing or repeated, given a new number" % (ctx, r.get("A")))
                    no = 0
                seen_no.add(no)
                try:
                    pct = round(float(r.get("E") or 0) * 100)
                except ValueError:
                    pct = 0
                t = {"no": no, "category": (r.get("B") or "").strip() or "Internal", "title": title, "progress": (r.get("D") or "").strip(),
                     "percent": max(0, min(100, pct)), "urgency": (r.get("F") or "").strip() or "Medium", "customer": (r.get("G") or "").strip(),
                     "lead": ppl(r.get("H")), "support": ppl(r.get("I")), "startDate": _date(r.get("J"), ctx + " start date", problems),
                     "target": _date(r.get("K"), ctx + " target date", problems), "actualDate": _date(r.get("L"), ctx + " actual date", problems)}
                if sheet == "archive" and not t["actualDate"]:
                    problems.append("%s: archived task has no actual date" % ctx)
                tasks.append(t)
    nxt = max([t["no"] for t in tasks] + [0]) + 1
    for t in tasks:
        if not t["no"]:
            t["no"], nxt = nxt, nxt + 1
    leads = {n.strip().lower() for n in lead_names}
    for n in leads:
        if not any(v.lower() == n for v in people.values()):
            problems.append("Lead '%s' doesn't appear in the workbook; no lead set for them" % n)
    base = ["Pre-Sales", "Project", "Tickets", "Internal"]
    cats = base + sorted({t["category"] for t in tasks} - set(base))
    data = {"team": {"id": team_id or team_name, "name": team_name, "categories": cats, "customers": customers},
            "people": [{"key": k, "name": v, "role": "lead" if v.lower() in leads else "member"} for k, v in sorted(people.items(), key=lambda kv: kv[1].lower())],
            "tasks": tasks}
    return data, problems
