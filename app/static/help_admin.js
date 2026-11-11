"use strict";
/* Administrator-only Help sections: data model, architecture and the README (setup guide).
   Served by GET /api/help/admin.js to administrators only; uses helpers from app.js and help.js. */

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
  { n: "customer_logos", g: "team", x: 430, y: 560, why: "Optional logo for a customer, shown as a small icon beside the customer's name. Without one, the tracker shows the customer's initials.",
    f: [["id", "PK", ""], ["team_id", "FK", "→ teams.id"], ["name", "UQ", "customer name, per team"], ["png", "", "64 × 64 PNG image"], ["updated_by", "user", ""], ["updated_at", "", ""]] },
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
  { a: ["teams", "id", "l"], b: ["customer_logos", "team_id", "l"], via: 416, la: "1", lb: "N" },
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
    h("p", { class: "muted m0" }, "How the tracker stores its data: nine tables in one SQLite file (", C("/data/tracker.db"), "). Logins on the left, teams and their people in the middle, the work on the right. Click a table for its details."),
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

/* ---------- architecture (component diagram) ---------- */
// Boxes: kind "zone" = dashed boundary, "box" = component, "store" = data, "ext" = outside the server.
const ARCH_BOXES = [
  { id: "office", kind: "zone", x: 16, y: 20, w: 250, h: 740, title: "Office network" },
  { id: "server-host", kind: "zone", x: 290, y: 20, w: 640, h: 740, title: "ddtaskserver · AlmaLinux 9 · 192.168.1.116" },
  { id: "container", kind: "zone", x: 306, y: 170, w: 608, h: 440, title: "Podman container · python:3.12-slim · runs as user tracker" },
  { id: "browser", kind: "box", x: 32, y: 190, w: 218, h: 200, title: "Web browser", lines: ["index.html · app.css", "app.js: tracker screens", "help.js: user guide", "help_admin.js: admins only", "Reloads tasks every 30 s"] },
  { id: "people", kind: "ext", x: 32, y: 420, w: 218, h: 106, title: "Who uses it", lines: ["Members, team leads", "and administrators", "open http://192.168.1.116:8080"] },
  { id: "systemd", kind: "box", x: 306, y: 44, w: 370, h: 84, title: "systemd + Podman Quadlet", lines: ["team-task-tracker.container: starts on boot,", "restarts if it stops"] },
  { id: "image", kind: "box", x: 700, y: 44, w: 214, h: 84, title: "Container image", lines: ["localhost/team-task-tracker", "made by podman build"] },
  { id: "server", kind: "box", x: 322, y: 210, w: 330, h: 384, title: "server.py · web server and API", lines: [
    "Python standard library HTTP server", "Security headers, CSP, CSRF check", "Log-in sessions (cookie → sessions table)", "Role checks: member · lead · admin",
    "/api/login · /api/invite/*: accounts", "/api/teams/*: teams and people", "/api/tasks/*: tasks and history", "/api/requests/*: lead approvals",
    "/api/teams/*/kpi: KPI dashboard", "/api/teams/*/export.xlsx: Excel", "/api/admin/*: administrators", "/api/help/*: admin help, README", "Serves /, app.js, help.js, app.css"] },
  { id: "xlsx", kind: "box", x: 672, y: 210, w: 226, h: 84, title: "xlsx.py", lines: ["Writes the Excel export", "(no external packages)"] },
  { id: "import", kind: "box", x: 672, y: 314, w: 226, h: 96, title: "xlsm_import.py", lines: ["Reads the 2026 workbook", "Daily Task Tracker + Archive", "Macros are never run"] },
  { id: "cli", kind: "box", x: 672, y: 440, w: 226, h: 154, title: "Admin commands", lines: ["python server.py …", "admin-link · backup", "import-xlsm · sync-xlsm", "make-admin · invite-admin", "run with podman exec"] },
  { id: "volume", kind: "store", x: 306, y: 650, w: 608, h: 84, title: "Volume tracker-data → /data", lines: ["tracker.db: SQLite database (WAL), 9 tables: see Data model", "backup.db and copied-in workbooks (temporary)"] },
  { id: "github", kind: "ext", x: 950, y: 44, w: 214, h: 106, title: "GitHub", lines: ["actionkamer90/Team-A-Task", "git pull on the server,", "then podman build"] },
  { id: "ssh", kind: "ext", x: 950, y: 460, w: 214, h: 106, title: "Administrator's SSH", lines: ["root on ddtaskserver", "runs admin commands", "with podman exec"] },
  { id: "workbook", kind: "ext", x: 950, y: 640, w: 214, h: 106, title: "Excel workbook", lines: ["Team's .xlsm file", "copied in with podman cp", "for import or sync"] },
];
// [x1, y1, x2, y2, label, label position "above" | "right" | "left", two-way]
const ARCH_LINKS = [
  [250, 300, 322, 300, "HTTP :8080", "above", true],
  [487, 594, 487, 650, "SQLite", "right", true],
  [652, 252, 672, 252, "", "", false],
  [785, 440, 785, 410, "", "", false],
  [785, 594, 785, 650, "backup, import", "right", false],
  [950, 510, 898, 510, "", "", false],
  [950, 690, 914, 690, "", "", false],
  [950, 86, 914, 86, "", "", false],
  [490, 128, 490, 170, "starts", "right", false],
  [807, 128, 807, 170, "runs", "right", false],
];
function archSvg() {
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
  const txt = (s, attrs, parent) => { const e = el("text", attrs, parent); e.textContent = s; return e; };
  const svg = el("svg", { class: "arch", viewBox: "0 0 1180 776", role: "img", "aria-label": "Component diagram of the tracker: browser, server, container, database and admin tools" });
  const defs = el("defs", {}, svg);
  for (const [id, d] of [["arch-end", "M0,0 L8,4 L0,8 z"], ["arch-start", "M8,0 L0,4 L8,8 z"]]) {
    const m = el("marker", { id, viewBox: "0 0 8 8", refX: id === "arch-end" ? 7 : 1, refY: 4, markerWidth: 8, markerHeight: 8, orient: "auto" }, defs);
    el("path", { d, class: "arch-head" }, m);
  }
  for (const b of ARCH_BOXES) {
    if (b.lines) b.h = Math.max(b.h, 36 + b.lines.length * 22);
    const g = el("g", { class: "arch-" + b.kind }, svg);
    if (b.kind === "zone") {
      el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: 10, class: "arch-zone-r" }, g);
      txt(b.title, { x: b.x + 12, y: b.y + 18, class: "arch-zone-t" }, g);
      continue;
    }
    el("rect", { x: b.x, y: b.y, width: b.w, height: b.h, rx: b.kind === "store" ? 14 : 7, class: "arch-box-r" }, g);
    txt(b.title, { x: b.x + 12, y: b.y + 22, class: "arch-title" }, g);
    (b.lines || []).forEach((l, i) => txt(l, { x: b.x + 12, y: b.y + 44 + i * 22, class: "arch-line" + (/^\/|^python |^index|^app|^help|^localhost|^tracker\.db|^actionkamer/.test(l) ? " code" : "") }, g));
  }
  for (const [x1, y1, x2, y2, label, pos, both] of ARCH_LINKS) {
    el("line", { x1, y1, x2, y2, class: "arch-link", "marker-end": "url(#arch-end)", ...(both ? { "marker-start": "url(#arch-start)" } : {}) }, svg);
    if (!label) continue;
    const w = label.length * 6.6 + 10, lx = pos === "above" ? (x1 + x2) / 2 - w / 2 : Math.max(x1, x2) + 6, ly = pos === "above" ? Math.min(y1, y2) - 22 : (y1 + y2) / 2 - 9;
    el("rect", { x: lx, y: ly, width: w, height: 17, rx: 3, class: "arch-lab-bg" }, svg);
    txt(label, { x: lx + 5, y: ly + 12.5, class: "arch-lab" }, svg);
  }
  return svg;
}
function helpArch() {
  const row = (name, what, where) => [h("b", { text: name }), what, h("span", { class: "mono small", text: where })];
  return h("div", { class: "help-model" },
    h("p", { class: "muted m0" }, "How the tracker is put together on ddtaskserver: what runs where, and how the pieces talk to each other. Everything runs in one container with no outside services and no internet access needed."),
    h("div", { class: "panel help-fig" }, h("div", { class: "help-legend" },
      h("span", {}, h("i", { class: "sw arch-sw-box" }), "Part of the tracker"), h("span", {}, h("i", { class: "sw arch-sw-store" }), "Data on disk"),
      h("span", {}, h("i", { class: "sw arch-sw-ext" }), "Outside the server"), h("span", {}, h("i", { class: "sw arch-sw-zone" }), "Boundary (network, server, container)")),
      h("div", { class: "tscroll" }, archSvg())),
    h("div", { class: "help-points" },
      h("div", {}, h("h3", { text: "A normal page view" }), P("The browser loads index.html, app.js and app.css once. After that, every screen is built in the browser from JSON that app.js fetches from ", C("/api/…"), ". The session cookie tells server.py who you are, and it checks your role on every request.")),
      h("div", {}, h("h3", { text: "Saving a change" }), P("app.js sends the change with a special header (the CSRF check). server.py checks your role, writes the task and its history row to SQLite in one transaction, and returns the new state. Other people see it on their next 30-second refresh.")),
      h("div", {}, h("h3", { text: "Where the data lives" }), P("Only in ", C("tracker.db"), " in the ", C("tracker-data"), " volume. Rebuilding or restarting the container doesn't touch it. Back it up with the ", C("backup"), " command.")),
      h("div", {}, h("h3", { text: "Updating the tracker" }), P(C("git pull"), " gets the new code, ", C("podman build"), " makes a new image, and ", C("systemctl restart team-task-tracker"), " swaps the container. Open browser tabs show a bar asking people to reload."))),
    h("h3", { text: "Components" }),
    helpTable(["Component", "What it does", "Where"], [
      row("Browser app", "All screens: tracker, archive, approvals, KPI, team, help. Only shows what your role allows; the server enforces it.", "app/static/app.js, help.js"),
      row("Admin help", "Data model, Architecture and Setup guide. Sent only to administrators.", "app/static/help_admin.js"),
      row("Web server and API", "Serves the pages, checks log-ins and roles, reads and writes the database, works out statuses and KPI.", "app/server.py"),
      row("Excel export", "Builds the .xlsx download.", "app/xlsx.py"),
      row("Workbook import", "Reads a team's 2026 Daily Task Tracker workbook for import-xlsm and sync-xlsm.", "app/xlsm_import.py"),
      row("Database", "SQLite file with 9 tables, including customer logos. See Data model.", "/data/tracker.db (volume tracker-data)"),
      row("Service", "Starts the container on boot and restarts it if it stops.", "/etc/containers/systemd/team-task-tracker.container"),
      row("Image recipe", "How podman build makes the container image.", "Dockerfile"),
    ]));
}
