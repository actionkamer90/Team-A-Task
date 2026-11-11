"""Team Task Tracker: a self-hosted, multi-team daily task tracker.

Standard library only (Python 3.9+): http.server + sqlite3. No packages to install.

Run:   python app/server.py serve
Admin: python app/server.py admin-link     (prints a one-time link to set or reset the admin password)
       python app/server.py backup FILE    (consistent copy of the database)
       python app/server.py import FILE    (create a team with its people and tasks from an import file)
       python app/server.py make-admin LOGIN   (give an existing account administrator access)
       python app/server.py invite-admin       (one-time link that creates a new administrator account)
       python app/server.py import-logos FOLDER_OR_ZIP --team-id ID [--replace] [--dry-run]
                                               (customer icons from PNG files named after the customers)
"""
import base64
import datetime as dt
import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import sys
import threading
import time
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import xlsx  # noqa: E402

DB_PATH = os.environ.get("TT_DB", os.path.join(HERE, "..", "data", "tracker.db"))
BASE_URL = os.environ.get("TT_BASE_URL", "").rstrip("/")
COOKIE_SECURE = os.environ.get("TT_COOKIE_SECURE", "0") == "1"
TRUST_PROXY = os.environ.get("TT_TRUST_PROXY", "0") == "1"
ARCHIVE_DAYS = int(os.environ.get("TT_ARCHIVE_DAYS", "2"))
SESSION_DAYS = 14
INVITE_DAYS = 7
MIN_PASSWORD = 10
STATIC = os.path.join(HERE, "static")


def _app_version():
    h = hashlib.sha256()
    for name in sorted(os.listdir(STATIC)):
        with open(os.path.join(STATIC, name), "rb") as f:
            h.update(f.read())
    return h.hexdigest()[:12]


APP_VERSION = _app_version()

URGENCIES = ["Low", "Medium", "High", "Critical"]
DEFAULT_CATS = ["Pre-Sales", "Project", "Tickets", "Internal"]
DEFAULT_KPI = {"onTime": 0.8, "early": 0.2, "excellent": 0.9, "good": 0.7, "needs": 0.6}
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

WRITE_LOCK = threading.Lock()


# ---------------------------------------------------------------- database
SCHEMA = """
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, login TEXT NOT NULL UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL,
  pw_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS teams(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, categories TEXT NOT NULL, customers TEXT NOT NULL, kpi TEXT NOT NULL, created_at TEXT NOT NULL,
  archive_days INTEGER);
CREATE TABLE IF NOT EXISTS people(
  id INTEGER PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, key TEXT NOT NULL, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('lead','member')), user_id INTEGER REFERENCES users(id), active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, is_pm INTEGER NOT NULL DEFAULT 0, UNIQUE(team_id, key));
CREATE TABLE IF NOT EXISTS invites(
  token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('invite','reset','setup')),
  person_id INTEGER REFERENCES people(id) ON DELETE CASCADE, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_by INTEGER, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
CREATE TABLE IF NOT EXISTS tasks(
  id INTEGER PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, no INTEGER NOT NULL,
  category TEXT NOT NULL, title TEXT NOT NULL, progress TEXT NOT NULL DEFAULT '', percent INTEGER NOT NULL DEFAULT 0,
  urgency TEXT NOT NULL, customer TEXT NOT NULL DEFAULT '', lead TEXT NOT NULL DEFAULT '[]', support TEXT NOT NULL DEFAULT '[]',
  start_date TEXT, requested_target TEXT, target TEXT, target_set_by INTEGER, target_set_at TEXT, actual_date TEXT,
  created_by INTEGER, created_at TEXT NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL, imported INTEGER NOT NULL DEFAULT 0,
  approved INTEGER NOT NULL DEFAULT 1, project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL,
  project_item_id INTEGER REFERENCES project_items(id) ON DELETE SET NULL, UNIQUE(team_id, no));
CREATE INDEX IF NOT EXISTS tasks_team ON tasks(team_id);
CREATE TABLE IF NOT EXISTS task_log(
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, at TEXT NOT NULL,
  user_id INTEGER, kind TEXT NOT NULL, changes TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS task_log_task ON task_log(task_id);
CREATE TABLE IF NOT EXISTS change_requests(
  id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('create','edit')), data TEXT NOT NULL, by_user INTEGER NOT NULL, at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','cancelled')), note TEXT,
  decided_by INTEGER, decided_at TEXT);
CREATE INDEX IF NOT EXISTS change_requests_team ON change_requests(team_id, status);
CREATE TABLE IF NOT EXISTS clients(
  name TEXT PRIMARY KEY COLLATE NOCASE, full_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS projects(
  id INTEGER PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, client TEXT NOT NULL DEFAULT '', name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', pm_person_id INTEGER REFERENCES people(id) ON DELETE SET NULL, start_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('Planned','Active','On Hold','Completed','Cancelled')),
  created_by INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS projects_team ON projects(team_id);
CREATE TABLE IF NOT EXISTS project_items(
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES project_items(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('phase','activity','milestone')), name TEXT NOT NULL, deliverable TEXT NOT NULL DEFAULT '',
  owner TEXT NOT NULL DEFAULT '', start_day INTEGER NOT NULL, end_day INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'Not Started' CHECK(status IN ('Not Started','In Progress','Completed','At Risk')), remarks TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS project_items_project ON project_items(project_id);
CREATE TABLE IF NOT EXISTS project_holidays(
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE, date TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
  PRIMARY KEY(project_id, date));
CREATE TABLE IF NOT EXISTS customer_logos(
  id INTEGER PRIMARY KEY, team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, name TEXT NOT NULL,
  png BLOB NOT NULL, updated_by INTEGER, updated_at TEXT NOT NULL, UNIQUE(team_id, name));
"""


def connect():
    con = sqlite3.connect(DB_PATH, timeout=15, isolation_level=None)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA foreign_keys=ON")
    con.execute("PRAGMA busy_timeout=15000")
    return con


def now_iso():
    return dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def today():
    return dt.date.today().isoformat()  # server local date; set TZ in docker-compose


def sha(s):
    return hashlib.sha256(s.encode()).hexdigest()


class Tx:
    """Serialised write transaction."""

    def __init__(self, con):
        self.con = con

    def __enter__(self):
        WRITE_LOCK.acquire()
        self.con.execute("BEGIN IMMEDIATE")
        return self.con

    def __exit__(self, et, ev, tb):
        try:
            self.con.execute("ROLLBACK" if et else "COMMIT")
        finally:
            WRITE_LOCK.release()
        return False


def init_db():
    os.makedirs(os.path.dirname(os.path.abspath(DB_PATH)), exist_ok=True)
    con = connect()
    con.executescript(SCHEMA)
    if "archive_days" not in {r["name"] for r in con.execute("PRAGMA table_info(teams)")}:  # per-team archive delay
        con.execute("ALTER TABLE teams ADD COLUMN archive_days INTEGER")
    if "is_pm" not in {r["name"] for r in con.execute("PRAGMA table_info(people)")}:  # Project Manager role
        con.execute("ALTER TABLE people ADD COLUMN is_pm INTEGER NOT NULL DEFAULT 0")
    task_cols = {r["name"] for r in con.execute("PRAGMA table_info(tasks)")}
    if "project_id" not in task_cols:  # daily tasks can name a project and one of its activities
        con.execute("ALTER TABLE tasks ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL")
    if "project_item_id" not in task_cols:
        con.execute("ALTER TABLE tasks ADD COLUMN project_item_id INTEGER REFERENCES project_items(id) ON DELETE SET NULL")
    cols = {r["name"] for r in con.execute("PRAGMA table_info(tasks)")}
    if "approved" not in cols:  # upgrade from the first release
        con.execute("ALTER TABLE tasks ADD COLUMN approved INTEGER NOT NULL DEFAULT 1")
    # Rule change: members' new tasks no longer need approval, only target dates do.
    for r in con.execute("SELECT r.id, t.requested_target, t.target FROM change_requests r JOIN tasks t ON t.id=r.task_id "
                         "WHERE r.kind='create' AND r.status='pending'").fetchall():
        if r["requested_target"] and not r["target"]:
            con.execute("UPDATE change_requests SET kind='edit', data=? WHERE id=?", (json.dumps({"target": r["requested_target"]}), r["id"]))
        else:
            con.execute("UPDATE change_requests SET status='cancelled' WHERE id=?", (r["id"],))
    con.execute("UPDATE tasks SET approved=1 WHERE approved=0")
    con.close()


def import_team(con, data):
    """Create one team with its people and tasks from an import file (see README: 'Import the Excel data').

    {"team": {"id", "name", "categories", "customers"}, "people": [{"key", "name", "role"}],
     "tasks": [{"no", "category", "title", "progress", "percent", "urgency", "customer", "lead": [keys], "support": [keys],
                "startDate", "target", "actualDate"}]}"""
    tm, ts = data["team"], now_iso()
    tid = slug(tm.get("id") or tm["name"])
    if con.execute("SELECT 1 FROM teams WHERE id=?", (tid,)).fetchone():
        raise SystemExit("Team '%s' already exists; nothing imported." % tid)
    keys = {p["key"] for p in data["people"]}
    for r in data["tasks"]:
        for k in r.get("lead", []) + r.get("support", []):
            if k not in keys:
                raise SystemExit("Task %s names '%s', who isn't in the people list." % (r.get("no"), k))
    with Tx(con):
        con.execute("INSERT INTO teams(id,name,categories,customers,kpi,created_at) VALUES(?,?,?,?,?,?)", (tid, tm["name"], json.dumps(tm.get("categories") or DEFAULT_CATS),
                                                              json.dumps(tm.get("customers") or []), json.dumps(DEFAULT_KPI), ts))
        for p in data["people"]:
            con.execute("INSERT INTO people(team_id,key,name,role,active,created_at) VALUES(?,?,?,?,1,?)",
                        (tid, p["key"], p["name"], "lead" if p.get("role") == "lead" else "member", ts))
        for r in data["tasks"]:
            con.execute(
                "INSERT INTO tasks(team_id,no,category,title,progress,percent,urgency,customer,lead,support,start_date,"
                "requested_target,target,actual_date,created_at,updated_at,imported) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
                (tid, r["no"], r.get("category") or "Internal", r["title"], r.get("progress") or "",
                 100 if r.get("actualDate") else int(r.get("percent") or 0), r.get("urgency") or "Medium", r.get("customer") or "",
                 json.dumps(r.get("lead", [])), json.dumps(r.get("support", [])), r.get("startDate"), r.get("target"), r.get("target"),
                 r.get("actualDate"), ts, ts))
    return tid, len(data["people"]), len(data["tasks"])


SYNC_FIELDS = [("category", "category"), ("title", "title"), ("progress", "progress"), ("percent", "percent"), ("urgency", "urgency"),
               ("customer", "customer"), ("lead", "lead"), ("support", "support"), ("startDate", "start_date"), ("actualDate", "actual_date")]


def sync_team(con, tid, data, dry_run=False):
    """Bring an existing team up to date from a newer copy of its workbook, matching tasks by task number.

    The workbook wins for every field, except that an empty or invalid target date in the workbook never erases a
    target already set in the tracker. Tasks missing from the workbook are kept and reported, never deleted.
    Changes are recorded in each task's history as coming from the Excel workbook."""
    if not con.execute("SELECT 1 FROM teams WHERE id=?", (tid,)).fetchone():
        raise SystemExit("No team with id '%s'." % tid)
    live = {}
    for r in con.execute("SELECT * FROM tasks WHERE team_id=?", (tid,)):
        t = dict(r)
        t["lead"], t["support"] = json.loads(t["lead"]), json.loads(t["support"])
        live[t["no"]] = t
    have = {r["key"] for r in con.execute("SELECT key FROM people WHERE team_id=?", (tid,))}
    report = {"updated": [], "added": [], "kept_target": [], "missing": sorted(set(live) - {t["no"] for t in data["tasks"]}),
              "new_people": [p["name"] for p in data["people"] if p["key"] not in have]}
    ts = now_iso()
    with Tx(con):
        for p in data["people"]:
            if p["key"] not in have:
                con.execute("INSERT INTO people(team_id,key,name,role,active,created_at) VALUES(?,?,?,'member',1,?)", (tid, p["key"], p["name"], ts))
        custs = json.loads(con.execute("SELECT customers FROM teams WHERE id=?", (tid,)).fetchone()[0])
        extra = [c for c in data["team"].get("customers", []) if c not in custs]
        if extra:
            con.execute("UPDATE teams SET customers=? WHERE id=?", (json.dumps(custs + extra), tid))
        for w in data["tasks"]:
            t = live.get(w["no"])
            if not t:
                cur = con.execute(
                    "INSERT INTO tasks(team_id,no,category,title,progress,percent,urgency,customer,lead,support,start_date,requested_target,"
                    "target,actual_date,created_at,updated_at,imported) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)",
                    (tid, w["no"], w["category"], w["title"], w["progress"], 100 if w["actualDate"] else w["percent"], w["urgency"], w["customer"],
                     json.dumps(w["lead"]), json.dumps(w["support"]), w["startDate"], w["target"], w["target"], w["actualDate"], ts, ts))
                con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,NULL,'create',?)", (cur.lastrowid, ts, "[]"))
                report["added"].append(w["no"])
                continue
            wv = dict(w, percent=100 if w["actualDate"] else w["percent"])
            changes, sets = [], {}
            for wf, lf in SYNC_FIELDS:
                if (wv[wf] or None) != (t[lf] or None) and not (lf in ("lead", "support") and sorted(wv[wf]) == sorted(t[lf])):
                    changes.append([lf] if lf == "progress" else [lf, cut(t[lf]), cut(wv[wf])])
                    sets[lf] = json.dumps(wv[wf]) if lf in ("lead", "support") else wv[wf]
            cur_target = t["target"] or t["requested_target"]
            new_target = w["target"]
            if not new_target and cur_target:
                report["kept_target"].append(w["no"])
            elif new_target != cur_target or (new_target and not t["target"]):
                if new_target != cur_target:
                    changes.append(["target", cur_target, new_target])
                sets.update(target=new_target, requested_target=new_target)
            if not changes:
                continue
            report["updated"].append(w["no"])
            sets["updated_at"] = ts
            con.execute("UPDATE tasks SET %s WHERE id=?" % ", ".join("%s=?" % k for k in sets), list(sets.values()) + [t["id"]])
            con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,NULL,'edit',?)", (t["id"], ts, json.dumps(changes)))
        if dry_run:
            raise _DryRun(report)
    return report


class _DryRun(Exception):
    def __init__(self, report):
        super().__init__("dry run")
        self.report = report


# ---------------------------------------------------------------- passwords
def hash_pw(pw):
    salt = secrets.token_bytes(16)
    dk = hashlib.scrypt(pw.encode(), salt=salt, n=2 ** 14, r=8, p=1, dklen=32)
    return "scrypt$%s$%s" % (salt.hex(), dk.hex())


def check_pw(pw, stored):
    try:
        _, salt, dk = stored.split("$")
        cand = hashlib.scrypt(pw.encode(), salt=bytes.fromhex(salt), n=2 ** 14, r=8, p=1, dklen=32)
        return hmac.compare_digest(cand.hex(), dk)
    except Exception:
        return False


DUMMY_HASH = hash_pw(secrets.token_hex(8))  # equalises timing for unknown logins


class RateLimit:
    def __init__(self, limit, window):
        self.limit, self.window, self.hits, self.lock = limit, window, {}, threading.Lock()

    def blocked(self, key):
        with self.lock:
            now = time.time()
            arr = [t for t in self.hits.get(key, []) if now - t < self.window]
            self.hits[key] = arr
            return len(arr) >= self.limit

    def add(self, key):
        with self.lock:
            self.hits.setdefault(key, []).append(time.time())

    def clear(self, key):
        with self.lock:
            self.hits.pop(key, None)


LOGIN_FAILS = RateLimit(5, 15 * 60)      # per (ip, login)
IP_FAILS = RateLimit(30, 15 * 60)        # per ip, any login / token


# ---------------------------------------------------------------- domain logic
def status_of(t, td=None):
    td = td or today()
    tg = t["target"] or t["requested_target"]
    if not t["actual_date"]:
        if not tg:
            return "No Target"
        return "Delay" if tg < td else "On-Going"
    if not tg:
        return "Completed"
    a = t["actual_date"]
    return "Completed Early" if a < tg else "Completed On Time" if a == tg else "Completed Late"


ARCHIVE_DAYS_MAX = 90


def team_archive_days(con, tid):
    """Days after the actual (completed) date before a task counts as archived: the team's setting, else TT_ARCHIVE_DAYS."""
    r = con.execute("SELECT archive_days FROM teams WHERE id=?", (tid,)).fetchone()
    return ARCHIVE_DAYS if not r or r["archive_days"] is None else r["archive_days"]


def is_archived(t, td=None):
    if not t["actual_date"]:
        return False
    d = dt.date.fromisoformat(td or today()) - dt.date.fromisoformat(t["actual_date"])
    return d.days >= t.get("_archive_days", ARCHIVE_DAYS)


def rating(score, c):
    if score >= c["excellent"]:
        return "Excellent"
    if score >= c["good"]:
        return "Good"
    if score >= c["needs"]:
        return "Needs Improvement"
    return "At Risk"


def compute_kpi(team, tasks, people, frm, to):
    """Same scoring as the workbook's 'KPI Dashboard (Weighted)' sheet: each lead and support
    involvement counts individually; KPI = onTime * total on-time % + early * early %."""
    c = dict(DEFAULT_KPI, **team["kpi"])
    cats = team["categories"]
    done = [t for t in tasks if t["actual_date"] and frm <= t["actual_date"] <= to]
    st = {t["id"]: status_of(t) for t in done}
    on_t = lambda t: st[t["id"]] in ("Completed On Time", "Completed Early", "Completed")
    late = lambda t: st[t["id"]] == "Completed Late"
    early = lambda t: st[t["id"]] == "Completed Early"
    names = {p["key"]: p["name"] for p in people}
    # One row per current team member. Removed people and disabled accounts get no row,
    # but their completed tasks still count in the team totals below.
    keys = set(p["key"] for p in people if p["active"] and not p.get("user_disabled"))

    def row(name, L, S):
        C, D = len(L), len(S)
        E = C + D
        F, G = sum(map(on_t, L)), sum(map(late, L))
        I, J = sum(map(on_t, S)), sum(map(late, S))
        M = sum(map(early, L)) + sum(map(early, S))
        Lp = (E - G - J) / E if E else 0
        Np = M / E if E else 0
        O = c["onTime"] * Lp + c["early"] * Np if E else 0
        return {"name": name, "C": C, "D": D, "E": E, "F": F, "G": G, "H": F / C if C else 0, "I": I, "J": J,
                "K": I / D if D else 0, "L": Lp, "M": M, "N": Np, "O": O, "rating": rating(O, c) if E else "No Data"}

    rows = []
    for k in keys:
        L = [t for t in done if k in t["lead"]]
        S = [t for t in done if k in t["support"]]
        r = row(names.get(k, k), L, S)
        r["key"] = k
        r["cats"] = {cat: sum(1 for t in L if t["category"] == cat) for cat in cats}
        rows.append(r)
    rows.sort(key=lambda r: (-r["E"], r["name"].lower()))
    team_sup = lambda t: any(not k.startswith("ext:") for k in t["support"])  # people outside the team don't count
    with_sup = [t for t in done if team_sup(t)]
    team_row = row("Team", done, with_sup)
    team_row["M"] = sum(1 + (1 if team_sup(t) else 0) for t in done if early(t))
    team_row["N"] = team_row["M"] / team_row["E"] if team_row["E"] else 0
    team_row["O"] = c["onTime"] * team_row["L"] + c["early"] * team_row["N"] if team_row["E"] else 0
    team_row["rating"] = rating(team_row["O"], c) if team_row["E"] else "No Data"
    late_days = [(dt.date.fromisoformat(t["actual_date"]) - dt.date.fromisoformat(t["target"] or t["requested_target"])).days
                 for t in done if late(t)]
    return {"config": c, "from": frm, "to": to, "rows": rows, "team": team_row, "categories": cats,
            "avgDaysLate": sum(late_days) / len(late_days) if late_days else 0}


def slug(s):
    s = re.sub(r"[^a-z0-9]+", "-", (s or "").lower()).strip("-")
    return s[:40] or "x"


# ---------------------------------------------------------------- HTTP
class ApiError(Exception):
    def __init__(self, status, msg):
        super().__init__(msg)
        self.status, self.msg = status, msg


def bad(msg):
    return ApiError(400, msg)


FORBIDDEN = ApiError(403, "You don't have permission to do that.")
NOT_FOUND = ApiError(404, "Not found.")

STATIC_FILES = {"/": ("index.html", "text/html; charset=utf-8"), "/app.js": ("app.js", "text/javascript; charset=utf-8"),
                "/app.css": ("app.css", "text/css; charset=utf-8"), "/favicon.svg": ("favicon.svg", "image/svg+xml"),
                "/help.js": ("help.js", "text/javascript; charset=utf-8"), "/projects.js": ("projects.js", "text/javascript; charset=utf-8")}
SEC_HEADERS = {
    "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; "
                               "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
    "Cross-Origin-Opener-Policy": "same-origin",
}

ROUTES = []


def route(method, pattern):
    rx = re.compile("^" + pattern + "$")

    def deco(fn):
        ROUTES.append((method, rx, fn))
        return fn
    return deco


class Handler(BaseHTTPRequestHandler):
    server_version = "TeamTaskTracker"
    sys_version = ""
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # keep tokens out of logs: we only log method + path (no query/fragment)
        sys.stderr.write("%s %s %s\n" % (self.client_ip(), self.command, urlsplit(self.path).path))

    def client_ip(self):
        if TRUST_PROXY:
            xff = self.headers.get("X-Forwarded-For", "")
            if xff:
                return xff.split(",")[0].strip()
        return self.client_address[0]

    # --- plumbing
    def send(self, status, body=b"", ctype="application/json; charset=utf-8", extra=None):
        self.send_response(status)
        for k, v in SEC_HEADERS.items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("X-App-Version", APP_VERSION)
        self.send_header("Content-Length", str(len(body)))
        if not any(k.lower() == "cache-control" for k, _ in (extra or [])):
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def json(self, status, obj, extra=None):
        self.send(status, json.dumps(obj).encode(), extra=extra)

    def do_GET(self):
        self.dispatch("GET")

    def do_HEAD(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        u = urlsplit(self.path)
        self.query = {k: v[0] for k, v in parse_qs(u.query).items()}
        self.cookies_out = []
        path = u.path
        if method == "GET" and path in STATIC_FILES:
            name, ctype = STATIC_FILES[path]
            with open(os.path.join(STATIC, name), "rb") as f:
                return self.send(200, f.read(), ctype)
        if not path.startswith("/api/"):
            return self.send(404, b"Not found", "text/plain")
        con = connect()
        try:
            if method != "GET":
                # CSRF defence: only our own scripts send this header and JSON; cookie is SameSite=Strict too.
                if self.headers.get("X-Requested-With") != "tt" or "application/json" not in (self.headers.get("Content-Type") or ""):
                    raise ApiError(403, "Request blocked.")
                n = int(self.headers.get("Content-Length") or 0)
                if n > 1_000_000:
                    raise ApiError(413, "Request too large.")
                raw = self.rfile.read(n) if n else b"{}"
                try:
                    self.body = json.loads(raw or b"{}")
                except ValueError:
                    raise bad("Invalid JSON.")
                if not isinstance(self.body, dict):
                    raise bad("Invalid JSON.")
            else:
                self.body = {}
            self.con = con
            self.user = self.load_user()
            for m, rx, fn in ROUTES:
                if m == method:
                    mt = rx.match(path)
                    if mt:
                        res = fn(self, *mt.groups())
                        if isinstance(res, tuple) and res and res[0] == "raw":
                            return self.send(200, res[1], res[2], list(res[3] if len(res) > 3 else []) + self.cookies_out)
                        if isinstance(res, tuple) and res and res[0] == "file":
                            _, data, ctype, fname = res
                            return self.send(200, data, ctype, [("Content-Disposition", 'attachment; filename="%s"' % fname)] + self.cookies_out)
                        return self.json(200, res if res is not None else {"ok": True}, self.cookies_out)
            raise NOT_FOUND
        except ApiError as e:
            self.json(e.status, {"error": e.msg}, getattr(self, "cookies_out", None))
        except Exception as e:  # pragma: no cover
            sys.stderr.write("ERROR %r\n" % (e,))
            import traceback
            traceback.print_exc()
            self.json(500, {"error": "Something went wrong on the server."})
        finally:
            con.close()

    # --- auth
    def load_user(self):
        c = SimpleCookie(self.headers.get("Cookie") or "")
        tok = c.get("tt_session")
        if not tok:
            return None
        row = self.con.execute(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.disabled=0",
            (sha(tok.value), now_iso())).fetchone()
        return dict(row) if row else None

    def need_user(self):
        if not self.user:
            raise ApiError(401, "Please log in.")
        return self.user

    def start_session(self, user_id):
        tok = secrets.token_urlsafe(32)
        exp = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=SESSION_DAYS)).replace(microsecond=0).isoformat()
        self.con.execute("INSERT INTO sessions VALUES(?,?,?,?)", (sha(tok), user_id, now_iso(), exp))
        self.con.execute("DELETE FROM sessions WHERE expires_at<?", (now_iso(),))
        self.cookies_out.append(("Set-Cookie", "tt_session=%s; Path=/; HttpOnly; SameSite=Strict; Max-Age=%d%s"
                                 % (tok, SESSION_DAYS * 86400, "; Secure" if COOKIE_SECURE else "")))

    # --- access helpers
    def team(self, tid):
        r = self.con.execute("SELECT * FROM teams WHERE id=?", (tid,)).fetchone()
        if not r:
            raise NOT_FOUND
        t = dict(r)
        t["categories"], t["customers"], t["kpi"] = json.loads(t["categories"]), json.loads(t["customers"]), json.loads(t["kpi"])
        return t

    def my_person(self, tid):
        u = self.need_user()
        r = self.con.execute("SELECT * FROM people WHERE team_id=? AND user_id=? AND active=1", (tid, u["id"])).fetchone()
        return dict(r) if r else None

    def role(self, tid):
        u = self.need_user()
        if u["is_admin"]:
            return "admin"
        p = self.my_person(tid)
        return p["role"] if p else None

    def need_member(self, tid):
        self.team(tid)
        r = self.role(tid)
        if not r:
            raise FORBIDDEN
        return r

    def need_lead(self, tid):
        r = self.need_member(tid)
        if r not in ("lead", "admin"):
            raise FORBIDDEN
        return r

    def base_url(self):
        if BASE_URL:
            return BASE_URL
        proto = self.headers.get("X-Forwarded-Proto", "http") if TRUST_PROXY else "http"
        return "%s://%s" % (proto, self.headers.get("Host", "localhost"))


# ---------------------------------------------------------------- validation
def s_field(body, key, maxlen, required=False, default=""):
    v = body.get(key, default)
    if v is None:
        v = ""
    if not isinstance(v, str):
        raise bad("%s must be text." % key)
    v = v.strip()
    if required and not v:
        raise bad("%s is required." % key)
    if len(v) > maxlen:
        raise bad("%s is too long (max %d characters)." % (key, maxlen))
    return v


def d_field(body, key):
    v = body.get(key)
    if v in (None, ""):
        return None
    if not isinstance(v, str) or not DATE_RE.match(v):
        raise bad("%s must be a date (YYYY-MM-DD)." % key)
    try:
        dt.date.fromisoformat(v)
    except ValueError:
        raise bad("%s is not a real date." % key)
    return v


def pw_field(body):
    pw = body.get("password")
    if not isinstance(pw, str) or len(pw) < MIN_PASSWORD:
        raise bad("Use a password of at least %d characters." % MIN_PASSWORD)
    if len(pw) > 200:
        raise bad("That password is too long.")
    return pw


# ---------------------------------------------------------------- routes: auth & invites
def _readme_path():
    # In the container the README is copied next to server.py; in a checkout it is one folder up.
    for p in (os.path.join(HERE, "README.md"), os.path.join(HERE, "..", "README.md")):
        if os.path.isfile(p):
            return p
    return None


def need_admin(h):
    u = h.need_user()
    if not u["is_admin"]:
        raise FORBIDDEN
    return u


@route("GET", "/api/help/readme")
def api_help_readme(h):
    # Setup guide: administrators only. The user guide (help.js) is public and needs no route.
    need_admin(h)
    p = _readme_path()
    if not p:
        raise NOT_FOUND
    with open(p, encoding="utf-8") as f:
        return {"markdown": f.read()}


@route("GET", "/api/help/admin.js")
def api_help_admin_js(h):
    # Data model, Architecture and Setup guide sections: only sent to administrators.
    need_admin(h)
    with open(os.path.join(STATIC, "help_admin.js"), "rb") as f:
        return ("raw", f.read(), "text/javascript; charset=utf-8")


@route("GET", "/api/me")
def api_me(h):
    if not h.user:
        has_admin = h.con.execute("SELECT 1 FROM users WHERE is_admin=1").fetchone() is not None
        return {"user": None, "setupNeeded": not has_admin}
    u = h.user
    if u["is_admin"]:
        # teams the admin is also a member of come first, so they open on their own team
        teams = h.con.execute("SELECT t.id, t.name FROM teams t ORDER BY EXISTS(SELECT 1 FROM people p WHERE p.team_id=t.id "
                              "AND p.user_id=? AND p.active=1) DESC, t.name", (u["id"],)).fetchall()
        roles = {t["id"]: "admin" for t in teams}
    else:
        teams = h.con.execute("SELECT t.id,t.name,p.role FROM people p JOIN teams t ON t.id=p.team_id "
                              "WHERE p.user_id=? AND p.active=1 ORDER BY t.name", (u["id"],)).fetchall()
        roles = {t["id"]: t["role"] for t in teams}
    return {"user": {"id": u["id"], "login": u["login"], "name": u["display_name"], "isAdmin": bool(u["is_admin"])},
            "teams": [{"id": t["id"], "name": t["name"], "role": roles[t["id"]]} for t in teams],
            "today": today(), "archiveDays": ARCHIVE_DAYS}


def verify_login(h, login, pw):
    """Check a login and password with rate limiting; return the user id."""
    login = (login if isinstance(login, str) else "").strip().lower()[:120]
    pw = pw if isinstance(pw, str) else ""
    ip = h.client_ip()
    if LOGIN_FAILS.blocked((ip, login)) or IP_FAILS.blocked(ip):
        raise ApiError(429, "Too many failed attempts. Wait 15 minutes and try again.")
    row = h.con.execute("SELECT * FROM users WHERE login=? AND disabled=0", (login,)).fetchone()
    if not check_pw(pw, row["pw_hash"] if row else DUMMY_HASH) or not row:
        LOGIN_FAILS.add((ip, login))
        IP_FAILS.add(ip)
        raise ApiError(401, "That login and password don't match.")
    LOGIN_FAILS.clear((ip, login))
    return row["id"]


@route("POST", "/api/login")
def api_login(h):
    login = s_field(h.body, "login", 120, True).lower()
    pw = h.body.get("password") or ""
    ip = h.client_ip()
    if LOGIN_FAILS.blocked((ip, login)) or IP_FAILS.blocked(ip):
        raise ApiError(429, "Too many failed attempts. Wait 15 minutes and try again.")
    row = h.con.execute("SELECT * FROM users WHERE login=? AND disabled=0", (login,)).fetchone()
    if not row or not check_pw(pw if isinstance(pw, str) else "", row["pw_hash"] if row else DUMMY_HASH):
        LOGIN_FAILS.add((ip, login))
        IP_FAILS.add(ip)
        raise ApiError(401, "That login and password don't match.")
    LOGIN_FAILS.clear((ip, login))
    with Tx(h.con):
        h.start_session(row["id"])
    return {"ok": True}


@route("POST", "/api/logout")
def api_logout(h):
    tok = SimpleCookie(h.headers.get("Cookie") or "").get("tt_session")
    if tok:
        with Tx(h.con):
            h.con.execute("DELETE FROM sessions WHERE token_hash=?", (sha(tok.value),))
    h.cookies_out.append(("Set-Cookie", "tt_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"))
    return {"ok": True}


@route("POST", "/api/password")
def api_password(h):
    u = h.need_user()
    if not check_pw(h.body.get("current") or "", u["pw_hash"]):
        raise bad("Your current password is wrong.")
    pw = pw_field(h.body)
    with Tx(h.con):
        h.con.execute("UPDATE users SET pw_hash=? WHERE id=?", (hash_pw(pw), u["id"]))
        h.con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))
        h.start_session(u["id"])
    return {"ok": True}


def load_invite(h, token):
    if not isinstance(token, str) or not token or len(token) > 100:
        raise bad("This link isn't valid.")
    ip = h.client_ip()
    if IP_FAILS.blocked(ip):
        raise ApiError(429, "Too many attempts. Wait 15 minutes and try again.")
    r = h.con.execute("SELECT * FROM invites WHERE token_hash=?", (sha(token),)).fetchone()
    if not r:
        IP_FAILS.add(ip)
        raise ApiError(404, "This link isn't valid. Ask your team lead for a new one.")
    if r["used_at"]:
        raise ApiError(410, "This link has already been used. Ask your team lead for a new one if you need it.")
    if r["expires_at"] < now_iso():
        raise ApiError(410, "This link has expired. Ask your team lead for a new one.")
    return dict(r)


@route("POST", "/api/invite/info")
def api_invite_info(h):
    inv = load_invite(h, h.body.get("token"))
    out = {"kind": inv["kind"]}
    if inv["person_id"]:
        p = h.con.execute("SELECT p.*, t.name AS team_name FROM people p JOIN teams t ON t.id=p.team_id WHERE p.id=?",
                          (inv["person_id"],)).fetchone()
        out.update(team=p["team_name"], name=p["name"], role=p["role"])
    uid = inv["user_id"]
    if uid:
        out["login"] = h.con.execute("SELECT login FROM users WHERE id=?", (uid,)).fetchone()["login"]
    if h.user:
        out["loggedInAs"] = h.user["login"]
    return out


@route("POST", "/api/invite/accept")
def api_invite_accept(h):
    with Tx(h.con):
        inv = load_invite(h, h.body.get("token"))
        kind, uid = inv["kind"], inv["user_id"]
        if kind == "invite" and (h.body.get("useCurrent") or h.body.get("existingLogin")):
            if h.body.get("existingLogin"):
                uid = verify_login(h, h.body.get("existingLogin"), h.body.get("existingPassword"))
            else:
                uid = h.need_user()["id"]
            person = h.con.execute("SELECT * FROM people WHERE id=?", (inv["person_id"],)).fetchone()
            if h.con.execute("SELECT 1 FROM people WHERE team_id=? AND user_id=? AND active=1 AND id<>?",
                             (person["team_id"], uid, person["id"])).fetchone():
                raise bad("Your account is already on this team under another name. Ask your lead to remove the duplicate.")
        elif kind in ("invite", "setup"):
            pw = pw_field(h.body)
            login = s_field(h.body, "login", 120, True).lower()
            if not re.match(r"^[a-z0-9._@+-]{3,120}$", login):
                raise bad("Use 3 or more letters, digits or . _ @ + - for your login (your work email is a good choice).")
            name = s_field(h.body, "name", 80, True)
            if h.con.execute("SELECT 1 FROM users WHERE login=?", (login,)).fetchone():
                raise bad("That login is taken. If it's yours, log in first and then open the invite link again.")
            cur = h.con.execute("INSERT INTO users(login,display_name,pw_hash,is_admin,created_at) VALUES(?,?,?,?,?)",
                                (login, name, hash_pw(pw), 1 if kind == "setup" else 0, now_iso()))
            uid = cur.lastrowid
        elif kind == "reset":
            pw = pw_field(h.body)
            h.con.execute("UPDATE users SET pw_hash=?, disabled=0 WHERE id=?", (hash_pw(pw), uid))
            h.con.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        if kind == "invite":
            h.con.execute("UPDATE people SET user_id=?, active=1 WHERE id=?", (uid, inv["person_id"]))
        h.con.execute("UPDATE invites SET used_at=? WHERE token_hash=?", (now_iso(), inv["token_hash"]))
        if inv["person_id"]:
            h.con.execute("DELETE FROM invites WHERE person_id=? AND used_at IS NULL", (inv["person_id"],))
        h.start_session(uid)
    return {"ok": True}


def make_link(h, kind, person_id=None, user_id=None, created_by=None):
    tok = secrets.token_urlsafe(32)
    exp = (dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=INVITE_DAYS)).replace(microsecond=0).isoformat()
    if person_id:
        h.con.execute("DELETE FROM invites WHERE person_id=? AND used_at IS NULL", (person_id,))
    if user_id and kind in ("reset", "setup"):
        h.con.execute("DELETE FROM invites WHERE user_id=? AND used_at IS NULL", (user_id,))
    h.con.execute("INSERT INTO invites(token_hash,kind,person_id,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)",
                  (sha(tok), kind, person_id, user_id, created_by, now_iso(), exp))
    return tok, exp


# ---------------------------------------------------------------- routes: teams & people
def person_out(r, invites):
    inv = invites.get(r["id"])
    pm = "is_pm" in r.keys() and r["is_pm"] and r["role"] == "member"
    return {"id": r["id"], "key": r["key"], "name": r["name"], "role": "pm" if pm else r["role"], "active": bool(r["active"]),
            "joined": r["user_id"] is not None, "login": r["login"], "inviteExpires": inv}


def people_rows(h, tid):
    return h.con.execute("SELECT p.*, u.login, COALESCE(u.disabled, 0) AS user_disabled FROM people p LEFT JOIN users u ON u.id=p.user_id WHERE p.team_id=? "
                         "ORDER BY p.active DESC, p.role='lead' DESC, p.name COLLATE NOCASE", (tid,)).fetchall()


@route("GET", "/api/teams/([a-z0-9-]+)")
def api_team(h, tid):
    role = h.need_member(tid)
    t = h.team(tid)
    me = h.my_person(tid)
    invites = {}
    if role in ("lead", "admin"):
        for r in h.con.execute("SELECT i.person_id, i.expires_at FROM invites i JOIN people p ON p.id=i.person_id "
                               "WHERE p.team_id=? AND i.used_at IS NULL AND i.expires_at>?", (tid, now_iso())):
            invites[r["person_id"]] = r["expires_at"]
    ppl = [person_out(r, invites) for r in people_rows(h, tid)]
    if role not in ("lead", "admin"):
        for p in ppl:
            p.pop("login")
            p.pop("inviteExpires")
    logos = {r["name"]: "/api/teams/%s/logos/%d?v=%s" % (tid, r["id"], re.sub(r"\D", "", r["updated_at"]))
             for r in h.con.execute("SELECT id, name, updated_at FROM customer_logos WHERE team_id=?", (tid,))}
    return {"id": t["id"], "name": t["name"], "categories": t["categories"], "customers": t["customers"], "kpi": dict(DEFAULT_KPI, **t["kpi"]),
            "role": role, "myKey": me["key"] if me else None, "people": ppl, "urgencies": URGENCIES, "logos": logos,
            "archiveDays": team_archive_days(h.con, tid), "archiveDaysDefault": ARCHIVE_DAYS,
            "isPm": bool(me and me.get("is_pm")) if isinstance(me, dict) else False, "canCreateProjects": can_create_projects(h, tid)}


# ---- customer logos: small PNG icons shown beside customer names
LOGO_MAX_BYTES = 64 * 1024
LOGO_MAX_PX = 256


def check_png(raw):
    if len(raw) > LOGO_MAX_BYTES:
        raise bad("The logo is too large. Use an image under %d KB." % (LOGO_MAX_BYTES // 1024))
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or raw[12:16] != b"IHDR":
        raise bad("The logo must be a PNG image.")
    w, h = int.from_bytes(raw[16:20], "big"), int.from_bytes(raw[20:24], "big")
    if not (0 < w <= LOGO_MAX_PX and 0 < h <= LOGO_MAX_PX):
        raise bad("The logo must be at most %d × %d pixels." % (LOGO_MAX_PX, LOGO_MAX_PX))
    return raw


@route("PUT", "/api/teams/([a-z0-9-]+)/logos")
def api_logo_put(h, tid):
    h.need_lead(tid)
    name = s_field(h.body, "name", 100, True)
    data = h.body.get("png")
    if not isinstance(data, str) or len(data) > LOGO_MAX_BYTES * 2:
        raise bad("png must be base64 text.")
    try:
        raw = base64.b64decode(data.split(",", 1)[-1], validate=True)
    except ValueError:
        raise bad("png must be base64 text.")
    check_png(raw)
    with Tx(h.con):
        h.con.execute("INSERT INTO customer_logos(team_id,name,png,updated_by,updated_at) VALUES(?,?,?,?,?) "
                      "ON CONFLICT(team_id,name) DO UPDATE SET png=excluded.png, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                      (tid, name, raw, h.user["id"], now_iso()))
    return {"ok": True}


@route("DELETE", "/api/teams/([a-z0-9-]+)/logos")
def api_logo_delete(h, tid):
    h.need_lead(tid)
    name = s_field(h.body, "name", 100, True)
    with Tx(h.con):
        h.con.execute("DELETE FROM customer_logos WHERE team_id=? AND name=?", (tid, name))
    return {"ok": True}


@route("GET", "/api/teams/([a-z0-9-]+)/logos/([0-9]+)")
def api_logo_get(h, tid, lid):
    h.need_member(tid)
    r = h.con.execute("SELECT png FROM customer_logos WHERE id=? AND team_id=?", (int(lid), tid)).fetchone()
    if not r:
        raise NOT_FOUND
    # the URL changes whenever the logo changes (?v=), so the browser may keep it for a day
    return ("raw", bytes(r["png"]), "image/png", [("Cache-Control", "private, max-age=86400")])


@route("POST", "/api/teams")
def api_team_create(h):
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    name = s_field(h.body, "name", 80, True)
    cats, custs = list_field(h.body, "categories", 30, 60) or DEFAULT_CATS, list_field(h.body, "customers", 300, 100)
    with Tx(h.con):
        tid = slug(name)
        while h.con.execute("SELECT 1 FROM teams WHERE id=?", (tid,)).fetchone():
            tid += "-2"
        h.con.execute("INSERT INTO teams(id,name,categories,customers,kpi,created_at) VALUES(?,?,?,?,?,?)", (tid, name, json.dumps(cats), json.dumps(custs), json.dumps(DEFAULT_KPI), now_iso()))
    return {"id": tid}


def list_field(body, key, maxn, maxlen):
    v = body.get(key)
    if v is None:
        return []
    if not isinstance(v, list) or len(v) > maxn or not all(isinstance(x, str) for x in v):
        raise bad("%s must be a list of up to %d items." % (key, maxn))
    out = []
    for x in v:
        x = x.strip()
        if x and x not in out:
            if len(x) > maxlen:
                raise bad("An item in %s is too long." % key)
            out.append(x)
    return out


@route("PUT", "/api/teams/([a-z0-9-]+)")
def api_team_update(h, tid):
    h.need_lead(tid)
    t = h.team(tid)
    name = s_field(h.body, "name", 80, True, t["name"])
    cats = list_field(h.body, "categories", 30, 60) if "categories" in h.body else t["categories"]
    custs = list_field(h.body, "customers", 300, 100) if "customers" in h.body else t["customers"]
    if not cats:
        raise bad("Add at least one category.")
    kpi = t["kpi"]
    if "kpi" in h.body:
        k = h.body["kpi"]
        try:
            kpi = {x: float(k[x]) for x in DEFAULT_KPI}
        except (TypeError, KeyError, ValueError):
            raise bad("KPI settings are incomplete.")
        if any(not 0 <= v <= 1 for v in kpi.values()):
            raise bad("KPI values must be between 0% and 100%.")
        if abs(kpi["onTime"] + kpi["early"] - 1) > 1e-6:
            raise bad("The two weights must add up to 100%.")
        if not kpi["excellent"] > kpi["good"] > kpi["needs"]:
            raise bad("Thresholds must go Excellent > Good > Needs Improvement.")
    days = t.get("archive_days")
    if "archiveDays" in h.body:
        v = h.body["archiveDays"]
        if v is None or v == "":
            days = None  # back to the server default
        else:
            try:
                days = int(v)
            except (TypeError, ValueError):
                raise bad("Archive after must be a whole number of days.")
            if not 0 <= days <= ARCHIVE_DAYS_MAX or str(v).strip() not in (str(days),):
                raise bad("Archive after must be a whole number of days from 0 to %d." % ARCHIVE_DAYS_MAX)
    with Tx(h.con):
        h.con.execute("UPDATE teams SET name=?, categories=?, customers=?, kpi=?, archive_days=? WHERE id=?",
                      (name, json.dumps(cats), json.dumps(custs), json.dumps(kpi), days, tid))
    return {"ok": True}


def check_role_change(h, tid, role, person=None):
    """Leads manage members; only the admin creates leads or edits a lead's record."""
    my = h.role(tid)
    if my == "admin":
        return
    if role == "lead" or (person and person["role"] == "lead"):
        raise ApiError(403, "Only the administrator can add or change team leads.")


@route("POST", "/api/teams/([a-z0-9-]+)/people")
def api_person_add(h, tid):
    h.need_lead(tid)
    name = s_field(h.body, "name", 60, True)
    role = h.body.get("role", "member")
    if role not in ("lead", "member", "pm"):
        raise bad("Role must be lead, pm or member.")
    is_pm = 1 if role == "pm" else 0
    role = "member" if role == "pm" else role  # a Project Manager is a member who can also run projects
    check_role_change(h, tid, role)
    uid = None
    login = s_field(h.body, "login", 120).lower()
    if login:
        u = h.con.execute("SELECT id FROM users WHERE login=? AND disabled=0", (login,)).fetchone()
        if not u:
            raise bad("No account uses the login '%s'. Leave Login empty and send an invite link instead." % login)
        uid = u["id"]
        if h.con.execute("SELECT 1 FROM people WHERE team_id=? AND user_id=? AND active=1", (tid, uid)).fetchone():
            raise bad("That account is already on this team.")
    with Tx(h.con):
        key = slug(name)
        while h.con.execute("SELECT 1 FROM people WHERE team_id=? AND key=?", (tid, key)).fetchone():
            key += "-2"
        cur = h.con.execute("INSERT INTO people(team_id,key,name,role,user_id,active,created_at,is_pm) VALUES(?,?,?,?,?,1,?,?)",
                            (tid, key, name, role, uid, now_iso(), is_pm))
    return {"id": cur.lastrowid, "key": key, "joined": uid is not None}


def get_person(h, tid, pid):
    r = h.con.execute("SELECT * FROM people WHERE id=? AND team_id=?", (int(pid), tid)).fetchone()
    if not r:
        raise NOT_FOUND
    return dict(r)


@route("PUT", "/api/teams/([a-z0-9-]+)/people/([0-9]+)")
def api_person_update(h, tid, pid):
    h.need_lead(tid)
    p = get_person(h, tid, pid)
    role = h.body.get("role", "pm" if p.get("is_pm") and p["role"] == "member" else p["role"])
    if role not in ("lead", "member", "pm"):
        raise bad("Role must be lead, pm or member.")
    is_pm = 1 if role == "pm" else 0
    role = "member" if role == "pm" else role
    if role != p["role"] or p["role"] == "lead":
        check_role_change(h, tid, role, p)
    name = s_field(h.body, "name", 60, True, p["name"])
    active = 1 if h.body.get("active", bool(p["active"])) else 0
    if not active and p["user_id"] == h.user["id"]:
        raise bad("You can't remove yourself from the team.")
    uid = p["user_id"]
    login = s_field(h.body, "login", 120).lower()
    if login and not uid:
        # link a name already on the team (e.g. from an Excel import) to the account the person uses in another team
        u = h.con.execute("SELECT id FROM users WHERE login=? AND disabled=0", (login,)).fetchone()
        if not u:
            raise bad("No account uses the login '%s'. Check the spelling, or send an invite link instead." % login)
        if h.con.execute("SELECT 1 FROM people WHERE team_id=? AND user_id=? AND active=1 AND id<>?", (tid, u["id"], p["id"])).fetchone():
            raise bad("That account is already on this team under another name.")
        uid = u["id"]
    with Tx(h.con):
        h.con.execute("UPDATE people SET name=?, role=?, active=?, user_id=?, is_pm=? WHERE id=?", (name, role, active, uid, is_pm, p["id"]))
        if uid and not p["user_id"]:
            h.con.execute("DELETE FROM invites WHERE person_id=? AND used_at IS NULL", (p["id"],))
        if not active:
            h.con.execute("DELETE FROM invites WHERE person_id=? AND used_at IS NULL", (p["id"],))
    return {"ok": True}


@route("POST", "/api/teams/([a-z0-9-]+)/people/([0-9]+)/link")
def api_person_link(h, tid, pid):
    """Create a one-time link: an invitation (not joined yet) or a password reset (already joined)."""
    h.need_lead(tid)
    p = get_person(h, tid, pid)
    check_role_change(h, tid, p["role"], p)
    if not p["active"]:
        raise bad("Add this person back to the team first.")
    with Tx(h.con):
        if p["user_id"]:
            u = h.con.execute("SELECT is_admin FROM users WHERE id=?", (p["user_id"],)).fetchone()
            if u["is_admin"] and not h.user["is_admin"]:
                raise FORBIDDEN
            tok, exp = make_link(h, "reset", person_id=p["id"], user_id=p["user_id"], created_by=h.user["id"])
            kind = "reset"
        else:
            tok, exp = make_link(h, "invite", person_id=p["id"], created_by=h.user["id"])
            kind = "invite"
    return {"kind": kind, "url": "%s/#invite=%s" % (h.base_url(), tok), "expires": exp}


@route("DELETE", "/api/teams/([a-z0-9-]+)/people/([0-9]+)/link")
def api_person_unlink(h, tid, pid):
    h.need_lead(tid)
    p = get_person(h, tid, pid)
    with Tx(h.con):
        h.con.execute("DELETE FROM invites WHERE person_id=? AND used_at IS NULL", (p["id"],))
    return {"ok": True}


# ---------------------------------------------------------------- routes: tasks
# Rules: team leads and the administrator change any task in their team directly.
# Members change only tasks where they are a Lead Engineer. Their detail changes save straight
# away; only a new or changed TARGET DATE waits for the team lead's approval (a change request
# whose data is {"target": date}). Until approved, a proposed date on a task with no official
# target shows as "awaiting lead".
def load_tasks(h, tid, approved_only=False):
    out = []
    q = "SELECT * FROM tasks WHERE team_id=?" + (" AND approved=1" if approved_only else "") + " ORDER BY no"
    days = team_archive_days(h.con, tid)
    pnames = {r["id"]: r["name"] for r in h.con.execute("SELECT id, name FROM projects WHERE team_id=?", (tid,))}
    items = {r["id"]: (r["name"], r["parent_name"]) for r in h.con.execute(
        "SELECT i.id, i.name, p.name AS parent_name FROM project_items i LEFT JOIN project_items p ON p.id=i.parent_id "
        "JOIN projects pr ON pr.id=i.project_id WHERE pr.team_id=?", (tid,))}
    for r in h.con.execute(q, (tid,)):
        t = dict(r)
        t["lead"], t["support"] = json.loads(t["lead"]), json.loads(t["support"])
        t["_archive_days"] = days
        t["_project_name"] = pnames.get(t.get("project_id"))
        if t.get("project_item_id") in items:
            t["_item_name"], t["_phase_name"] = items[t["project_item_id"]]
        out.append(t)
    return out


def can_edit(role, my_key, t):
    if role in ("lead", "admin"):
        return True
    if is_archived(t):  # archived tasks: only the team lead (or an admin) may change them
        return False
    return bool(my_key) and my_key in t["lead"]


def task_out(t, role, my_key, uid, td, req=None):
    out = {"id": t["id"], "no": t["no"], "category": t["category"], "title": t["title"], "progress": t["progress"], "percent": t["percent"],
           "urgency": t["urgency"], "customer": t["customer"], "lead": t["lead"], "support": t["support"], "startDate": t["start_date"],
           "requestedTarget": t["requested_target"], "target": t["target"], "effTarget": t["target"] or t["requested_target"],
           "pending": not t["target"] and bool(t["requested_target"]), "actualDate": t["actual_date"], "status": status_of(t, td),
           "archived": is_archived(t, td), "canEdit": can_edit(role, my_key, t), "approved": bool(t["approved"]),
           "changePending": bool(req) and req["kind"] == "edit", "imported": bool(t["imported"]), "updatedAt": t["updated_at"],
           "pendingFields": sorted(k for k in json.loads(req["data"]) if k in ("target", "actual_date")) if req and req["kind"] == "edit" else [],
           "projectId": t.get("project_id"), "projectItemId": t.get("project_item_id"),
           "projectName": t.get("_project_name"), "projectItemName": t.get("_item_name"), "projectPhaseName": t.get("_phase_name")}
    if req and req["kind"] == "edit" and (req["by_user"] == uid or role in ("lead", "admin")):
        out["request"] = {"id": req["id"], "mine": req["by_user"] == uid, "data": json.loads(req["data"]), "at": req["at"]}
    return out


@route("GET", "/api/teams/([a-z0-9-]+)/tasks")
def api_tasks(h, tid):
    role = h.need_member(tid)
    me = h.my_person(tid)
    td = today()
    reqs = {r["task_id"]: dict(r) for r in h.con.execute("SELECT * FROM change_requests WHERE team_id=? AND status='pending'", (tid,))}
    return {"today": td, "tasks": [task_out(t, role, me and me["key"], h.user["id"], td, reqs.get(t["id"])) for t in load_tasks(h, tid)],
            "pendingApprovals": len(reqs) if role in ("lead", "admin") else None}


TASK_FIELDS = [("category", "Category"), ("title", "Main task"), ("customer", "Customer"), ("urgency", "Urgency"), ("percent", "Task percentage"),
               ("progress", "Task progress"), ("lead", "Lead engineer"), ("support", "Support engineer"), ("start_date", "Start date"),
               ("actual_date", "Actual date"), ("project_id", "Project"), ("project_item_id", "Project activity")]


OUTSIDE = "ext:"  # support engineers from outside the team are stored by name with this prefix


def is_outside(k):
    return k.startswith(OUTSIDE)


def plan_end_dates(con, pid):
    """{project item id: end date} for one project's plan, in working days from its start date."""
    p = con.execute("SELECT start_date FROM projects WHERE id=?", (pid,)).fetchone()
    rows = con.execute("SELECT id, end_day FROM project_items WHERE project_id=?", (pid,)).fetchall()
    if not p or not rows:
        return {}
    hol = {r["date"] for r in con.execute("SELECT date FROM project_holidays WHERE project_id=?", (pid,))}
    days = workday_dates(p["start_date"], hol, max(r["end_day"] for r in rows))
    return {r["id"]: days[r["end_day"]].isoformat() for r in rows}


def sync_plan_targets(h, pid):
    """When a plan's dates move, open daily tasks linked to its activities move with them. Completed tasks keep the
    target they were completed against, so their on-time / late status doesn't change afterwards."""
    ends = plan_end_dates(h.con, pid)
    moved = 0
    for r in h.con.execute("SELECT * FROM tasks WHERE project_id=? AND project_item_id IS NOT NULL AND (actual_date IS NULL OR actual_date='')", (pid,)).fetchall():
        new = ends.get(r["project_item_id"])
        if new and new != r["target"]:
            set_target(h, dict(r), new, write_log=False)
            log(h, r["id"], "target", {"from": r["target"], "to": new, "plan": True})
            moved += 1
    return moved


def parse_task(h, tid, body, team):
    keys = {r["key"] for r in h.con.execute("SELECT key FROM people WHERE team_id=?", (tid,))}

    def ppl(k, outside_ok=False):
        v = body.get(k, [])
        if not isinstance(v, list) or len(v) > 20 or not all(isinstance(x, str) for x in v):
            raise bad("Pick engineers from this team's list.")
        out = []
        for x in v:
            if outside_ok and x.startswith(OUTSIDE):
                # someone from outside the team, typed in by name: "ext:Name"
                name = re.sub(r"[\x00-\x1f]", "", x[len(OUTSIDE):]).strip()
                if not name or len(name) > 60:
                    raise bad("Names of people outside the team must be 1 to 60 characters.")
                x = OUTSIDE + name
            elif x not in keys:
                raise bad("Pick engineers from this team's list." if not outside_ok else
                          "Pick support engineers from this team's list, or type the name of someone outside the team.")
            if x.lower() not in [o.lower() for o in out]:
                out.append(x)
        return out
    cat = s_field(body, "category", 60, True)
    if cat not in team["categories"]:
        raise bad("Choose one of this team's categories.")
    urg = body.get("urgency", "Medium")
    if urg not in URGENCIES:
        raise bad("Urgency must be Low, Medium, High or Critical.")
    try:
        pct = int(body.get("percent") or 0)
    except (TypeError, ValueError):
        raise bad("Task percentage must be a number.")
    d = {"category": cat, "title": s_field(body, "title", 200, True), "customer": s_field(body, "customer", 100),
         "urgency": urg, "percent": max(0, min(100, pct)), "progress": s_field(body, "progress", PROGRESS_MAX),
         "lead": ppl("lead"), "support": ppl("support", outside_ok=True), "start_date": d_field(body, "startDate"), "actual_date": d_field(body, "actualDate")}
    if not d["lead"]:
        raise bad("Choose at least one Lead Engineer.")
    # optional link to a project and one of its phases / activities; the client then comes from the project
    pid, iid = body.get("projectId"), body.get("projectItemId")
    d["project_id"] = d["project_item_id"] = None
    if pid not in (None, "", 0):
        try:
            pid = int(pid)
        except (TypeError, ValueError):
            raise bad("Choose a project from the list.")
        pr = h.con.execute("SELECT id, client FROM projects WHERE id=? AND team_id=?", (pid, tid)).fetchone()
        if not pr:
            raise bad("Choose one of this team's projects.")
        d["project_id"] = pid
        if pr["client"]:
            d["customer"] = pr["client"]
        if iid not in (None, "", 0):
            try:
                iid = int(iid)
            except (TypeError, ValueError):
                raise bad("Choose an activity from the project's plan.")
            if not h.con.execute("SELECT 1 FROM project_items WHERE id=? AND project_id=?", (iid, pid)).fetchone():
                raise bad("Choose an activity from this project's plan.")
            d["project_item_id"] = iid
            d["plan_target"] = plan_end_dates(h.con, pid).get(iid)  # the target date comes from the plan and can't be changed
    d["support"] = [k for k in d["support"] if k not in d["lead"]]  # a lead engineer isn't also listed as support
    if d["actual_date"]:
        d["percent"] = 100
        if d["start_date"] and d["actual_date"] < d["start_date"]:
            raise bad("The actual date can't be before the start date.")
        if d["actual_date"] > today():
            raise bad("The actual date can't be in the future.")
    return d


def diff_task(t, d, target):
    changes = []
    for f, _ in TASK_FIELDS:
        if f in d and (d[f] or None) != (t[f] or None) and not (f in ("lead", "support") and sorted(d[f]) == sorted(t[f])):
            changes.append([f] if f == "progress" else [f, cut(t[f]), cut(d[f])])
    cur = t["target"] or t["requested_target"]
    if target != cur:
        changes.append(["target", cur, target])
    return changes


def log(h, task_id, kind, changes, user_id=None):
    h.con.execute("INSERT INTO task_log(task_id,at,user_id,kind,changes) VALUES(?,?,?,?,?)",
                  (task_id, now_iso(), user_id or h.user["id"], kind, json.dumps(changes)))


def cut(v):
    if isinstance(v, str) and len(v) > 160:
        return v[:157] + "…"
    return v


def write_fields(h, task_id, d, user_id):
    sets = ", ".join("%s=?" % f for f in d)
    vals = [json.dumps(v) if isinstance(v, list) else v for v in d.values()]
    h.con.execute("UPDATE tasks SET %s, updated_by=?, updated_at=? WHERE id=?" % sets, vals + [user_id, now_iso(), task_id])


def set_target(h, t, new, write_log=True):
    h.con.execute("UPDATE tasks SET target=?, requested_target=COALESCE(requested_target, ?), target_set_by=?, target_set_at=?, updated_at=? WHERE id=?",
                  (new, new, h.user["id"], now_iso(), now_iso(), t["id"]))
    if write_log:
        log(h, t["id"], "target", {"from": t["target"], "to": new})


def proposal_fields(t, proposal):
    """[field, current, proposed] for a member's request, as shown in the task history."""
    out = []
    if proposal.get("target"):
        out.append(["target", t["target"] or t["requested_target"], proposal["target"]])
    if proposal.get("actual_date"):
        out.append(["actual_date", t["actual_date"], proposal["actual_date"]])
    return out


# ---- signed progress notes: every new or changed line starts with "[dd/mm/yyyy hh:mm Name] "
SIGN_START_RE = re.compile(r"^\[(\d{2}/\d{2}/\d{4} \d{2}:\d{2}) ([^\]]{1,60})\] ")
SIGN_END_RE = re.compile(r"\s+— ([^()\n]{1,60}) \((\d{2}/\d{2}/\d{4} \d{2}:\d{2})\)$")  # end-of-line format used briefly; converted on save
PROGRESS_MAX = 12000


def signer_name(h, tid):
    me = h.my_person(tid)
    return (me and me["name"]) or h.user["display_name"] or h.user["login"]


def sign_progress(old, new, name, when=None):
    """Sign the lines of `new` that aren't in `old` (added or edited) as "[dd/mm/yyyy hh:mm Name] text".
    Unchanged lines keep their signature. A new or edited line gets the current person's signature,
    replacing any signature typed or copied into it, so nobody can sign a line in someone else's name."""
    sig = "[%s %s] " % ((when or dt.datetime.now()).strftime("%d/%m/%Y %H:%M"), re.sub(r"[\[\]\n]", "", name).strip()[:60] or "Someone")
    left = {}
    for line in (old or "").split("\n"):
        left[line.strip()] = left.get(line.strip(), 0) + 1
    out = []
    for line in (new or "").split("\n"):
        key = line.strip()
        if not key:
            out.append(line)
            continue
        if left.get(key):
            left[key] -= 1
            m = SIGN_END_RE.search(key)  # unchanged line in the end-of-line format: same signature, start-of-line layout
            out.append("[%s %s] %s" % (m.group(2), m.group(1), key[:m.start()]) if m else line)
            continue
        text = SIGN_END_RE.sub("", SIGN_START_RE.sub("", key)).strip()
        out.append(sig + text if text else line)
    signed = "\n".join(out)
    if len(signed) > PROGRESS_MAX:
        raise bad("The progress notes are too long. Remove some older lines and save again.")
    return signed


@route("POST", "/api/teams/([a-z0-9-]+)/tasks")
def api_task_create(h, tid):
    role = h.need_member(tid)
    team = h.team(tid)
    d = parse_task(h, tid, h.body, team)
    d["progress"] = sign_progress("", d["progress"], signer_name(h, tid))
    plan_t = d.pop("plan_target", None)
    target = plan_t or d_field(h.body, "target")
    lead = role in ("lead", "admin")
    official = lead or bool(plan_t)  # a lead's date, or the plan's, is the official target; a member's is a request
    me = h.my_person(tid)
    if not lead and me["key"] not in d["lead"]:
        raise bad("Add yourself as a Lead Engineer. You can only manage tasks you lead.")
    backdated = None
    if not lead and d["actual_date"] and d["actual_date"] < today():
        backdated, d["actual_date"] = d["actual_date"], None
        try:
            d["percent"] = max(0, min(100, int(h.body.get("percent") or 0)))
        except (TypeError, ValueError):
            d["percent"] = 0
    ts = now_iso()
    with Tx(h.con):
        no = (h.con.execute("SELECT MAX(no) FROM tasks WHERE team_id=?", (tid,)).fetchone()[0] or 0) + 1
        cur = h.con.execute(
            "INSERT INTO tasks(team_id,no,category,title,progress,percent,urgency,customer,lead,support,start_date,requested_target,"
            "target,target_set_by,target_set_at,actual_date,created_by,created_at,updated_by,updated_at,approved,project_id,project_item_id) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (tid, no, d["category"], d["title"], d["progress"], d["percent"], d["urgency"], d["customer"], json.dumps(d["lead"]),
             json.dumps(d["support"]), d["start_date"], target, target if official else None, h.user["id"] if official and target else None,
             ts if official and target else None, d["actual_date"], h.user["id"], ts, h.user["id"], ts, 1, d["project_id"], d["project_item_id"]))
        task_id = cur.lastrowid
        log(h, task_id, "create", [])
        if official and target:
            log(h, task_id, "target", {"from": None, "to": target, "plan": True} if plan_t else {"from": None, "to": target})
        proposal = {} if lead else {k: v for k, v in (("target", None if plan_t else target), ("actual_date", backdated)) if v}
        if proposal:
            h.con.execute("INSERT INTO change_requests(task_id,team_id,kind,data,by_user,at,status) VALUES(?,?,?,?,?,?,'pending')",
                          (task_id, tid, "edit", json.dumps(proposal), h.user["id"], ts))
            log(h, task_id, "request", {"fields": [[k, None, v] for k, v in proposal.items()]})
    return {"id": task_id, "no": no, "pending": sorted(proposal)}


def get_task(h, task_id):
    r = h.con.execute("SELECT * FROM tasks WHERE id=?", (int(task_id),)).fetchone()
    if not r:
        raise NOT_FOUND
    t = dict(r)
    t["lead"], t["support"] = json.loads(t["lead"]), json.loads(t["support"])
    t["_archive_days"] = team_archive_days(h.con, t["team_id"])
    return t


@route("PUT", "/api/tasks/([0-9]+)")
def api_task_update(h, task_id):
    t = get_task(h, task_id)
    role = h.need_member(t["team_id"])
    me = h.my_person(t["team_id"])
    my_key = me and me["key"]
    if not can_edit(role, my_key, t):
        if is_archived(t) and role not in ("lead", "admin"):
            raise ApiError(403, "This task is archived. Only the team lead can change it.")
        raise ApiError(403, "Only the task's Lead Engineer or the team lead can change it.")
    d = parse_task(h, t["team_id"], h.body, h.team(t["team_id"]))
    d["progress"] = sign_progress(t["progress"], d["progress"], signer_name(h, t["team_id"]))
    plan_t = d.pop("plan_target", None)
    target = plan_t or (d_field(h.body, "target") if "target" in h.body else (t["target"] or t["requested_target"]))
    lead = role in ("lead", "admin")
    if not lead and my_key not in d["lead"]:
        raise bad("Keep yourself as a Lead Engineer, or ask your team lead to hand the task over.")
    changes = diff_task(t, d, target)
    if not changes:
        return {"ok": True, "changed": False}
    with Tx(h.con):
        if plan_t and plan_t != t["target"]:
            # linked to a project activity: the target is the activity's end date, set straight away for anyone
            set_target(h, t, plan_t, write_log=False)
            log(h, t["id"], "target", {"from": t["target"], "to": plan_t, "plan": True})
            t["target"] = plan_t
            target = plan_t
        if lead:
            field_changes = [c for c in changes if c[0] != "target"]
            if field_changes:
                write_fields(h, t["id"], d, h.user["id"])
                log(h, t["id"], "edit", field_changes)
            if target and target != t["target"]:
                set_target(h, t, target)
            return {"ok": True, "changed": True}
        proposal = member_proposal(h, t, d, target)
        if proposal:
            request_change(h, t, proposal)
        field_changes = [c for c in diff_task(t, d, t["target"] or t["requested_target"]) if c[0] != "target"]
        if field_changes:
            write_fields(h, t["id"], d, h.user["id"])
            log(h, t["id"], "edit", field_changes)
    return {"ok": True, "changed": True, "pending": sorted(proposal)}


def member_proposal(h, t, d, target):
    """Split out what a member may not change on their own: the target date, and a completion dated before today
    (a backdated actual date). Those go to the team lead; everything else in d saves directly. Mutates d."""
    proposal = {}
    if target != (t["target"] or t["requested_target"]):
        if not target:
            raise bad("Only your team lead can remove a target date.")
        proposal["target"] = target
    new_actual = d["actual_date"]
    if new_actual and new_actual != t["actual_date"] and new_actual < today():
        proposal["actual_date"] = new_actual
        d["actual_date"] = t["actual_date"]  # the task stays as it is until the lead approves
        try:
            d["percent"] = max(0, min(100, int(h.body.get("percent") or 0)))
        except (TypeError, ValueError):
            d["percent"] = t["percent"]
    return proposal


def request_change(h, t, proposal):
    """One pending request per task, holding a proposed target and/or backdated completion date.
    The same person proposing again updates it; someone else's pending request blocks a new one."""
    other = h.con.execute("SELECT r.*, u.display_name FROM change_requests r LEFT JOIN users u ON u.id=r.by_user "
                          "WHERE r.task_id=? AND r.status='pending' AND r.kind='edit'", (t["id"],)).fetchone()
    if other and other["by_user"] != h.user["id"]:
        raise ApiError(409, "%s already has a request waiting for the team lead on this task. Ask your team lead to review it first."
                       % (other["display_name"] or "Someone"))
    log(h, t["id"], "request", {"fields": proposal_fields(t, proposal)})
    if other:
        data = dict(json.loads(other["data"]), **proposal)
        h.con.execute("UPDATE change_requests SET data=?, at=? WHERE id=?", (json.dumps(data), now_iso(), other["id"]))
    else:
        h.con.execute("INSERT INTO change_requests(task_id,team_id,kind,data,by_user,at,status) VALUES(?,?,?,?,?,?,'pending')",
                      (t["id"], t["team_id"], "edit", json.dumps(proposal), h.user["id"], now_iso()))
    if "target" in proposal and not t["target"]:
        h.con.execute("UPDATE tasks SET requested_target=? WHERE id=?", (proposal["target"], t["id"]))


def drop_proposal(h, r):
    """After a rejected or withdrawn proposal, a task with no official target stops showing the proposed date."""
    prop = json.loads(r["data"]).get("target")
    if prop:
        h.con.execute("UPDATE tasks SET requested_target=NULL WHERE id=? AND target IS NULL AND requested_target=?", (r["task_id"], prop))


@route("PUT", "/api/tasks/([0-9]+)/target")
def api_task_target(h, task_id):
    t = get_task(h, task_id)
    h.need_lead(t["team_id"])
    new = d_field(h.body, "target")
    if not new:
        raise bad("Choose a target date.")
    if t["project_item_id"]:
        raise bad("This task's target date follows its project activity. Change the dates in the project's plan.")
    if new == t["target"]:
        return {"ok": True, "changed": False}
    with Tx(h.con):
        set_target(h, t, new)
    return {"ok": True, "changed": True}


@route("DELETE", "/api/tasks/([0-9]+)")
def api_task_delete(h, task_id):
    t = get_task(h, task_id)
    h.need_lead(t["team_id"])
    with Tx(h.con):
        h.con.execute("UPDATE change_requests SET status='cancelled', decided_by=?, decided_at=? WHERE task_id=? AND status='pending'",
                      (h.user["id"], now_iso(), t["id"]))
        h.con.execute("DELETE FROM tasks WHERE id=?", (t["id"],))
    return {"ok": True}


@route("GET", "/api/tasks/([0-9]+)/history")
def api_task_history(h, task_id):
    t = get_task(h, task_id)
    h.need_member(t["team_id"])
    rows = h.con.execute("SELECT l.*, u.display_name FROM task_log l LEFT JOIN users u ON u.id=l.user_id WHERE task_id=? ORDER BY l.id DESC",
                         (t["id"],)).fetchall()
    names = {r["id"]: r["display_name"] for r in h.con.execute("SELECT id, display_name FROM users")}
    rows = [dict(r, changes=json.loads(r["changes"])) for r in rows]
    # Entries written before approvals were logged as one entry: the lead's approval came with a separate
    # "target" entry in the lead's name (and a backdated completion in the member's name) at the same moment.
    # Fold those into the approval so the history says whose request it was.
    folded = set()
    for a in rows:
        if a["kind"] != "approve" or "applied" in a["changes"]:
            continue
        a["changes"]["applied"] = []
        for o in rows:
            if o["id"] in folded or o["at"] != a["at"] or o["id"] == a["id"]:
                continue
            if o["kind"] == "target" and o["user_id"] == a["user_id"]:
                a["changes"]["applied"].append(["target", o["changes"].get("from"), o["changes"].get("to")])
                folded.add(o["id"])
            elif o["kind"] == "edit" and o["user_id"] == a["changes"].get("of") and o["user_id"] != a["user_id"]:
                a["changes"]["applied"] += o["changes"]
                folded.add(o["id"])
    # Request entries from an earlier version saved only the requested values ({"target": "2026-11-13"}).
    # Show them as fields; the date before was empty if the request came with a new task, otherwise not recorded.
    created_at = {(r["at"], r["user_id"]) for r in rows if r["kind"] == "create"}
    for r in rows:
        ch = r["changes"]
        if r["kind"] in ("request", "withdraw") and isinstance(ch, dict) and "fields" not in ch:
            was = None if (r["at"], r["user_id"]) in created_at else "?"
            r["changes"] = {"fields": [[k, was, ch[k]] for k in ("target", "actual_date") if ch.get(k)]}
    # project and activity changes are stored as ids; show their names
    pn = {x["id"]: x["name"] for x in h.con.execute("SELECT id, name FROM projects WHERE team_id=?", (t["team_id"],))}
    inames = {x["id"]: x["name"] for x in h.con.execute(
        "SELECT i.id, i.name FROM project_items i JOIN projects p ON p.id=i.project_id WHERE p.team_id=?", (t["team_id"],))}
    for r in rows:
        if r["kind"] == "edit" and isinstance(r["changes"], list):
            for c in r["changes"]:
                if len(c) == 3 and c[0] in ("project_id", "project_item_id"):
                    m = pn if c[0] == "project_id" else inames
                    c[1], c[2] = m.get(c[1], c[1] and "(deleted)"), m.get(c[2], c[2] and "(deleted)")
    entries = []
    for r in rows:
        if r["id"] in folded:
            continue
        ch = r["changes"]
        if isinstance(ch, dict) and "of" in ch:
            ch["of"] = names.get(ch["of"], "Someone")
        entries.append({"at": r["at"], "by": r["display_name"] or ("Excel workbook" if r["user_id"] is None else "Someone"), "kind": r["kind"], "changes": ch})
    return {"imported": bool(t["imported"]), "entries": entries}


# ---------------------------------------------------------------- routes: approvals
def request_out(h, r, tasks_by_id):
    t = tasks_by_id.get(r["task_id"])
    data = json.loads(r["data"])
    out = {"id": r["id"], "kind": r["kind"], "status": r["status"], "at": r["at"], "by": r["by_name"] or "Someone",
           "note": r["note"], "decidedBy": r["decided_name"], "decidedAt": r["decided_at"], "taskId": r["task_id"],
           "no": t["no"] if t else data.get("no"), "title": t["title"] if t else data.get("title"),
           "proposed": {k: v for k, v in data.items() if k in ("target", "actual_date")}}
    if r["kind"] == "edit" and t and r["status"] == "pending" and set(data) <= {"target", "actual_date"}:
        out["changes"] = [[k, t[k], data[k]] for k in ("target", "actual_date") if k in data]  # current -> proposed
        if "actual_date" in data:
            out["backdatedDays"] = (dt.date.fromisoformat(today()) - dt.date.fromisoformat(data["actual_date"])).days
            tg = data.get("target") or t["target"] or t["requested_target"]
            asked_on = r["at"][:10]
            if tg and tg < asked_on and data["actual_date"] <= tg:
                # The target had already passed when the member sent this, yet the date they give makes it on time.
                out["lateCheck"] = {"target": tg, "askedOn": asked_on,
                                    "ifApproved": status_of(dict(t, actual_date=data["actual_date"], target=tg, requested_target=tg)),
                                    "ifToday": "Completed Late"}
    elif r["kind"] == "edit" and t and r["status"] == "pending":
        out["changes"] = diff_task(t, {k: v for k, v in data.items() if k != "target"}, data.get("target"))
    elif r["kind"] == "edit":
        out["changes"] = data.get("_applied", [])
    if r["kind"] == "create" and t:
        out["task"] = {"category": t["category"], "urgency": t["urgency"], "customer": t["customer"], "lead": t["lead"], "support": t["support"],
                       "startDate": t["start_date"], "target": t["requested_target"], "progress": cut(t["progress"])}
    return out


@route("GET", "/api/teams/([a-z0-9-]+)/requests")
def api_requests(h, tid):
    """Leads: every pending request in the team. Members: their own requests from the last 30 days."""
    role = h.need_member(tid)
    q = ("SELECT r.*, a.display_name AS by_name, b.display_name AS decided_name FROM change_requests r "
         "LEFT JOIN users a ON a.id=r.by_user LEFT JOIN users b ON b.id=r.decided_by WHERE r.team_id=? ")
    if role in ("lead", "admin") and h.query.get("scope") != "mine":
        rows = h.con.execute(q + "AND r.status='pending' ORDER BY r.at", (tid,)).fetchall()
    else:
        since = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=30)).isoformat()
        rows = h.con.execute(q + "AND r.by_user=? AND (r.status='pending' OR r.decided_at>?) ORDER BY r.at DESC", (tid, h.user["id"], since)).fetchall()
    tasks = {t["id"]: t for t in load_tasks(h, tid)}
    return {"requests": [request_out(h, dict(r), tasks) for r in rows]}


def get_request(h, rid):
    r = h.con.execute("SELECT * FROM change_requests WHERE id=?", (int(rid),)).fetchone()
    if not r:
        raise NOT_FOUND
    if r["status"] != "pending":
        raise ApiError(409, "This request was already %s." % r["status"])
    return dict(r)


@route("POST", "/api/requests/([0-9]+)/approve")
def api_request_approve(h, rid):
    r = get_request(h, rid)
    h.need_lead(r["team_id"])
    with Tx(h.con):
        t = get_task(h, r["task_id"])
        if r["kind"] == "create":
            h.con.execute("UPDATE tasks SET approved=1, updated_at=? WHERE id=?", (now_iso(), t["id"]))
            applied = []
            if t["requested_target"] and not t["target"] and not t["project_item_id"]:
                set_target(h, t, t["requested_target"], write_log=False)
                applied.append(["target", None, t["requested_target"]])
            log(h, t["id"], "approve", {"request": "create", "of": r["by_user"], "applied": applied})
        elif set(json.loads(r["data"])) <= {"target", "actual_date"}:
            data = json.loads(r["data"])
            applied = []
            if data.get("actual_date") and data["actual_date"] != t["actual_date"]:
                ch = [["actual_date", t["actual_date"], data["actual_date"]]] + ([["percent", t["percent"], 100]] if t["percent"] != 100 else [])
                write_fields(h, t["id"], {"actual_date": data["actual_date"], "percent": 100}, r["by_user"])
                applied += ch
            if data.get("target") and data["target"] != t["target"] and not t["project_item_id"]:  # a linked task keeps the plan's date
                set_target(h, t, data["target"], write_log=False)
                applied.append(["target", t["target"], data["target"]])
            log(h, t["id"], "approve", {"request": "edit", "of": r["by_user"], "applied": applied})
            h.con.execute("UPDATE change_requests SET data=? WHERE id=?", (json.dumps(dict(data, _applied=applied)), r["id"]))
        else:  # older requests that carried a whole task
            data = json.loads(r["data"])
            target = data.pop("target", None)
            applied = diff_task(t, data, target) if data else [["target", t["target"], target]]
            field_changes = [c for c in applied if c[0] != "target"]
            if field_changes:
                write_fields(h, t["id"], data, r["by_user"])
            if target and target != t["target"]:
                set_target(h, t, target, write_log=False)
            log(h, t["id"], "approve", {"request": "edit", "of": r["by_user"], "applied": applied})
            h.con.execute("UPDATE change_requests SET data=? WHERE id=?", (json.dumps(dict(json.loads(r["data"]), _applied=applied)), r["id"]))
        h.con.execute("UPDATE change_requests SET status='approved', decided_by=?, decided_at=? WHERE id=?", (h.user["id"], now_iso(), r["id"]))
    return {"ok": True}


@route("POST", "/api/requests/([0-9]+)/reject")
def api_request_reject(h, rid):
    r = get_request(h, rid)
    h.need_lead(r["team_id"])
    note = s_field(h.body, "note", 500)
    with Tx(h.con):
        if r["kind"] == "create":
            h.con.execute("DELETE FROM tasks WHERE id=? AND approved=0", (r["task_id"],))
        else:
            log(h, r["task_id"], "reject", {"of": r["by_user"], "note": note, "fields": proposal_fields(get_task(h, r["task_id"]), json.loads(r["data"]))})
            drop_proposal(h, r)
        h.con.execute("UPDATE change_requests SET status='rejected', note=?, decided_by=?, decided_at=? WHERE id=?",
                      (note, h.user["id"], now_iso(), r["id"]))
    return {"ok": True}


@route("DELETE", "/api/requests/([0-9]+)")
def api_request_cancel(h, rid):
    """The requester withdraws their own pending request (a pending new task is removed)."""
    r = get_request(h, rid)
    h.need_member(r["team_id"])
    if r["by_user"] != h.user["id"]:
        raise FORBIDDEN
    with Tx(h.con):
        if r["kind"] == "create":
            h.con.execute("DELETE FROM tasks WHERE id=? AND approved=0", (r["task_id"],))
        else:
            log(h, r["task_id"], "withdraw", {"fields": proposal_fields(get_task(h, r["task_id"]), json.loads(r["data"]))})
            drop_proposal(h, r)
        h.con.execute("UPDATE change_requests SET status='cancelled', decided_by=?, decided_at=? WHERE id=?", (h.user["id"], now_iso(), r["id"]))
    return {"ok": True}


# ---------------------------------------------------------------- routes: projects
PROJECT_STATUSES = ["Planned", "Active", "On Hold", "Completed", "Cancelled"]
ITEM_STATUSES = ["Not Started", "In Progress", "Completed", "At Risk"]
# Phase colours: dark for the phase bar, light for its activities (as in the team's Excel timeline)
PHASE_COLOURS = [("1F7A99", "A9CCD8"), ("ED7D31", "F8CDB0"), ("C00000", "E79E9E"), ("FFC000", "FFE79E"), ("2E75B6", "AFCAE3"), ("00B050", "9EE0BC")]
# The one template: an implementation project, from the Affin Rentas API timeline (working-day numbers from the start date)
PROJECT_TEMPLATE = [
    ("Requirement Study", "Signed-off requirement spec", 1, 5, [
        ("activity", "Kick-off meeting with customer team", 1, 1), ("activity", "Requirement discussion", 2, 3),
        ("activity", "Technical requirement discussion", 4, 5), ("activity", "System requirement: proxy whitelist request", 2, 5),
        ("activity", "System requirement: firewall request", 2, 5), ("activity", "System requirement: OS library installation", 2, 5),
        ("milestone", "Job Design Document and sign-off", 5, 5)]),
    ("Development", "Scripts and configuration ready for testing", 6, 20, [
        ("activity", "Script / configuration development", 6, 18), ("activity", "Deployment to test environment", 19, 20),
        ("milestone", "Development complete", 20, 20)]),
    ("System Integration Testing - SIT", "SIT test result and sign-off", 21, 25, [
        ("activity", "SIT testing", 21, 24), ("activity", "SIT report preparation", 25, 25), ("milestone", "SIT sign-off", 25, 25)]),
    ("User Acceptance Testing & Support - UAT", "UAT test results and sign-off", 26, 40, [
        ("activity", "UAT environment configuration", 26, 30), ("activity", "UAT test script discussion", 31, 32),
        ("activity", "Scheduled run (1st run)", 33, 34), ("activity", "Scheduled run (2nd run)", 35, 36),
        ("activity", "Scheduled run (3rd run)", 37, 38), ("activity", "UAT report preparation", 39, 40), ("milestone", "UAT sign-off", 40, 40)]),
    ("Production Preparation", "Change request approved; production readiness signed off", 41, 45, [
        ("activity", "Go-live checklist preparation", 41, 41), ("activity", "Go-live checklist discussion", 42, 42),
        ("activity", "Change request approval", 43, 45), ("activity", "Production system requirement: proxy whitelist request", 43, 45),
        ("activity", "Production system requirement: firewall request", 43, 45),
        ("activity", "Production system requirement: OS library installation", 43, 45),
        ("milestone", "Dry run and production readiness checklist sign-off", 45, 45)]),
    ("Go-Live", "Go-live confirmation", 46, 48, [
        ("activity", "First scheduled production run", 46, 46), ("activity", "Confirm output received by business users", 46, 46),
        ("activity", "Monitor initial runs", 47, 48), ("milestone", "Go-live confirmation & sign-off", 48, 48)]),
]
PROJECT_TEMPLATES = {"implementation": "Implementation project (Requirement Study, Development, SIT, UAT, Production Preparation, Go-Live)"}


def workday_dates(start, holidays, upto):
    """Day 1 is the start date; day n is n-1 working days later, skipping weekends and the project's holidays (Excel WORKDAY)."""
    d = dt.date.fromisoformat(start)
    out = [None, d]
    while len(out) <= upto:
        d += dt.timedelta(days=1)
        if d.weekday() < 5 and d.isoformat() not in holidays:
            out.append(d)
    return out


def project_rows(h, pid):
    return [dict(r) for r in h.con.execute("SELECT * FROM project_items WHERE project_id=? ORDER BY seq, id", (pid,))]


def project_out(h, p, detail=False):
    """A project with its computed dates, statuses and progress. Rules follow the team's Excel timeline:
    a phase is At Risk if any of its items is (or is overdue), Completed if all are, Not Started if none started."""
    td = today()
    hol = {r["date"]: r["name"] for r in h.con.execute("SELECT date, name FROM project_holidays WHERE project_id=? ORDER BY date", (p["id"],))}
    rows = project_rows(h, p["id"])
    upto = max([r["end_day"] for r in rows] + [1])
    days = workday_dates(p["start_date"], hol, upto)
    phases = [r for r in rows if r["kind"] == "phase"]
    kids = {}
    for r in rows:
        if r["parent_id"]:
            kids.setdefault(r["parent_id"], []).append(r)
    for r in rows:
        r["startDate"], r["endDate"] = days[r["start_day"]].isoformat(), days[r["end_day"]].isoformat()
    for r in rows:
        if r["kind"] != "phase":
            r["overdue"] = r["status"] != "Completed" and r["endDate"] < td
    for ph in phases:
        ks = kids.get(ph["id"], [])
        st = [("At Risk" if k["overdue"] else k["status"]) for k in ks]
        ph["status"] = ("Not Started" if not st else "At Risk" if "At Risk" in st else "Completed" if all(x == "Completed" for x in st)
                        else "Not Started" if all(x == "Not Started" for x in st) else "In Progress")
        ph["overdue"] = ph["status"] != "Completed" and ph["endDate"] < td
    items = [r for r in rows if r["kind"] != "phase"]
    done = sum(1 for r in items if r["status"] == "Completed")
    risky = [r for r in items if r["overdue"] or r["status"] == "At Risk"]
    health = "At Risk" if p["status"] in ("Planned", "Active") and risky else p["status"]
    pm = h.con.execute("SELECT name FROM people WHERE id=?", (p["pm_person_id"],)).fetchone() if p["pm_person_id"] else None
    out = {"id": p["id"], "teamId": p["team_id"], "client": p["client"], "name": p["name"], "description": p["description"],
           "pmPersonId": p["pm_person_id"], "pmName": pm["name"] if pm else None, "startDate": p["start_date"],
           "endDate": max([r["endDate"] for r in rows] + [p["start_date"]]),
           "goLive": phases[-1]["endDate"] if phases else None, "status": p["status"], "displayStatus": health,
           "progress": done / len(items) if items else 0, "activities": len(items), "completed": done,
           "overdue": sum(1 for r in items if r["overdue"]), "atRisk": len(risky),
           "linkedTasks": h.con.execute("SELECT COUNT(*) FROM tasks WHERE project_id=?", (p["id"],)).fetchone()[0],
           "updatedAt": p["updated_at"]}
    if detail:
        counts, done_counts = {}, {}
        for r in h.con.execute("SELECT project_item_id, COUNT(*) AS n, SUM(actual_date IS NOT NULL AND actual_date<>'') AS d FROM tasks "
                               "WHERE project_id=? AND project_item_id IS NOT NULL GROUP BY project_item_id", (p["id"],)):
            counts[r["project_item_id"]], done_counts[r["project_item_id"]] = r["n"], r["d"] or 0
        def item(r):
            return {"id": r["id"], "kind": r["kind"], "name": r["name"], "deliverable": r["deliverable"], "owner": r["owner"],
                    "startDay": r["start_day"], "endDay": r["end_day"], "startDate": r["startDate"], "endDate": r["endDate"],
                    "status": r["status"], "overdue": r["overdue"], "remarks": r["remarks"], "tasks": counts.get(r["id"], 0),
                    "tasksDone": done_counts.get(r["id"], 0)}
        out["phases"] = [dict(item(ph), items=[item(k) for k in kids.get(ph["id"], [])]) for ph in phases]
        out["holidays"] = [{"date": d, "name": n} for d, n in hol.items()]
        out["calendar"] = [d.isoformat() for d in days[1:]]  # working day n -> date
        out["today"] = td
    return out


def get_project(h, pid):
    r = h.con.execute("SELECT * FROM projects WHERE id=?", (int(pid),)).fetchone()
    if not r:
        raise NOT_FOUND
    return dict(r)


def project_rights(h, p):
    role = h.need_member(p["team_id"])
    me = h.my_person(p["team_id"])
    edit = role in ("lead", "admin") or bool(me and p["pm_person_id"] == me["id"])
    return role, me, edit


def can_create_projects(h, tid):
    role = h.need_member(tid)
    me = h.my_person(tid)
    return role in ("lead", "admin") or bool(me and me.get("is_pm"))


def project_fields(h, tid, body, cur=None):
    cur = cur or {}
    name = s_field(body, "name", 150, True, cur.get("name", ""))
    client = s_field(body, "client", 100, False, cur.get("client", ""))
    desc = s_field(body, "description", 4000, False, cur.get("description", ""))
    start = d_field(body, "startDate") if "startDate" in body else cur.get("start_date")
    if not start:
        raise bad("Choose the project start date.")
    status = body.get("status", cur.get("status", "Planned"))
    if status not in PROJECT_STATUSES:
        raise bad("Status must be one of: %s." % ", ".join(PROJECT_STATUSES))
    pm = body.get("pmPersonId", cur.get("pm_person_id"))
    if pm in ("", 0):
        pm = None
    if pm is not None:
        try:
            pm = int(pm)
        except (TypeError, ValueError):
            raise bad("Choose the project manager from the list.")
        ok = h.con.execute("SELECT 1 FROM people WHERE id=? AND team_id=? AND active=1 AND (is_pm=1 OR role='lead')", (pm, tid)).fetchone()
        if not ok:
            raise bad("The project manager must be one of this team's Project Managers or team leads.")
    return {"name": name, "client": client, "description": desc, "start_date": start, "status": status, "pm_person_id": pm}


def insert_template(h, pid):
    seq = 0
    for name, deliv, a, b, kids in PROJECT_TEMPLATE:
        seq += 1
        ph = h.con.execute("INSERT INTO project_items(project_id,parent_id,seq,kind,name,deliverable,start_day,end_day) VALUES(?,?,?,?,?,?,?,?)",
                           (pid, None, seq, "phase", name, deliv, a, b)).lastrowid
        for kind, kname, ka, kb in kids:
            seq += 1
            h.con.execute("INSERT INTO project_items(project_id,parent_id,seq,kind,name,start_day,end_day) VALUES(?,?,?,?,?,?,?)",
                          (pid, ph, seq, kind, kname, ka, kb))


@route("GET", "/api/teams/([a-z0-9-]+)/projects")
def api_projects(h, tid):
    h.need_member(tid)
    rows = h.con.execute("SELECT * FROM projects WHERE team_id=? ORDER BY CASE status WHEN 'Active' THEN 0 WHEN 'Planned' THEN 1 "
                         "WHEN 'On Hold' THEN 2 WHEN 'Completed' THEN 3 ELSE 4 END, start_date DESC, name", (tid,)).fetchall()
    return {"projects": [project_out(h, dict(r)) for r in rows], "canCreate": can_create_projects(h, tid), "templates": PROJECT_TEMPLATES,
            "statuses": PROJECT_STATUSES}


@route("POST", "/api/teams/([a-z0-9-]+)/projects")
def api_project_create(h, tid):
    if not can_create_projects(h, tid):
        raise ApiError(403, "Only team leads and Project Managers can create projects.")
    f = project_fields(h, tid, h.body)
    me = h.my_person(tid)
    if f["pm_person_id"] is None and me and me.get("is_pm"):
        f["pm_person_id"] = me["id"]  # a Project Manager creating a project manages it
    template = h.body.get("template") or ""
    if template and template not in PROJECT_TEMPLATES:
        raise bad("Unknown template.")
    ts = now_iso()
    with Tx(h.con):
        pid = h.con.execute("INSERT INTO projects(team_id,client,name,description,pm_person_id,start_date,status,created_by,created_at,updated_at) "
                            "VALUES(?,?,?,?,?,?,?,?,?,?)", (tid, f["client"], f["name"], f["description"], f["pm_person_id"], f["start_date"],
                                                            f["status"], h.user["id"], ts, ts)).lastrowid
        if template:
            insert_template(h, pid)
    return {"id": pid}


@route("GET", "/api/projects/([0-9]+)")
def api_project(h, pid):
    p = get_project(h, pid)
    role, me, edit = project_rights(h, p)
    out = project_out(h, p, detail=True)
    out["canEdit"], out["canDelete"] = edit, role in ("lead", "admin")
    tasks = h.con.execute("SELECT t.id, t.no, t.title, t.lead, t.project_item_id, t.actual_date, t.target, t.requested_target FROM tasks t "
                          "WHERE t.project_id=? ORDER BY t.no", (p["id"],)).fetchall()
    out["tasks"] = [{"id": t["id"], "no": t["no"], "title": t["title"], "lead": json.loads(t["lead"]), "itemId": t["project_item_id"],
                     "status": status_of(t)} for t in tasks]
    return out


@route("PUT", "/api/projects/([0-9]+)")
def api_project_update(h, pid):
    p = get_project(h, pid)
    role, me, edit = project_rights(h, p)
    if not edit:
        raise ApiError(403, "Only the team lead or the project's manager can change it.")
    f = project_fields(h, p["team_id"], h.body, p)
    if f["pm_person_id"] != p["pm_person_id"] and role not in ("lead", "admin"):
        raise ApiError(403, "Only the team lead can change the project manager.")
    with Tx(h.con):
        h.con.execute("UPDATE projects SET client=?, name=?, description=?, pm_person_id=?, start_date=?, status=?, updated_at=? WHERE id=?",
                      (f["client"], f["name"], f["description"], f["pm_person_id"], f["start_date"], f["status"], now_iso(), p["id"]))
        moved = sync_plan_targets(h, p["id"])  # a new start date moves the linked tasks' targets
    return {"ok": True, "tasksMoved": moved}


@route("DELETE", "/api/projects/([0-9]+)")
def api_project_delete(h, pid):
    p = get_project(h, pid)
    role, _, _ = project_rights(h, p)
    if role not in ("lead", "admin"):
        raise ApiError(403, "Only the team lead can delete a project.")
    with Tx(h.con):
        h.con.execute("DELETE FROM projects WHERE id=?", (p["id"],))  # tasks keep their details; their project link is cleared
    return {"ok": True}


@route("PUT", "/api/projects/([0-9]+)/items/([0-9]+)")
def api_project_item(h, pid, iid):
    """Change one activity's or milestone's status (and optionally its remarks) straight from the plan, without the editor."""
    p = get_project(h, pid)
    _, _, edit = project_rights(h, p)
    if not edit:
        raise ApiError(403, "Only the team lead or the project's manager can change an activity's status.")
    it = h.con.execute("SELECT * FROM project_items WHERE id=? AND project_id=?", (int(iid), p["id"])).fetchone()
    if not it:
        raise NOT_FOUND
    if it["kind"] == "phase":
        raise bad("A phase's status follows its activities.")
    status = h.body.get("status", it["status"])
    if status not in ITEM_STATUSES:
        raise bad("Status must be one of: %s." % ", ".join(ITEM_STATUSES))
    remarks = it["remarks"]
    if "remarks" in h.body:
        remarks = str(h.body.get("remarks") or "").strip()[:500]
    with Tx(h.con):
        h.con.execute("UPDATE project_items SET status=?, remarks=? WHERE id=?", (status, remarks, it["id"]))
        h.con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), p["id"]))
    return {"ok": True, "status": status}


def _day(v, what):
    try:
        n = int(v)
    except (TypeError, ValueError):
        raise bad("%s must be a whole number of working days." % what)
    if not 1 <= n <= 1000:
        raise bad("%s must be between day 1 and day 1000." % what)
    return n


@route("PUT", "/api/projects/([0-9]+)/plan")
def api_project_plan(h, pid):
    """Save the whole plan: {phases: [{id?, name, deliverable, startDay, endDay, items: [{id?, kind, name, owner, startDay, endDay,
    status, remarks}]}], holidays: [{date, name}]}. Items left out are deleted (daily tasks keep their details, without the link)."""
    p = get_project(h, pid)
    _, _, edit = project_rights(h, p)
    if not edit:
        raise ApiError(403, "Only the team lead or the project's manager can change the plan.")
    phases = h.body.get("phases")
    if not isinstance(phases, list) or len(phases) > 40:
        raise bad("The plan must be a list of up to 40 phases.")
    existing = {r["id"] for r in project_rows(h, p["id"])}
    total = sum(len(ph.get("items") or []) for ph in phases if isinstance(ph, dict))
    if total > 400:
        raise bad("A plan can have at most 400 activities.")
    hols = h.body.get("holidays", None)
    with Tx(h.con):
        keep, seq = set(), 0

        def save(row, parent):
            nonlocal seq
            seq += 1
            kind = "phase" if parent is None else row.get("kind", "activity")
            if kind not in ("activity", "milestone", "phase") or (parent is not None and kind == "phase"):
                raise bad("Each row must be an activity or a milestone inside a phase.")
            name = s_field(row, "name", 200, True)
            a, b = _day(row.get("startDay"), "Start day of " + name), _day(row.get("endDay"), "End day of " + name)
            if b < a:
                raise bad("%s ends before it starts (day %d to day %d)." % (name, a, b))
            status = row.get("status") or "Not Started"
            if status not in ITEM_STATUSES:
                raise bad("Status must be one of: %s." % ", ".join(ITEM_STATUSES))
            vals = (parent, seq, kind, name, s_field(row, "deliverable", 300), s_field(row, "owner", 120), a, b, status, s_field(row, "remarks", 1000))
            rid = row.get("id")
            if isinstance(rid, int) and rid in existing:
                h.con.execute("UPDATE project_items SET parent_id=?, seq=?, kind=?, name=?, deliverable=?, owner=?, start_day=?, end_day=?, "
                              "status=?, remarks=? WHERE id=?", vals + (rid,))
            else:
                rid = h.con.execute("INSERT INTO project_items(parent_id,seq,kind,name,deliverable,owner,start_day,end_day,status,remarks,project_id) "
                                    "VALUES(?,?,?,?,?,?,?,?,?,?,?)", vals + (p["id"],)).lastrowid
            keep.add(rid)
            return rid

        for ph in phases:
            if not isinstance(ph, dict):
                raise bad("Invalid phase.")
            phid = save(ph, None)
            items = ph.get("items") or []
            if not isinstance(items, list):
                raise bad("Invalid activities.")
            for it in items:
                if not isinstance(it, dict):
                    raise bad("Invalid activity.")
                save(it, phid)
        for gone in existing - keep:
            h.con.execute("DELETE FROM project_items WHERE id=?", (gone,))
        if hols is not None:
            if not isinstance(hols, list) or len(hols) > 200:
                raise bad("Holidays must be a list of up to 200 dates.")
            h.con.execute("DELETE FROM project_holidays WHERE project_id=?", (p["id"],))
            for x in hols:
                if not isinstance(x, dict):
                    raise bad("Invalid holiday.")
                d = d_field(x, "date")
                if not d:
                    raise bad("Each holiday needs a date.")
                h.con.execute("INSERT OR REPLACE INTO project_holidays(project_id,date,name) VALUES(?,?,?)", (p["id"], d, s_field(x, "name", 100)))
        h.con.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), p["id"]))
        moved = sync_plan_targets(h, p["id"])  # linked open tasks follow the new activity dates
    return {"ok": True, "tasksMoved": moved}


def _weeks_label(a, b):
    wa, wb = (a - 1) // 5 + 1, (b - 1) // 5 + 1
    return "Week %d" % wa if wa == wb else "Week %d–%d" % (wa, wb)


@route("GET", "/api/projects/([0-9]+)/export.xlsx")
def api_project_export(h, pid):
    """The plan in the layout of the team's Excel timeline: values only, no formulas."""
    p = get_project(h, pid)
    project_rights(h, p)
    pr = project_out(h, p, detail=True)
    C = xlsx.Cell
    cells, merges = {}, []
    ndays = max([it["endDay"] for ph in pr["phases"] for it in [ph] + ph["items"]] + [5])
    ndays = ((ndays + 4) // 5) * 5  # whole weeks
    G = 12  # first day column (M)
    head = dict(bold=True, fill="1F4E79", color="FFFFFF", align="center", border=True, wrap=True)
    cells[(0, 0)] = C("Project Title : %s" % pr["name"], bold=True, size=14)
    merges.append((0, 0, 0, 11))
    full = h.con.execute("SELECT full_name FROM clients WHERE name=?", (pr["client"],)).fetchone()
    cells[(1, 0)] = C("Client : %s%s     Project manager : %s     Status : %s" % (
        pr["client"] or "—", " (%s)" % full["full_name"] if full and full["full_name"] else "", pr["pmName"] or "—", pr["displayStatus"]), italic=True)
    merges.append((1, 0, 1, 11))
    cells[(2, 1)] = C("Project start date :", bold=True, align="right")
    cells[(2, 2)] = C(pr["startDate"], date=True, border=True, align="center")
    cells[(2, 4)] = C("Go-live:", bold=True, align="right")
    cells[(2, 6)] = C(pr["goLive"], date=True, border=True, align="center") if pr["goLive"] else C("—")
    cells[(2, 8)] = C("Activities completed:", bold=True, align="right")
    cells[(2, 9)] = C(round(pr["progress"], 4), pct=True, border=True, align="center")
    for i, t in enumerate(["No", "Phase / Activity", "Type", "Weeks", "Start Day", "End Day", "Start Date", "End Date", "Deliverable", "Owner", "Status", "Remarks"]):
        cells[(4, i)] = C(t, **head)
        merges.append((4, i, 6, i))
    td = pr["today"]
    for d in range(1, ndays + 1):
        c = G + d - 1
        if (d - 1) % 5 == 0:
            cells[(4, c)] = C("Week %d" % ((d - 1) // 5 + 1), **head)
            merges.append((4, c, 4, c + 4))
        cells[(5, c)] = C(d, bold=True, align="center", border=True, fill="D9E1F2", size=9)
        date = pr["calendar"][d - 1] if d - 1 < len(pr["calendar"]) else None
        if date is None:
            cal = workday_dates(pr["startDate"], {x["date"] for x in pr["holidays"]}, d)
            date = cal[d].isoformat()
        cells[(6, c)] = C(date[8:10] + "/" + date[5:7], align="center", border=True, size=8,
                          fill="C00000" if date == td else "F2F2F2", color="FFFFFF" if date == td else None, bold=date == td)
    status_fill = {"Completed": "C6EFCE", "In Progress": "DDEBF7", "At Risk": "FFC7CE"}
    r = 7
    for pi, ph in enumerate(pr["phases"]):
        dark, light = PHASE_COLOURS[pi % len(PHASE_COLOURS)]
        rows = [(str(pi + 1), ph, "Phase")] + [("%d.%d" % (pi + 1, ki + 1), k, k["kind"].capitalize()) for ki, k in enumerate(ph["items"])]
        for no, it, typ in rows:
            is_ph = typ == "Phase"
            base = dict(border=True, bold=is_ph, fill="F2F2F2" if is_ph else None)
            st = it["status"]
            remark = it["remarks"] + ("; " if it["remarks"] else "") + "Overdue" if it.get("overdue") and st != "Completed" else it["remarks"]
            vals = [no, ("" if is_ph else "   ") + it["name"], typ, _weeks_label(it["startDay"], it["endDay"]), it["startDay"], it["endDay"]]
            for i, v in enumerate(vals):
                cells[(r, i)] = C(v, align="center" if i in (0, 2, 3, 4, 5) else None, **base)
            cells[(r, 6)] = C(it["startDate"], date=True, align="center", **base)
            cells[(r, 7)] = C(it["endDate"], date=True, align="center", **base)
            cells[(r, 8)] = C(it.get("deliverable", "") if is_ph else "", wrap=True, **base)
            cells[(r, 9)] = C(it.get("owner", ""), **base)
            cells[(r, 10)] = C(st, align="center", border=True, bold=is_ph, fill=status_fill.get(st, "F2F2F2" if is_ph else None))
            cells[(r, 11)] = C(remark, wrap=True, **base)
            for d in range(1, ndays + 1):
                c = G + d - 1
                inside = it["startDay"] <= d <= it["endDay"]
                if typ == "Milestone":
                    cells[(r, c)] = C("◆" if d == it["endDay"] else "", align="center", border=True, color="1F4E79", bold=True)
                else:
                    cells[(r, c)] = C("", border=True, fill=(dark if is_ph else light) if inside else None)
            r += 1
    widths = {0: 6, 1: 46, 2: 10, 3: 11, 4: 6, 5: 6, 6: 11, 7: 11, 8: 30, 9: 18, 10: 12, 11: 30}
    for d in range(ndays):
        widths[G + d] = 4.2
    plan = xlsx.GridSheet("Plan", cells, widths, merges, freeze=(7, 2), heights={0: 22, 4: 18, 6: 28})
    hc = {(0, 0): C("Public Holidays (excluded from working days)", bold=True, size=13), (2, 0): C("Date", **head), (2, 1): C("Holiday", **head)}
    for i, x in enumerate(pr["holidays"]):
        hc[(3 + i, 0)] = C(x["date"], date=True, border=True, align="center")
        hc[(3 + i, 1)] = C(x["name"], border=True)
    hsheet = xlsx.GridSheet("Holidays", hc, {0: 14, 1: 40}, freeze=(3, 0))
    fname = re.sub(r"[^A-Za-z0-9 _-]", "", "%s %s Timeline %s" % (pr["client"], pr["name"], today().replace("-", ""))).strip() + ".xlsx"
    return ("file", xlsx.build_grid([plan, hsheet]), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fname)


# ---------------------------------------------------------------- routes: KPI & export
def kpi_range(h):
    y = dt.date.today().year
    frm = h.query.get("from") or "%d-01-01" % y
    to = h.query.get("to") or "%d-12-31" % y
    for v in (frm, to):
        if not DATE_RE.match(v):
            raise bad("Dates must be YYYY-MM-DD.")
    return frm, to


@route("GET", "/api/teams/([a-z0-9-]+)/kpi")
def api_kpi(h, tid):
    h.need_lead(tid)
    frm, to = kpi_range(h)
    ppl = [dict(r) for r in people_rows(h, tid)]
    return compute_kpi(h.team(tid), load_tasks(h, tid, approved_only=True), ppl, frm, to)


@route("GET", "/api/teams/([a-z0-9-]+)/export.xlsx")
def api_export(h, tid):
    role = h.need_member(tid)
    team = h.team(tid)
    tasks = load_tasks(h, tid)
    ppl = [dict(r) for r in people_rows(h, tid)]
    names = {p["key"]: p["name"] for p in ppl}
    td = today()
    head = ["Task No", "Categories", "Main Task / Project", "Task Progress", "Task Percentage", "Urgency", "Customer", "Lead Engineer",
            "Support Engineer", "Start Date", "Target Date", "Actual Date", "Status", "Target Approved"]
    nm = lambda a: " / ".join(k[len(OUTSIDE):] if is_outside(k) else names.get(k, k) for k in a)

    def rows(lst):
        return [head] + [[t["no"], t["category"], t["title"], t["progress"], t["percent"] / 100, t["urgency"], t["customer"], nm(t["lead"]),
                          nm(t["support"]), xlsx.Date(t["start_date"]), xlsx.Date(t["target"] or t["requested_target"]), xlsx.Date(t["actual_date"]),
                          status_of(t, td), "New task awaiting approval" if not t["approved"] else "" if not (t["target"] or t["requested_target"]) else ("Yes" if t["target"] else "Awaiting lead")]
                         for t in lst]
    fmt = {4: "pct"}
    widths = [8, 11, 34, 50, 10, 9, 18, 16, 18, 11, 11, 11, 17, 13]
    sheets = [xlsx.Sheet("Daily Task Tracker", rows([t for t in tasks if not is_archived(t, td)]), widths, fmt),
              xlsx.Sheet("Archive", rows([t for t in tasks if is_archived(t, td)]), widths, fmt)]
    if role in ("lead", "admin"):
        frm, to = kpi_range(h)
        K = compute_kpi(team, [t for t in tasks if t["approved"]], ppl, frm, to)
        c = K["config"]
        kh = ["Engineer", "Lead Tasks", "Support Tasks", "Total Tasks", "Lead On Time", "Lead Late", "Lead On-Time %", "Support On Time",
              "Support Late", "Support On-Time %", "Total On-Time %", "Completed Early", "Early %",
              "KPI Score (%d%%/%d%%)" % (round(c["onTime"] * 100), round(c["early"] * 100)), "KPI Rating"]
        kr = lambda r: [r["name"], r["C"], r["D"], r["E"], r["F"], r["G"], r["H"], r["I"], r["J"], r["K"], r["L"], r["M"], r["N"], r["O"], r["rating"]]
        krows = [kh] + [kr(r) for r in K["rows"]] + [kr(K["team"]), [], ["Period %s to %s (by actual date). Exported %s." % (frm, to, td)]]
        sheets.append(xlsx.Sheet("KPI Scorecard", krows, [14, 10, 12, 11, 11, 9, 13, 14, 12, 15, 14, 14, 9, 16, 18],
                                 {6: "pct", 9: "pct", 10: "pct", 12: "pct", 13: "pct"}, bold_rows={len(K["rows"]) + 1}))
        cats = K["categories"]
        sheets.append(xlsx.Sheet("Lead Tasks by Category", [["Engineer"] + cats + ["Total"]] +
                                 [[r["name"]] + [r["cats"][x] for x in cats] + [r["C"]] for r in K["rows"] if r["C"]], [14] + [11] * len(cats) + [8]))
    fname = re.sub(r"[^A-Za-z0-9 _-]", "", team["name"]) + " Task Tracker " + td + ".xlsx"
    return ("file", xlsx.build(sheets), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", fname)


# ---------------------------------------------------------------- admin: all teams
@route("GET", "/api/admin/teams")
def api_admin_teams(h):
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    out = []
    for t in h.con.execute("SELECT * FROM teams ORDER BY name COLLATE NOCASE"):
        ppl = h.con.execute("SELECT name, role, user_id FROM people WHERE team_id=? AND active=1", (t["id"],)).fetchall()
        out.append({"id": t["id"], "name": t["name"], "leads": [p["name"] for p in ppl if p["role"] == "lead"],
                    "people": len(ppl), "joined": sum(1 for p in ppl if p["user_id"]),
                    "open": h.con.execute("SELECT COUNT(*) FROM tasks WHERE team_id=? AND actual_date IS NULL", (t["id"],)).fetchone()[0],
                    "tasks": h.con.execute("SELECT COUNT(*) FROM tasks WHERE team_id=?", (t["id"],)).fetchone()[0]})
    return {"teams": out}


@route("DELETE", "/api/teams/([a-z0-9-]+)")
def api_team_delete(h, tid):
    """Administrators only. Deletes a team with its people, tasks, history, requests and customer logos.
    Logins stay (people may be in other teams). A full copy of the database is saved first."""
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    t = h.team(tid)
    if s_field(h.body, "confirm", 100).lower() != t["name"].strip().lower():
        raise bad("Type the team's name exactly to confirm: %s" % t["name"])
    folder = os.path.join(os.path.dirname(os.path.abspath(DB_PATH)), "backups")
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, "before-deleting-%s-%s.db" % (tid, dt.datetime.now().strftime("%Y%m%d-%H%M%S")))
    dst = sqlite3.connect(path)
    with WRITE_LOCK:
        h.con.backup(dst)
    dst.close()
    with Tx(h.con):
        counts = {k: h.con.execute("SELECT COUNT(*) FROM %s WHERE team_id=?" % k, (tid,)).fetchone()[0] for k in ("people", "tasks")}
        h.con.execute("DELETE FROM teams WHERE id=?", (tid,))  # people, tasks, task_log, change_requests, logos, invites cascade
    sys.stderr.write("Team '%s' (%s) deleted by %s; backup: %s\n" % (t["name"], tid, h.user["login"], path))
    return {"ok": True, "name": t["name"], "people": counts["people"], "tasks": counts["tasks"], "backup": path}


# ---------------------------------------------------------------- admin: administrators
@route("GET", "/api/admin/users")
def api_admin_users(h):
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    teams = {}
    for r in h.con.execute("SELECT p.user_id, t.name, p.role FROM people p JOIN teams t ON t.id=p.team_id WHERE p.active=1 AND p.user_id IS NOT NULL"):
        teams.setdefault(r["user_id"], []).append("%s (%s)" % (r["name"], "lead" if r["role"] == "lead" else "member"))
    return {"users": [{"id": u["id"], "login": u["login"], "name": u["display_name"], "isAdmin": bool(u["is_admin"]),
                       "isMe": u["id"] == h.user["id"], "teams": teams.get(u["id"], [])}
                      for u in h.con.execute("SELECT * FROM users WHERE disabled=0 ORDER BY is_admin DESC, display_name COLLATE NOCASE")]}


@route("PUT", "/api/admin/users/([0-9]+)")
def api_admin_user_update(h, uid):
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    uid = int(uid)
    want = 1 if h.body.get("isAdmin") else 0
    if uid == h.user["id"] and not want:
        raise bad("You can't remove your own administrator access. Ask another administrator.")
    with Tx(h.con):
        if not h.con.execute("SELECT 1 FROM users WHERE id=? AND disabled=0", (uid,)).fetchone():
            raise NOT_FOUND
        h.con.execute("UPDATE users SET is_admin=? WHERE id=?", (want, uid))
    return {"ok": True}


# ---- customers across teams (administrators). Each team keeps its own list in teams.customers;
# this view edits those lists together and keeps each customer's logo the same in every team.
def _team_customer_lists(con):
    return [(r["id"], r["name"], json.loads(r["customers"])) for r in con.execute("SELECT id, name, customers FROM teams ORDER BY name COLLATE NOCASE")]


def client_scope(h):
    """Teams whose client list this person may manage: every team for an administrator, else the teams they lead."""
    u = h.need_user()
    if u["is_admin"]:
        return {r["id"] for r in h.con.execute("SELECT id FROM teams")}
    tids = {r["team_id"] for r in h.con.execute("SELECT team_id FROM people WHERE user_id=? AND active=1 AND role='lead'", (u["id"],))}
    if not tids:
        raise FORBIDDEN
    return tids


@route("GET", "/api/admin/customers")
def api_admin_customers(h):
    scope = client_scope(h)
    teams = [t for t in _team_customer_lists(h.con) if t[0] in scope]
    names = {}
    for tid, _, custs in teams:
        for c in custs:
            names.setdefault(c.lower(), {"name": c, "teams": []})["teams"].append(tid)
    open_counts = {}
    for r in h.con.execute("SELECT LOWER(customer) AS c, COUNT(*) AS n FROM tasks WHERE actual_date IS NULL AND customer<>'' GROUP BY LOWER(customer)"):
        open_counts[r["c"]] = r["n"]
    logos = {}
    for r in h.con.execute("SELECT id, team_id, name, updated_at FROM customer_logos ORDER BY updated_at DESC"):
        logos.setdefault(r["name"].lower(), "/api/teams/%s/logos/%d?v=%s" % (r["team_id"], r["id"], re.sub(r"\D", "", r["updated_at"])))
    full = {r["name"].lower(): r["full_name"] for r in h.con.execute("SELECT name, full_name FROM clients")}
    out = sorted(({"name": v["name"], "fullName": full.get(k, ""), "teams": v["teams"], "openTasks": open_counts.get(k, 0), "logo": logos.get(k)}
                  for k, v in names.items()), key=lambda x: x["name"].lower())
    return {"teams": [{"id": t, "name": n} for t, n, _ in teams], "customers": out, "isAdmin": bool(h.user["is_admin"])}


@route("PUT", "/api/admin/customers")
def api_admin_customer_put(h):
    """Add a client, change its full name, or change which teams it belongs to. Body: {name, fullName?, teams: [team ids]}.
    Team leads can only add or remove their own teams; other teams keep the client as they are."""
    scope = client_scope(h)
    name = s_field(h.body, "name", 100, True)
    want = h.body.get("teams")
    if not isinstance(want, list) or not all(isinstance(x, str) for x in want):
        raise bad("teams must be a list of team ids.")
    with Tx(h.con):
        teams = _team_customer_lists(h.con)
        known = {t for t, _, _ in teams}
        if set(want) - known:
            raise bad("Unknown team: %s" % ", ".join(sorted(set(want) - known)))
        if set(want) - scope:
            raise FORBIDDEN
        # teams outside this person's scope keep the client exactly as they are
        want = list(set(want) | {t for t, _, custs in teams if t not in scope and any(c.lower() == name.lower() for c in custs)})
        # keep the spelling already in use, if any team has this customer
        for _, _, custs in teams:
            for c in custs:
                if c.lower() == name.lower():
                    name = c
        logo = h.con.execute("SELECT png FROM customer_logos WHERE LOWER(name)=LOWER(?) ORDER BY updated_at DESC LIMIT 1", (name,)).fetchone()
        for tid, _, custs in teams:
            has = any(c.lower() == name.lower() for c in custs)
            if tid in want and not has:
                if len(custs) >= 300:
                    raise bad("A team can have at most 300 customers.")
                custs = sorted(custs + [name], key=str.lower)
                if logo:  # the customer's logo follows it into the new team
                    h.con.execute("INSERT OR IGNORE INTO customer_logos(team_id,name,png,updated_by,updated_at) VALUES(?,?,?,?,?)",
                                  (tid, name, logo["png"], h.user["id"], now_iso()))
            elif tid not in want and has:
                custs = [c for c in custs if c.lower() != name.lower()]
                h.con.execute("DELETE FROM customer_logos WHERE team_id=? AND LOWER(name)=LOWER(?)", (tid, name))
            else:
                continue
            h.con.execute("UPDATE teams SET customers=? WHERE id=?", (json.dumps(custs), tid))
        if "fullName" in h.body:
            full = s_field(h.body, "fullName", 150)
            h.con.execute("INSERT INTO clients(name, full_name, created_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET full_name=excluded.full_name",
                          (name, full, now_iso()))
    return {"ok": True, "name": name}


@route("PUT", "/api/admin/customers/logo")
def api_admin_customer_logo(h):
    """Set or clear one customer's logo in every team that has the customer. Body: {name, png} (png empty = use initials)."""
    scope = client_scope(h)
    name = s_field(h.body, "name", 100, True)
    data = h.body.get("png") or ""
    raw = None
    if data:
        if not isinstance(data, str) or len(data) > LOGO_MAX_BYTES * 2:
            raise bad("png must be base64 text.")
        try:
            raw = check_png(base64.b64decode(data.split(",", 1)[-1], validate=True))
        except ValueError:
            raise bad("png must be base64 text.")
    with Tx(h.con):
        tids = [t for t, _, custs in _team_customer_lists(h.con) if t in scope and any(c.lower() == name.lower() for c in custs)]
        if not tids:
            raise bad("No team has the customer '%s'. Assign it to a team first." % name)
        for tid in tids:
            if raw is None:
                h.con.execute("DELETE FROM customer_logos WHERE team_id=? AND LOWER(name)=LOWER(?)", (tid, name))
            else:
                h.con.execute("DELETE FROM customer_logos WHERE team_id=? AND LOWER(name)=LOWER(?) AND name<>?", (tid, name, name))
                h.con.execute("INSERT INTO customer_logos(team_id,name,png,updated_by,updated_at) VALUES(?,?,?,?,?) "
                              "ON CONFLICT(team_id,name) DO UPDATE SET png=excluded.png, updated_by=excluded.updated_by, updated_at=excluded.updated_at",
                              (tid, name, raw, h.user["id"], now_iso()))
    return {"ok": True, "teams": len(tids)}


@route("POST", "/api/admin/invite")
def api_admin_invite(h):
    """A one-time link that creates a new administrator account (for someone not yet using the tracker)."""
    if not h.need_user()["is_admin"]:
        raise FORBIDDEN
    with Tx(h.con):
        tok, exp = make_link(h, "setup", created_by=h.user["id"])
    return {"url": "%s/#invite=%s" % (h.base_url(), tok), "expires": exp}


# ---------------------------------------------------------------- CLI
def admin_link():
    init_db()
    con = connect()

    class H:  # minimal shim for make_link
        pass
    h = H()
    h.con = con
    admin = con.execute("SELECT * FROM users WHERE is_admin=1 ORDER BY id LIMIT 1").fetchone()
    with Tx(con):
        if admin:
            tok, exp = make_link(h, "reset", user_id=admin["id"])
            what = "reset the password for administrator '%s'" % admin["login"]
        else:
            con.execute("DELETE FROM invites WHERE kind='setup' AND used_at IS NULL")
            tok, exp = make_link(h, "setup")
            what = "create the administrator account"
    con.close()
    base = BASE_URL or "http://<this-server>:%s" % os.environ.get("TT_PORT", "8080")
    print("Open this link within %d days to %s:\n\n  %s/#invite=%s\n" % (INVITE_DAYS, what, base, tok), flush=True)


def backup(dest):
    init_db()
    src = connect()
    dst = sqlite3.connect(dest)
    src.backup(dst)
    dst.close()
    src.close()
    print("Backup written to", dest)


def serve():
    init_db()
    con = connect()
    if not con.execute("SELECT 1 FROM users WHERE is_admin=1").fetchone():
        con.close()
        print("No administrator yet.", flush=True)
        admin_link()
    else:
        con.close()
    host = os.environ.get("TT_HOST", "0.0.0.0")
    port = int(os.environ.get("TT_PORT", "8080"))
    srv = ThreadingHTTPServer((host, port), Handler)
    srv.daemon_threads = True
    print("Team Task Tracker listening on %s:%d" % (host, port), flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "serve"
    if cmd == "serve":
        serve()
    elif cmd == "admin-link":
        admin_link()
    elif cmd == "backup" and len(sys.argv) == 3:
        backup(sys.argv[2])
    elif cmd == "import-xlsm":
        import argparse
        import xlsm_import
        ap = argparse.ArgumentParser(prog="server.py import-xlsm", description="Create a team from its Daily Task Tracker workbook.")
        ap.add_argument("file")
        ap.add_argument("--team", required=True, help='team name, e.g. "Team Automation"')
        ap.add_argument("--lead", action="append", default=[], help="name of the team lead as written in the workbook (repeatable)")
        ap.add_argument("--dry-run", action="store_true", help="check the workbook and show what would be imported")
        a = ap.parse_args(sys.argv[2:])
        data, problems = xlsm_import.read_workbook(a.file, a.team, a.lead)
        print("Workbook: %d tasks (%d completed), %d people: %s" % (
            len(data["tasks"]), sum(1 for t in data["tasks"] if t["actualDate"]), len(data["people"]),
            ", ".join(p["name"] + (" (lead)" if p["role"] == "lead" else "") for p in data["people"])))
        for p in problems:
            print("  note:", p)
        if not a.dry_run:
            init_db()
            print("Imported team '%s': %d people, %d tasks." % import_team(connect(), data))
    elif cmd == "sync-xlsm":
        import argparse
        import xlsm_import
        ap = argparse.ArgumentParser(prog="server.py sync-xlsm", description="Update an existing team from a newer copy of its workbook.")
        ap.add_argument("file")
        ap.add_argument("--team-id", required=True, help="team id as shown in the tracker's address list, e.g. team-automation")
        ap.add_argument("--dry-run", action="store_true", help="show what would change without saving anything")
        a = ap.parse_args(sys.argv[2:])
        init_db()
        data, problems = xlsm_import.read_workbook(a.file, a.team_id, [])
        for p in problems:
            print("  note:", p)
        try:
            rep = sync_team(connect(), a.team_id, data, a.dry_run)
        except _DryRun as d:
            rep = d.report
        print("%s %d tasks updated: %s" % ("Would update" if a.dry_run else "Updated", len(rep["updated"]), rep["updated"]))
        print("New tasks added: %s" % (rep["added"] or "none"))
        print("Target kept because the workbook has no valid date: %s" % (rep["kept_target"] or "none"))
        print("In the tracker but not in the workbook (kept): %s" % (rep["missing"] or "none"))
        print("New people added: %s" % (rep["new_people"] or "none"))
        if a.dry_run:
            print("Dry run: nothing was saved.")
    elif cmd == "make-admin" and len(sys.argv) == 3:
        init_db()
        con = connect()
        with Tx(con):
            n = con.execute("UPDATE users SET is_admin=1 WHERE login=? AND disabled=0", (sys.argv[2].lower(),)).rowcount
        print("'%s' is now an administrator." % sys.argv[2] if n else "No account uses the login '%s'." % sys.argv[2])
    elif cmd == "invite-admin":
        init_db()
        con = connect()

        class _H:
            pass
        hh = _H()
        hh.con = con
        with Tx(con):
            tok, exp = make_link(hh, "setup")
        base = BASE_URL or "http://<this-server>:%s" % os.environ.get("TT_PORT", "8080")
        print("Send this one-time link to the new administrator (valid %d days):\n\n  %s/#invite=%s\n" % (INVITE_DAYS, base, tok))
    elif cmd == "import-logos":
        import argparse
        import zipfile
        ap = argparse.ArgumentParser(prog="server.py import-logos", description="Load customer icons from PNG files named after the customers, e.g. 'Hong Leong Bank.png'.")
        ap.add_argument("source", help="folder or .zip file with the PNG files")
        ap.add_argument("--team-id", required=True, help="team id, e.g. team-a")
        ap.add_argument("--replace", action="store_true", help="also replace logos that are already set (by default they are kept)")
        ap.add_argument("--dry-run", action="store_true", help="show what would happen without saving anything")
        a = ap.parse_args(sys.argv[2:])
        files = {}
        if zipfile.is_zipfile(a.source):
            with zipfile.ZipFile(a.source) as z:
                for n in z.namelist():
                    if n.lower().endswith(".png") and not n.endswith("/"):
                        files[os.path.splitext(os.path.basename(n))[0]] = z.read(n)
        elif os.path.isdir(a.source):
            for n in sorted(os.listdir(a.source)):
                if n.lower().endswith(".png"):
                    with open(os.path.join(a.source, n), "rb") as f:
                        files[os.path.splitext(n)[0]] = f.read()
        else:
            sys.exit("Not a folder or .zip file: %s" % a.source)
        init_db()
        con = connect()
        row = con.execute("SELECT customers FROM teams WHERE id=?", (a.team_id,)).fetchone()
        if not row:
            sys.exit("No team with id '%s'. Team ids are shown in the address list on All Teams." % a.team_id)
        by_lower = {c.lower(): c for c in json.loads(row["customers"])}
        have = {r["name"] for r in con.execute("SELECT name FROM customer_logos WHERE team_id=?", (a.team_id,))}
        saved = 0
        with Tx(con):
            for stem, raw in sorted(files.items()):
                name = by_lower.get(stem.strip().lower())
                if not name:
                    print("  skip  %-22s no customer with this name in the team" % stem)
                    continue
                if name in have and not a.replace:
                    print("  keep  %-22s already has a logo (use --replace to overwrite)" % name)
                    continue
                try:
                    check_png(raw)
                except ApiError as e:
                    print("  skip  %-22s %s" % (name, e.msg))
                    continue
                if not a.dry_run:
                    con.execute("INSERT INTO customer_logos(team_id,name,png,updated_by,updated_at) VALUES(?,?,?,NULL,?) "
                                "ON CONFLICT(team_id,name) DO UPDATE SET png=excluded.png, updated_by=NULL, updated_at=excluded.updated_at",
                                (a.team_id, name, raw, now_iso()))
                saved += 1
                print("  %s %s" % ("would set" if a.dry_run else "set  ", name))
        print("%s %d logo(s) for team '%s'." % ("Dry run: would save" if a.dry_run else "Saved", saved, a.team_id))
    elif cmd == "import" and len(sys.argv) == 3:
        init_db()
        with open(sys.argv[2], encoding="utf-8") as f:
            res = import_team(connect(), json.load(f))
        print("Imported team '%s': %d people, %d tasks." % res)
    else:
        print(__doc__)
        sys.exit(2)
