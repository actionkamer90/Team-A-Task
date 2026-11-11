"use strict";
/* Help tab: user guide, data model diagram and the README (setup guide).
   Loaded before app.js; uses its helpers (h, S, store, isLead, render) only when called. */

const HELP_SECTIONS = [["guide", "User guide"], ["model", "Data model"], ["readme", "Setup guide (README)"]];

function helpView(main, standalone) {
  let section = store.get("tt.help") || "guide";
  if (!HELP_SECTIONS.some(s => s[0] === section)) section = "guide";
  const body = h("div", { class: "help-body" });
  const tabs = h("div", { class: "seg help-seg", role: "tablist", "aria-label": "Help sections" });
  const show = id => {
    section = id; store.set("tt.help", id);
    tabs.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.id === id)));
    body.replaceChildren(id === "guide" ? helpGuide() : id === "model" ? helpModel() : helpReadme());
  };
  HELP_SECTIONS.forEach(([id, label]) => tabs.append(h("button", { type: "button", role: "tab", "data-id": id, text: label, onclick: () => show(id) })));
  main.append(h("div", { class: "row between" }, h("h2", { text: "Help" }),
    standalone ? h("button", { class: "btn", text: "Back to log in", onclick: () => { S.publicHelp = false; render(); } }) : null),
    tabs, body);
  show(section);
}

/* ---------- user guide ---------- */
const P = (...kids) => h("p", {}, ...kids);
const C = s => h("code", { text: s });
const B = s => h("b", { text: s });
function helpTable(head, rows) {
  return h("div", { class: "tscroll help-table" }, h("table", {}, h("thead", {}, h("tr", {}, head.map(c => h("th", { text: c })))),
    h("tbody", {}, rows.map(r => h("tr", {}, r.map(c => h("td", {}, c)))))));
}
function helpGuide() {
  const sec = (id, title, ...kids) => h("section", { class: "help-sec", id: "help-" + id }, h("h3", { text: title }), ...kids);
  const list = items => h("ul", {}, items.map(i => h("li", {}, i)));
  const steps = items => h("ol", {}, items.map(i => h("li", {}, i)));
  const toc = [["start", "Getting started"], ["roles", "Who can do what"], ["tracker", "Tracker tab"], ["status", "What each status means"],
    ["update", "Adding and updating tasks"], ["approve", "Approvals and My Requests"], ["archive", "Archive"], ["summary", "Summary"],
    ["kpi", "KPI Dashboard"], ["team", "Team & Invites"], ["admin", "All Teams (administrators)"], ["export", "Export to Excel"]];
  return h("div", { class: "help-guide" },
    h("nav", { class: "help-toc", "aria-label": "User guide contents" }, h("span", { class: "lbl", text: "On this page" }),
      h("ul", {}, toc.map(([id, t]) => h("li", {}, h("a", { href: "#help-" + id, text: t, onclick: e => { e.preventDefault(); document.getElementById("help-" + id)?.scrollIntoView({ block: "start" }); } }))))),
    h("div", { class: "help-text" },
      sec("start", "Getting started",
        P("The tracker replaces the Excel Daily Task Tracker. Everyone in a team works on the same live list, and every change is saved with who made it."),
        list([
          [B("Logging in. "), "Use the login and password you chose when you opened your invite link."],
          [B("Forgot your password? "), "Ask your team lead for a password reset link. Links work once and expire after 7 days."],
          [B("Several teams? "), "Pick the team in the box at the top of the page. Your role can be different in each team."],
          [B("Your account. "), "Click your name at the top right to change your password or log out."],
          [B("Staying up to date. "), "The page refreshes your team's tasks every 30 seconds. When the tracker itself is updated, a bar asks you to reload."],
        ])),
      sec("roles", "Who can do what",
        helpTable(["Role", "Can do"], [
          [B("Member"), "See the team's tasks. Add tasks you lead. Change tasks where you are a Lead Engineer; the changes save straight away. A new target date, or a completed date earlier than today, waits for the team lead's approval. Support engineers can see a task but not change it."],
          [B("Team lead"), "Change any task in the team directly. Approve or reject proposed target dates and backdated completions. See the KPI Dashboard. Invite and remove members. Edit the team's categories, customers and KPI settings."],
          [B("Administrator"), "Everything, on every team. Create teams, add team leads and manage other administrators."],
        ])),
      sec("tracker", "Tracker tab",
        P("Shows the team's tasks that are not yet archived."),
        list([
          [B("Tiles "), "at the top count open, on-going, delayed and unapproved tasks, and tasks with no target date. They follow your filters, so with ", B("Only my tasks"), " ticked they show your own numbers."],
          [B("Filters: "), "search (task, customer, progress note or name), engineer, status, category and urgency."],
          [B("Sorting: "), "click any column header to sort by it, and click again to reverse. On a phone, use the ", B("Sort by"), " menu above the table. The tracker remembers your choice. By default, delayed tasks come first, then on-going, then tasks with no target, each with the nearest target date first."],
          [B("Open a task "), "by clicking its row (or Tab to it and press Enter)."],
        ])),
      sec("status", "What each status means",
        P("Status is worked out from the dates every time you look, the same way as the Excel formula. Nobody sets it by hand."),
        helpTable(["Status", "When"], [
          [h("span", { class: "pill info", text: "On-Going" }), "Not finished, target date is today or later."],
          [h("span", { class: "pill bad", text: "Delay" }), "Not finished, target date has passed."],
          [h("span", { class: "pill warn", text: "No Target" }), "Not finished and no target date yet."],
          [h("span", { class: "pill ok", text: "Completed Early" }), "Actual (completed) date is before the target date."],
          [h("span", { class: "pill ok", text: "Completed On Time" }), "Actual date is the target date."],
          [h("span", { class: "pill warn", text: "Completed Late" }), "Actual date is after the target date."],
          [h("span", { class: "pill ok", text: "Completed" }), "Finished, but the task never had a target date."],
        ]),
        P("A date shown with ", h("span", { class: "pending", text: "awaiting lead" }), " is a target proposed by a member that the team lead hasn't approved yet.")),
      sec("update", "Adding and updating tasks",
        steps([
          ["Click ", B("+ New task"), ". Fill in the main task, category, urgency, customer, Lead and Support engineers, start date and target date."],
          ["Write progress in ", B("Task progress"), ", one update per line. ", B("Add dated update"), " starts a new line with today's date."],
          ["Move the percentage as work goes on."],
          ["When the work is done, set the ", B("Actual date"), ". The task moves to the Archive 2 days later."],
        ]),
        list([
          ["Only the task's Lead Engineers and the team lead can change it. Support engineers can view it."],
          ["Changing the target date, or entering a completed date earlier than today, sends a request to the team lead. Other changes save immediately."],
          ["The task's ", B("History"), " lists every change: who, when, and what it was before."],
        ])),
      sec("approve", "Approvals and My Requests",
        list([
          [B("Approvals "), "(team leads): proposed target dates and backdated completions wait here. Approve, or reject with a reason."],
          [B("My Requests "), "(members): the requests you sent in the last 30 days and what the lead decided."],
        ])),
      sec("archive", "Archive",
        P("Finished tasks appear here 2 days after their actual date. Search, filter and sort work the same as on the Tracker; by default the most recently completed tasks come first. Open a task to read its history.")),
      sec("summary", "Summary",
        P("Task load by engineer (open tasks, as lead or support) and open tasks by customer. Useful for spreading work in the morning stand-up.")),
      sec("kpi", "KPI Dashboard (team leads)",
        P("Scores each engineer on tasks completed in the chosen period:"),
        P(B("KPI = On-time % × 80% + Early % × 20%")),
        P("Every lead and support involvement counts. Ratings: Excellent from 90%, Good from 70%, Needs Improvement from 60%, otherwise At Risk. The weights and thresholds can be changed under ", B("KPI settings"), ".")),
      sec("team", "Team & Invites (team leads)",
        steps([
          [B("+ Add person"), ": enter their name and choose Member or Team lead."],
          [B("Create an invite link"), " on their row and send it to them privately (Teams chat or email)."],
          ["They open the link, choose a login and password, and they're in. The link works once and expires after 7 days."],
        ]),
        list([
          ["Someone who already has a login (from another team) can be added by their login instead."],
          ["Forgotten password: use ", B("Reset password link"), " on their row and send them the new link."],
        ])),
      sec("admin", "All Teams (administrators)",
        P("Create teams, open any team, and manage administrators. To start a new team: create it, add its lead on Team & Invites, and send the lead an invite link. The lead invites the rest.")),
      sec("export", "Export to Excel",
        P(B("Export to Excel"), " on the Tracker and Archive downloads an .xlsx file with the Daily Task Tracker and Archive sheets. Team leads also get the KPI Scorecard and Lead Tasks by Category sheets for the KPI period."),
        P("Questions the guide doesn't answer? Ask your team lead or the tracker's administrator. Server and setup details are under ", B("Setup guide (README)"), "."))));
}

/* ---------- data model diagram ---------- */
// Matches SCHEMA in server.py; tests/test_help.py checks that every table and column is listed here.
const ERD_GROUPS = { id: ["Logins and access", "help-g-id"], team: ["Teams and people", "help-g-team"], work: ["Tasks and approvals", "help-g-work"] };
const ERD_TABLES = [
  { n: "users", g: "id", x: 20, y: 20, why: "One login per person, valid across all teams. Holds the password hash and the administrator flag.",
    f: [["id", "PK", ""], ["login", "UQ", "case-insensitive"], ["display_name", "", ""], ["pw_hash", "", "salted hash"], ["is_admin", "", "0 / 1, all teams"], ["disabled", "", "0 / 1"], ["created_at", "", ""]] },
  { n: "sessions", g: "id", x: 20, y: 300, why: "A signed-in browser. Only the hash of the cookie token is stored. Deleted with the user.",
    f: [["token_hash", "PK", "sha-256 of cookie"], ["user_id", "FK", "→ users.id"], ["created_at", "", ""], ["expires_at", "", ""]] },
  { n: "invites", g: "id", x: 20, y: 500, why: "One-time links: join a team, reset a password, or create the first administrator. Valid for 7 days; used_at is set once it is used.",
    f: [["token_hash", "PK", "sha-256 of link"], ["kind", "", "invite · reset · setup"], ["person_id", "FK", "→ people.id (invite)"], ["user_id", "FK", "→ users.id (reset)"], ["created_by", "user", "link creator"], ["created_at", "", ""], ["expires_at", "", ""], ["used_at", "", "empty until used"]] },
  { n: "teams", g: "team", x: 430, y: 20, why: "A team, such as Team A. Its own lists and KPI settings are stored on this row as JSON.",
    f: [["id", "PK", "slug, e.g. team-a"], ["name", "", ""], ["categories", "JSON", "Pre-Sales, Project…"], ["customers", "JSON", "Affin, RHB…"], ["kpi", "JSON", "KPI weights"], ["created_at", "", ""]] },
  { n: "people", g: "team", x: 430, y: 290, why: "A person's membership of one team and their role there. Can exist without a login (imported names); user_id links the login later.",
    f: [["id", "PK", ""], ["team_id", "FK", "→ teams.id"], ["key", "UQ", "unique per team"], ["name", "", ""], ["role", "", "lead · member"], ["user_id", "FK", "→ users.id, optional"], ["active", "", "0 / 1"], ["created_at", "", ""]] },
  { n: "tasks", g: "work", x: 840, y: 20, why: "The daily task tracker rows. Task no is unique within a team. Status and archive state are calculated from the dates.",
    f: [["id", "PK", ""], ["team_id", "FK", "→ teams.id"], ["no", "UQ", "unique per team"], ["category", "", ""], ["title", "", "main task / project"], ["progress", "", "free text"], ["percent", "", "0–100"], ["urgency", "", "Low…Critical"], ["customer", "", ""], ["lead", "JSON", "[people.key]"], ["support", "JSON", "[people.key]"], ["start_date", "", ""], ["requested_target", "", "member's date"], ["target", "", "lead-approved date"], ["target_set_by / _at", "user", ""], ["actual_date", "", "completed"], ["created_by / _at", "user", ""], ["updated_by / _at", "user", ""], ["approved, imported", "", "0 / 1"]] },
  { n: "change_requests", g: "work", x: 840, y: 522, why: "Changes waiting for the team lead: a new target date or a backdated completion. Holds the proposed values and the decision.",
    f: [["id", "PK", ""], ["task_id", "", "→ tasks.id, no FK"], ["team_id", "FK", "→ teams.id"], ["kind", "", "create · edit"], ["data", "JSON", "proposed fields"], ["by_user", "user", "who asked"], ["at", "", ""], ["status", "", "pending · approved · rejected"], ["note", "", "lead's reason"], ["decided_by / _at", "user", ""]] },
  { n: "task_log", g: "work", x: 840, y: 812, why: "Change history. One row per create or edit, listing which fields changed from what to what.",
    f: [["id", "PK", ""], ["task_id", "FK", "→ tasks.id"], ["at", "", "timestamp"], ["user_id", "user", "empty = import"], ["kind", "", "create · edit"], ["changes", "JSON", "[field, old, new]"]] },
];
// from (the "1" side) → to (the "many" side); via = x of the vertical segment
const ERD_LINKS = [
  { a: ["users", "bottom"], b: ["sessions", "top"], la: "1", lb: "N" },
  { a: ["users", "id", "r"], b: ["people", "user_id", "l"], via: 392, la: "1", lb: "0..N" },
  { a: ["users", "id", "l"], b: ["invites", "user_id", "l"], via: 8, la: "1", lb: "N" },
  { a: ["people", "id", "l"], b: ["invites", "person_id", "r"], via: 404, la: "1", lb: "N" },
  { a: ["teams", "bottom"], b: ["people", "top"], la: "1", lb: "N" },
  { a: ["teams", "id", "r"], b: ["tasks", "team_id", "l"], via: 795, la: "1", lb: "N" },
  { a: ["teams", "name", "r"], b: ["change_requests", "team_id", "l"], via: 772, la: "1", lb: "N" },
  { a: ["tasks", "bottom"], b: ["change_requests", "top"], la: "1", lb: "N", soft: true },
  { a: ["tasks", "id", "r"], b: ["task_log", "task_id", "r"], via: 1172, la: "1", lb: "N" },
  { a: ["people", "key", "r"], b: ["tasks", "lead", "l"], via: 806, la: "key", lb: "lead, support", soft: true },
];
function erdSvg(onPick) {
  const NS = "http://www.w3.org/2000/svg", W = 320, HEAD = 40, ROW = 22, PAD = 6;
  const T = ERD_TABLES.map(t => ({ ...t, h: HEAD + t.f.length * ROW + PAD }));
  const by = Object.fromEntries(T.map(t => [t.n, t]));
  const rowY = (t, col) => t.y + HEAD + t.f.findIndex(f => f[0] === col) * ROW + ROW / 2;
  const pt = ([tn, col, side]) => {
    const t = by[tn];
    if (col === "top") return [t.x + W / 2, t.y];
    if (col === "bottom") return [t.x + W / 2, t.y + t.h];
    return [side === "l" ? t.x : t.x + W, rowY(t, col)];
  };
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
  const txt = (s, attrs, parent) => { const e = el("text", attrs, parent); e.textContent = s; return e; };
  const maxY = Math.max(...T.map(t => t.y + t.h)) + 16;
  const svg = el("svg", { class: "erd", viewBox: "0 0 1180 " + maxY, role: "img", "aria-label": "Database tables and how they connect" });
  const root = el("g", { transform: "translate(0,8)" }, svg);
  const rel = el("g", {}, root);
  for (const r of ERD_LINKS) {
    const [x1, y1] = pt([r.a[0], r.a[1], r.a[2] || "r"]), [x2, y2] = pt([r.b[0], r.b[1], r.b[2] || "l"]);
    const soft = r.soft ? " soft" : "";
    el("path", { d: r.via === undefined ? `M${x1},${y1} V${y2}` : `M${x1},${y1} H${r.via} V${y2} H${x2}`, class: "erd-rel" + soft }, rel);
    el("circle", { cx: x1, cy: y1, r: 3, class: "erd-dot" + soft }, rel);
    const lab = (s, x, y, anchor) => txt(s, { x, y, class: "erd-card" + soft, "text-anchor": anchor }, rel);
    if (r.via === undefined) { lab(r.la, x1 + 7, y1 + 14, "start"); lab(r.lb, x2 + 7, y2 - 6, "start"); }
    else if (r.via > x1 && r.via > x2) { lab(r.la, x1 + 4, y1 - 5, "start"); lab(r.lb, x2 + 4, y2 - 5, "start"); }
    else {
      const dA = r.via > x1 ? 1 : -1, dB = x2 > r.via ? 1 : -1;
      lab(r.la, x1 + dA * 6, y1 - 5, dA > 0 ? "start" : "end"); lab(r.lb, x2 - dB * 6, y2 - 5, dB > 0 ? "end" : "start");
    }
  }
  const pending = [];
  for (const t of T) {
    const g = el("g", { class: "erd-ent", tabindex: "0", role: "button", "aria-label": t.n + " table: show details" }, root);
    el("rect", { x: t.x, y: t.y, width: W, height: t.h, rx: 7, class: "erd-box" }, g);
    el("path", { d: `M${t.x},${t.y + 7} a7,7 0 0 1 7,-7 h${W - 14} a7,7 0 0 1 7,7 v${HEAD - 7} h-${W} z`, class: "erd-head " + ERD_GROUPS[t.g][1] }, g);
    txt(t.n, { x: t.x + 12, y: t.y + 25, class: "erd-name" }, g);
    t.f.forEach(([c, tag, note], i) => {
      const y = t.y + HEAD + i * ROW;
      if (i) el("line", { x1: t.x + 8, x2: t.x + W - 8, y1: y, y2: y, class: "erd-row" }, g);
      const name = txt(c, { x: t.x + 12, y: y + 15, class: "erd-col" + (tag === "PK" || tag === "UQ" ? " key" : "") }, g);
      if (tag) pending.push([name, txt(tag === "user" ? "→user" : tag, { x: 0, y: y + 15, class: "erd-tag t-" + (tag === "user" || (tag === "JSON" && (c === "lead" || c === "support")) ? "soft" : tag === "JSON" ? "json" : tag === "PK" || tag === "UQ" ? "key" : "fk") }, g), t.x + 12]);
      if (note) txt(note, { x: t.x + W - 10, y: y + 15, class: "erd-note", "text-anchor": "end" }, g);
    });
    el("rect", { x: t.x, y: t.y, width: W, height: t.h, rx: 7, class: "erd-frame" }, g);
    g.addEventListener("click", () => onPick(t.n));
    g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(t.n); } });
  }
  // place the PK / FK / JSON tags right after each column name, once the text can be measured
  requestAnimationFrame(() => pending.forEach(([name, tag, x]) => { let w = 0; try { w = name.getComputedTextLength(); } catch { } tag.setAttribute("x", x + (w || name.textContent.length * 7.2) + 8); }));
  return svg;
}
function helpModel() {
  const tagChip = tag => !tag ? null : h("span", { class: "help-tag t-" + (tag === "user" ? "soft" : tag === "JSON" ? "json" : tag === "PK" || tag === "UQ" ? "key" : "fk"),
    text: tag === "UQ" ? "UNIQUE" : tag === "user" ? "USER ID" : tag });
  const cards = h("div", { class: "help-ref" }, ERD_TABLES.map(t => h("article", { class: "help-tcard", id: "erd-" + t.n },
    h("header", { class: ERD_GROUPS[t.g][1] }, h("span", { class: "mono", text: t.n }), h("span", { class: "lbl", text: ERD_GROUPS[t.g][0] })),
    h("p", { class: "why", text: t.why }),
    h("table", {}, h("tbody", {}, t.f.map(([c, tag, note]) => h("tr", {}, h("td", {}, h("span", { class: "mono", text: c }), tagChip(tag)), h("td", { class: "muted", text: note }))))))));
  const pick = n => { const c = document.getElementById("erd-" + n); if (!c) return; c.scrollIntoView({ block: "start" }); c.classList.add("flash"); setTimeout(() => c.classList.remove("flash"), 1600); };
  const legend = h("div", { class: "help-legend" },
    Object.values(ERD_GROUPS).map(([label, cls]) => h("span", {}, h("i", { class: "sw " + cls }), label)),
    h("span", {}, h("i", { class: "ln" }), "Foreign key in the database"), h("span", {}, h("i", { class: "ln soft" }), "Link kept by the code only"));
  return h("div", { class: "help-model" },
    h("p", { class: "muted m0" }, "How the tracker stores its data: eight tables in one SQLite file (", C("/data/tracker.db"), "). Logins on the left, teams and their people in the middle, the work on the right. Click a table for its details."),
    h("div", { class: "panel help-fig" }, legend, h("div", { class: "tscroll" }, erdSvg(pick))),
    h("div", { class: "help-points" },
      h("div", {}, h("h3", { text: "A login is not a team member" }), P(C("users"), " is one account per person. ", C("people"), " is one row per person per team, with their role there, so one login can lead one team and be a member of another. Administrator is a flag on ", C("users"), ".")),
      h("div", {}, h("h3", { text: "Everything a team owns hangs off teams.id" }), P(C("people"), ", ", C("tasks"), " and ", C("change_requests"), " carry ", C("team_id"), ", and the server only returns rows for teams you belong to. The team's categories, customers and KPI weights are JSON on the team row.")),
      h("div", {}, h("h3", { text: "Tasks name people by key" }), P(C("tasks.lead"), " and ", C("tasks.support"), " are lists of ", C("people.key"), ", so imported tasks work before anyone has a login. ", C("people.user_id"), " links the login later.")),
      h("div", {}, h("h3", { text: "Calculated, never stored" }), P("Status, the effective target (", C("target"), " or else ", C("requested_target"), "), whether a task is archived, and the KPI are worked out from the dates each time."))),
    h("h3", { text: "Table reference" }), cards);
}

/* ---------- README (setup guide) ---------- */
let readmeCache = null;
function helpReadme() {
  const box = h("div", { class: "help-readme" }, h("p", { class: "muted", text: "Loading the setup guide…" }));
  const fill = md => box.replaceChildren(h("p", { class: "muted m0" }, "This is the README from the tracker's code, for whoever installs and looks after the server."), ...renderMarkdown(md));
  if (readmeCache) fill(readmeCache);
  else api("GET", "/api/help/readme").then(r => { readmeCache = r.markdown; fill(r.markdown); })
    .catch(e => box.replaceChildren(h("p", { class: "bad-text", text: "Couldn't load the setup guide: " + e.message })));
  return box;
}
// Small Markdown renderer for the README: headings, paragraphs, lists, tables, code blocks, quotes,
// inline code, bold, italics and links. Builds DOM nodes, never HTML strings.
function mdInline(s) {
  const out = []; const rx = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\([^)\s]+\))/g;
  let last = 0, m;
  while ((m = rx.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const t = m[0];
    if (m[1]) out.push(h("code", { text: t.slice(1, -1) }));
    else if (m[2]) out.push(h("b", {}, ...mdInline(t.slice(2, -2))));
    else if (m[3]) out.push(h("i", {}, ...mdInline(t.slice(1, -1))));
    else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t), href = lm[2];
      out.push(/^https?:\/\//.test(href) ? h("a", { href, target: "_blank", rel: "noopener noreferrer" }, ...mdInline(lm[1])) : h("span", {}, ...mdInline(lm[1])));
    }
    last = m.index + t.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n"), out = [];
  const cells = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      i++; out.push(h("pre", { class: "help-code" }, h("code", { text: code.join("\n") }))); continue;
    }
    const hd = /^(#{1,6})\s+(.*)$/.exec(line);
    if (hd) { const lvl = Math.min(6, hd[1].length + 1); out.push(h("h" + lvl, { class: "md-h" }, ...mdInline(hd[2]))); i++; continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line); i += 2; const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(h("div", { class: "tscroll help-table" }, h("table", {}, h("thead", {}, h("tr", {}, head.map(c => h("th", {}, ...mdInline(c))))),
        h("tbody", {}, rows.map(r => h("tr", {}, r.map(c => h("td", {}, ...mdInline(c)))))))));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q = []; while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(h("blockquote", {}, ...mdInline(q.join(" ")))); continue;
    }
    const li = /^(\s*)([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      // A list item is its first line plus any indented lines after it (which may hold a table or code block).
      const ordered = /\d/.test(li[2]), items = [], itemRx = /^(\s{0,1})([-*]|\d+\.)\s+(.*)$/;
      while (i < lines.length) {
        const m = itemRx.exec(lines[i]);
        if (m && /\d/.test(m[2]) === ordered) { items.push([m[3]]); i++; continue; }
        if (!items.length) break;
        if (/^\s{2,}\S/.test(lines[i])) {
          if (/^\s*```/.test(lines[i])) { // keep a fenced block whole, blank lines included
            const cur = items[items.length - 1]; cur.push(lines[i++]);
            while (i < lines.length && !/^\s*```/.test(lines[i])) cur.push(lines[i++]);
            if (i < lines.length) cur.push(lines[i++]);
          } else items[items.length - 1].push(lines[i++]);
          continue;
        }
        if (!lines[i].trim()) { // a blank line ends the list unless the list (or this item) carries on after it
          let j = i; while (j < lines.length && !lines[j].trim()) j++;
          const n = j < lines.length ? itemRx.exec(lines[j]) : null;
          if ((n && /\d/.test(n[2]) === ordered) || (j < lines.length && /^\s{2,}\S/.test(lines[j]))) { items[items.length - 1].push(""); i = j; continue; }
        }
        break;
      }
      const start = ordered ? parseInt(li[2], 10) : 1;
      out.push(h(ordered ? "ol" : "ul", ordered && start !== 1 ? { start } : {}, items.map(parts => {
        const rest = parts.slice(1), split = rest.findIndex(l => /^\s*(\||```)/.test(l) || !l.trim());
        const textLines = [parts[0], ...(split < 0 ? rest : rest.slice(0, split))].map(l => l.trim()).filter(Boolean);
        const blocks = split < 0 ? [] : renderMarkdown(rest.slice(split).map(l => l.replace(/^\s{2,4}/, "")).join("\n"));
        return h("li", {}, ...mdInline(textLines.join(" ")), ...blocks);
      })));
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*\||\s*>|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) { out.push(h("p", {}, ...mdInline(lines[i++]))); continue; }
    out.push(h("p", {}, ...mdInline(para.join(" "))));
  }
  return out;
}
