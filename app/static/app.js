"use strict";
/* Team Task Tracker front end. All permissions are enforced by the server; the UI only hides what you can't use. */

/* ---------- helpers ---------- */
const h = (tag, props, ...kids) => {
  const el = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "style") el.style.cssText = v;
    else if (k === "value" || k === "checked" || k === "disabled" || k === "readOnly") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(9)) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : String(c)); }
  return el;
};
const fmt = iso => iso ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : "—";
const pctf = x => (Math.round(x * 1000) / 10).toFixed(1) + "%";
const fmtDT = iso => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
const store = { get(k) { try { return localStorage.getItem(k); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch { } } };
let toastT;
function toast(msg) {
  document.querySelector(".toast")?.remove();
  const t = h("div", { class: "toast", role: "status", text: msg }); document.body.append(t);
  clearTimeout(toastT); toastT = setTimeout(() => t.remove(), 4000);
}

// When the tracker is updated on the server, tabs that were already open offer a reload instead of running old code.
let loadedVersion = null;
function checkVersion(v) {
  if (!v) return;
  if (!loadedVersion) { loadedVersion = v; return; }
  if (v === loadedVersion || document.querySelector(".update-bar")) return;
  document.body.prepend(h("div", { class: "update-bar", role: "status" }, "The tracker has been updated. ",
    h("button", { class: "btn small primary", text: "Reload to get the new version", onclick: () => location.reload() })));
}
async function api(method, path, body) {
  const opt = { method, credentials: "same-origin", headers: {} };
  if (method !== "GET") { opt.headers["Content-Type"] = "application/json"; opt.headers["X-Requested-With"] = "tt"; opt.body = JSON.stringify(body || {}); }
  let r;
  try { r = await fetch(path, opt); } catch { throw new Error("Can't reach the server. Check your connection."); }
  checkVersion(r.headers.get("X-App-Version"));
  let data = {};
  try { data = await r.json(); } catch { }
  if (!r.ok) {
    if (r.status === 401 && path !== "/api/login" && S.phase === "ready") { S.phase = "login"; render(); }
    const e = new Error(data.error || "Something went wrong (" + r.status + ")."); e.status = r.status; throw e;
  }
  return data;
}

const DEFAULT_CATS = ["Pre-Sales", "Project", "Tickets", "Internal"];
const STATUS_CLASS = { "Delay": "bad", "On-Going": "info", "No Target": "warn", "Completed Early": "ok", "Completed On Time": "ok", "Completed Late": "warn", "Completed": "ok" };
const RATING_CLASS = { "Excellent": "ok", "Good": "info", "Needs Improvement": "warn", "At Risk": "bad", "No Data": "" };

/* ---------- state ---------- */
const S = {
  phase: "loading", me: null, teams: [], teamId: null, team: null, tasks: [], view: store.get("tt.view") || "tracker",
  f: { q: "", person: "", status: "", cat: "", urg: "", mine: false }, kpi: null, kpiData: null, invite: null, setupNeeded: false,
};
const team = () => S.team;
const role = () => S.team?.role || null;
const isLead = () => role() === "lead" || role() === "admin";
const myKey = () => S.team?.myKey || null;
const people = () => S.team?.people || [];
const personName = k => (people().find(p => p.key === k)?.name) || k;

/* ---------- customer icons ---------- */
// An uploaded logo if the team has one, otherwise a coloured badge with the customer's initials.
const SKIP_WORDS = new Set(["all", "customer", "customers", "the", "of", "and", "&"]);
function custInitials(name) {
  const words = name.replace(/[^\p{L}\p{N}&\s]/gu, " ").split(/\s+/).filter(w => w && !SKIP_WORDS.has(w.toLowerCase()));
  if (!words.length) return "?";
  if (words.length === 1) return words[0].length <= 4 && words[0] === words[0].toUpperCase() ? words[0] : words[0].slice(0, 2).toUpperCase();
  return words.slice(0, 3).map(w => w[0]).join("").toUpperCase();
}
function custHue(name) { let x = 0; for (const c of name.toLowerCase()) x = (x * 31 + c.codePointAt(0)) >>> 0; return x % 8; }
function custIcon(name, big) {
  if (!name) return null;
  const src = team()?.logos?.[name];
  if (src) return h("img", { class: "cust-ico" + (big ? " big" : ""), src, alt: "", width: big ? "28" : "18", height: big ? "28" : "18", loading: "lazy" });
  const ini = custInitials(name);
  return h("span", { class: "cust-ico cust-b cust-b" + custHue(name) + (big ? " big" : "") + (ini.length > 2 ? " wide" : ""), "aria-hidden": "true", text: ini });
}
const custLabel = name => name ? h("span", { class: "cust" }, h("span", { class: "cust-slot" }, custIcon(name)), h("span", { text: name })) : "—";
(function initKpiRange() { const y = new Date().getFullYear(); S.kpi = { from: y + "-01-01", to: y + "-12-31" }; })();

/* ---------- boot ---------- */
async function boot() {
  const m = /^#invite=([A-Za-z0-9_-]{20,100})$/.exec(location.hash);
  if (m) { S.invite = { token: m[1] }; history.replaceState(null, "", location.pathname); }
  await loadMe();
}
async function loadMe() {
  try {
    const me = await api("GET", "/api/me");
    S.setupNeeded = !!me.setupNeeded;
    if (S.invite) { S.me = me.user ? me : null; S.phase = "invite"; return render(); }
    if (!me.user) { S.phase = "login"; return render(); }
    S.me = me; S.teams = me.teams;
    if (!S.teams.length) { S.phase = "noteam"; return render(); }
    const saved = store.get("tt.team");
    await selectTeam((S.teams.find(t => t.id === S.teamId) || S.teams.find(t => t.id === saved) || S.teams[0]).id);
  } catch (e) { S.phase = "error"; S.error = e.message; render(); }
}
async function selectTeam(id) {
  S.teamId = id; store.set("tt.team", id); S.kpiData = null;
  const [t, tk] = await Promise.all([api("GET", "/api/teams/" + id), api("GET", "/api/teams/" + id + "/tasks")]);
  S.team = t; S.tasks = tk.tasks; S.today = tk.today; S.pendingApprovals = tk.pendingApprovals; S.phase = "ready";
  render();
}
async function reloadTeam() {
  if (!S.teamId) return;
  try {
    const [t, tk] = await Promise.all([api("GET", "/api/teams/" + S.teamId), api("GET", "/api/teams/" + S.teamId + "/tasks")]);
    const shellChanged = t.role !== S.team?.role || tk.pendingApprovals !== S.pendingApprovals;
    S.team = t; S.tasks = tk.tasks; S.today = tk.today; S.pendingApprovals = tk.pendingApprovals;
    if (shellChanged) render(); else refresh();
  } catch (e) { if (e.status === 403) loadMe(); }
}
setInterval(() => { if (S.phase === "ready" && document.visibilityState === "visible" && !document.querySelector(".sheet")) reloadTeam(); }, 30000);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && S.phase === "ready" && !document.querySelector(".sheet")) reloadTeam(); });

/* ---------- shell ---------- */
const VIEWS = [["tracker", "Tracker", () => true], ["completed", "Archive", () => true], ["summary", "Summary", () => true],
  ["approvals", "Approvals", () => isLead()], ["requests", "My Requests", () => !isLead() && !!myKey()], ["kpi", "KPI Dashboard", () => isLead()], ["team", "Team & Invites", () => isLead()], ["customers", "Customers", () => S.me?.user?.isAdmin], ["admin", "All Teams", () => S.me?.user?.isAdmin], ["help", "Help", () => true]];
let refreshFn = null;
function refresh() { if (refreshFn) refreshFn(); }
function render() {
  const app = document.getElementById("app"); app.replaceChildren(); refreshFn = null;
  if (S.phase === "loading") return app.append(h("div", { class: "center" }, h("p", { class: "muted", text: "Loading the tracker…" })));
  if (S.phase === "error") return app.append(card("The tracker isn't responding", [h("p", { text: S.error }), h("button", { class: "btn primary", text: "Try again", onclick: () => { S.phase = "loading"; render(); loadMe(); } })]));
  if (S.phase === "login" && S.publicHelp) { const m = h("main", { class: "wrap" }); app.append(m); helpView(m, true); return; }
  if (S.phase === "login") return app.append(loginScreen());
  if (S.phase === "invite") return app.append(inviteScreen());
  if (S.phase === "noteam" && S.me?.user?.isAdmin) return app.append(card("Create your first team", [
    h("p", { text: "You're the administrator. Create a team, add its team lead, and send the lead an invite link." }),
    h("p", { class: "muted small m0" }, "To bring in the tasks from the Excel workbook instead, run the import command from the README, then reload this page."),
    h("div", { class: "row" }, h("button", { class: "btn primary", text: "Create team", onclick: () => teamSheet(null) }), h("button", { class: "btn", text: "Log out", onclick: logout }))]));
  if (S.phase === "noteam") return app.append(card("You're not on a team yet", [
    h("p", { text: "Your account works, but no team lead has added you to a team. Ask your lead to send you an invite link for their team." }),
    h("button", { class: "btn", text: "Log out", onclick: logout })]));
  if (!VIEWS.find(v => v[0] === S.view && v[2]())) S.view = "tracker";
  const teamSel = h("select", { id: "team-switch", class: "team-pick", "aria-label": "Team", onchange: e => selectTeam(e.target.value).catch(err => toast(err.message)) },
    S.teams.map(t => h("option", { value: t.id, text: t.name })));
  teamSel.value = S.teamId;
  const u = S.me.user, r = role();
  app.append(h("header", { class: "top" },
    h("div", { class: "top-in wrap" },
      h("div", { class: "brand" }, h("h1", { text: "Team Task Tracker" }),
        h("small", { text: "Daily tasks · " + new Date().toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" }) })),
      teamSel,
      h("button", { class: "chip-user", "aria-label": "Account", onclick: accountSheet },
        h("span", { class: "avatar", text: (u.name || u.login).slice(0, 1).toUpperCase() }), h("span", { text: u.name || u.login }),
        h("span", { class: "role", text: r === "admin" ? "Admin" : r === "lead" ? "Team lead" : "Member" }))),
    h("nav", { class: "tabs wrap", role: "tablist" }, VIEWS.filter(v => v[2]()).map(([id, label]) => h("button", {
      role: "tab", "aria-selected": String(S.view === id), text: id === "approvals" && S.pendingApprovals ? label + " (" + S.pendingApprovals + ")" : label,
      onclick: () => { S.view = id; store.set("tt.view", id); render(); }
    })))));
  const main = h("main", { class: "wrap" }); app.append(main);
  ({ tracker: viewTracker, completed: viewCompleted, approvals: viewApprovals, requests: viewRequests, summary: viewSummary, kpi: viewKPI, team: viewTeam, customers: viewCustomers, admin: viewAdmin, help: m => helpView(m, false) })[S.view](main);
  refresh();
}
function card(title, body) { return h("div", { class: "center" }, h("div", { class: "card" }, h("h2", { text: title }), body)); }

/* ---------- login / invite ---------- */
function loginScreen() {
  const fLogin = h("input", { type: "text", id: "login", autocomplete: "username", required: true });
  const fPw = h("input", { type: "password", id: "password", autocomplete: "current-password", required: true });
  const err = h("p", { class: "bad-text m0", role: "alert" });
  const btn = h("button", { class: "btn primary block", type: "submit", text: "Log in" });
  const form = h("form", {
    onsubmit: async e => {
      e.preventDefault(); err.textContent = ""; btn.disabled = true;
      try { await api("POST", "/api/login", { login: fLogin.value, password: fPw.value }); S.phase = "loading"; render(); await loadMe(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; fPw.select(); }
    }
  }, h("label", { class: "field" }, h("span", { text: "Login" }), fLogin), h("label", { class: "field" }, h("span", { text: "Password" }), fPw), err, btn);
  const body = [h("p", { class: "muted m0", text: "Log in with the account you created from your invite link." }), form,
    h("p", { class: "muted small m0", text: "Forgot your password? Ask your team lead for a password reset link." }),
    h("p", { class: "small m0" }, h("button", { type: "button", class: "linkbtn", text: "Read the user guide", onclick: () => { S.publicHelp = true; render(); } }))];
  if (S.setupNeeded) body.unshift(h("div", { class: "note warn" }, "No administrator account exists yet. On the server, run ",
    h("code", { text: "docker compose exec app python server.py admin-link" }), " and open the link it prints."));
  setTimeout(() => fLogin.focus(), 0);
  return card("Team Task Tracker", body);
}
function inviteScreen() {
  const wrapEl = h("div", { class: "center" }, h("div", { class: "card" }, h("p", { class: "muted", text: "Checking your link…" })));
  api("POST", "/api/invite/info", { token: S.invite.token }).then(info => {
    S.invite.info = info; wrapEl.replaceWith(inviteForm(info));
  }).catch(e => wrapEl.replaceWith(card("This link can't be used", [h("p", { text: e.message }),
    h("button", { class: "btn", text: "Go to login", onclick: () => { S.invite = null; S.phase = "loading"; render(); loadMe(); } })])));
  return wrapEl;
}
function inviteForm(info) {
  const kind = info.kind;
  const title = kind === "setup" ? "Create the administrator account" : kind === "reset" ? "Set a new password" : "Join " + info.team;
  const err = h("p", { class: "bad-text m0", role: "alert" });
  const fName = h("input", { type: "text", id: "inv-name", autocomplete: "name", value: info.name || "" });
  const fLogin = h("input", { type: "text", id: "inv-login", autocomplete: "username", placeholder: "e.g. your work email" });
  const fPw = h("input", { type: "password", id: "inv-pw", autocomplete: "new-password" });
  const fPw2 = h("input", { type: "password", id: "inv-pw2", autocomplete: "new-password" });
  const btn = h("button", { class: "btn primary block", type: "submit", text: kind === "reset" ? "Save password and log in" : "Create account and log in" });
  const done = async () => { S.invite = null; S.phase = "loading"; render(); await loadMe(); toast(kind === "reset" ? "Password changed" : "Welcome aboard"); };
  const form = h("form", {
    onsubmit: async e => {
      e.preventDefault(); err.textContent = "";
      if (fPw.value !== fPw2.value) { err.textContent = "The two passwords don't match."; return; }
      btn.disabled = true;
      try { await api("POST", "/api/invite/accept", { token: S.invite.token, name: fName.value, login: fLogin.value, password: fPw.value }); await done(); }
      catch (x) { err.textContent = x.message; btn.disabled = false; }
    }
  },
    kind !== "reset" ? h("label", { class: "field" }, h("span", { text: "Your name" }), fName) : null,
    kind !== "reset" ? h("label", { class: "field" }, h("span", { text: "Login (you'll type this to log in)" }), fLogin) : null,
    h("label", { class: "field" }, h("span", { text: "Password (at least 10 characters)" }), fPw),
    h("label", { class: "field" }, h("span", { text: "Repeat password" }), fPw2), err, btn);
  const body = [];
  if (kind === "invite") body.push(h("p", { class: "m0" }, "You've been invited to ", h("b", { text: info.team }), " as ", h("b", { text: info.name }),
    " (" + (info.role === "lead" ? "team lead" : "member") + ")."));
  if (kind === "reset") body.push(h("p", { class: "m0" }, "Choose a new password for ", h("b", { text: info.login }), ". You'll be logged out everywhere else."));
  if (kind === "setup") body.push(h("p", { class: "m0", text: "This account manages every team: it creates teams and invites their leads." }));
  if (kind === "invite" && info.loggedInAs) {
    body.push(h("div", { class: "note" }, "You're logged in as ", h("b", { text: info.loggedInAs }), ". ",
      h("button", { class: "btn small", type: "button", text: "Join with this account", onclick: async ev => {
        ev.target.disabled = true;
        try { await api("POST", "/api/invite/accept", { token: S.invite.token, useCurrent: true }); await done(); } catch (x) { err.textContent = x.message; ev.target.disabled = false; }
      } })));
  } else if (kind === "invite") {
    const exLogin = h("input", { type: "text", id: "ex-login", autocomplete: "username" });
    const exPw = h("input", { type: "password", id: "ex-pw", autocomplete: "current-password" });
    const exErr = h("p", { class: "bad-text m0", role: "alert" });
    const exForm = h("form", { hidden: true, onsubmit: async e => {
      e.preventDefault(); exErr.textContent = "";
      try { await api("POST", "/api/invite/accept", { token: S.invite.token, existingLogin: exLogin.value, existingPassword: exPw.value }); await done(); }
      catch (x) { exErr.textContent = x.message; }
    } }, h("label", { class: "field" }, h("span", { text: "Your existing login" }), exLogin), h("label", { class: "field" }, h("span", { text: "Password" }), exPw), exErr,
      h("button", { class: "btn primary block", type: "submit", text: "Add " + info.team + " to my account" }));
    const toggle = h("button", { class: "btn small", type: "button", text: "I already have an account", onclick: () => {
      const show = exForm.hidden; exForm.hidden = !show; form.hidden = show; toggle.textContent = show ? "Create a new account instead" : "I already have an account";
    } });
    body.push(h("div", { class: "row between" }, h("span", { class: "muted small", text: "Already use the tracker for another team?" }), toggle), exForm);
  }
  body.push(form);
  return card(title, body);
}
async function logout() {
  try { await api("POST", "/api/logout", {}); } catch { }
  S.me = null; S.team = null; S.teamId = null; S.phase = "login";
  S.f = { q: "", person: "", status: "", cat: "", urg: "", mine: false };  // the next person starts with clean filters
  closeSheet(); render();
}
function accountSheet() {
  const cur = h("input", { type: "password", id: "pw-cur", autocomplete: "current-password" });
  const n1 = h("input", { type: "password", id: "pw-new", autocomplete: "new-password" });
  const n2 = h("input", { type: "password", id: "pw-new2", autocomplete: "new-password" });
  const u = S.me.user;
  openSheet("Your account", [
    h("p", { class: "m0" }, "Logged in as ", h("b", { text: u.login }), u.isAdmin ? " (administrator)" : ""),
    h("h3", { text: "Change password" }),
    h("label", { class: "field" }, h("span", { text: "Current password" }), cur),
    h("label", { class: "field" }, h("span", { text: "New password (at least 10 characters)" }), n1),
    h("label", { class: "field" }, h("span", { text: "Repeat new password" }), n2),
    h("button", { class: "btn primary", text: "Change password", onclick: async () => {
      if (n1.value !== n2.value) return toast("The two new passwords don't match.");
      try { await api("POST", "/api/password", { current: cur.value, password: n1.value }); closeSheet(); toast("Password changed. Other devices were logged out."); } catch (e) { toast(e.message); }
    } })],
    [h("button", { class: "btn danger", text: "Log out", onclick: logout }), h("button", { class: "btn right", text: "Close", onclick: closeSheet })]);
}

/* ---------- tracker ---------- */
function filterBar(statuses) {
  const f = S.f, ppl = people().slice().sort((a, b) => a.name.localeCompare(b.name)), cats = team()?.categories || DEFAULT_CATS;
  const sel = (id, label, opts, key) => {
    const s = h("select", { id, onchange: e => { f[key] = e.target.value; refresh(); } }, h("option", { value: "", text: "All" }),
      opts.map(o => Array.isArray(o) ? h("option", { value: o[0], text: o[1] }) : h("option", { value: o, text: o })));
    s.value = f[key]; return h("label", { class: "field" }, h("span", { text: label }), s);
  };
  return h("div", { class: "bar" },
    h("label", { class: "field grow" }, h("span", { text: "Search" }), h("input", { type: "search", id: "f-q", placeholder: "Task, customer, progress note…", value: f.q, oninput: e => { f.q = e.target.value; refresh(); } })),
    sel("f-person", "Engineer", ppl.map(p => [p.key, p.name]), "person"), sel("f-status", "Status", statuses, "status"),
    sel("f-cat", "Category", cats, "cat"), sel("f-urg", "Urgency", team()?.urgencies || [], "urg"),
    myKey() ? h("label", { class: "check" }, h("input", { type: "checkbox", id: "f-mine", checked: f.mine, onchange: e => { f.mine = e.target.checked; refresh(); } }), "Only my tasks") : null);
}
function applyFilters(list, ignoreStatus) {
  const f = S.f, q = f.q.trim().toLowerCase(), mk = myKey();
  return list.filter(t => {
    if (f.person && !t.lead.includes(f.person) && !t.support.includes(f.person)) return false;
    if (f.mine && mk && !t.lead.includes(mk) && !t.support.includes(mk)) return false;
    if (f.status && !ignoreStatus && t.status !== f.status) return false; if (f.cat && t.category !== f.cat) return false; if (f.urg && t.urgency !== f.urg) return false;
    if (q && ![t.title, t.customer, t.progress, t.category, ...t.lead.map(personName), ...t.support.map(personName)].join(" ").toLowerCase().includes(q)) return false;
    return true;
  });
}
/* ---------- sorting (Daily tasks and Archive) ---------- */
const URG_ORDER = ["Low", "Medium", "High", "Critical"];
const STATUS_RANK = { "Delay": 0, "On-Going": 1, "No Target": 2, "Completed Late": 3, "Completed On Time": 4, "Completed Early": 5, "Completed": 6 };
const firstName = a => (a[0] ? personName(a[0]) : "").toLowerCase();
// get: value to compare; desc: first click sorts high-to-low; label: name in the Sort by menu
const SORTS = {
  status: { label: "Status (most urgent first)", get: t => STATUS_RANK[t.status] ?? 9 },
  no: { label: "Task no", get: t => t.no },
  category: { label: "Category", get: t => (t.category || "").toLowerCase() },
  title: { label: "Task name", get: t => t.title.toLowerCase() },
  pct: { label: "% done", get: t => t.percent, desc: true },
  urgency: { label: "Urgency", get: t => URG_ORDER.indexOf(t.urgency), desc: true },
  customer: { label: "Customer", get: t => (t.customer || "").toLowerCase() },
  lead: { label: "Lead engineer", get: t => firstName(t.lead) },
  support: { label: "Support engineer", get: t => firstName(t.support) },
  start: { label: "Start date", get: t => t.startDate },
  target: { label: "Target date", get: t => t.effTarget },
  actual: { label: "Actual (completed) date", get: t => t.actualDate, desc: true },
};
// table columns, in order, with the sort each header uses
const COLUMNS = [["No", "no"], ["Category", "category"], ["Main task / project", "title"], ["%", "pct"], ["Urgency", "urgency"], ["Customer", "customer"],
  ["Lead", "lead"], ["Support", "support"], ["Start", "start"], ["Target", "target"], ["Actual", "actual"], ["Status", "status"]];
const SORT_DEFAULT = { tracker: { k: "status", d: 1 }, completed: { k: "actual", d: -1 } };
S.sort = (() => {
  try { const v = JSON.parse(store.get("tt.sort") || "{}"); const ok = x => x && SORTS[x.k] && (x.d === 1 || x.d === -1);
    return { tracker: ok(v.tracker) ? v.tracker : SORT_DEFAULT.tracker, completed: ok(v.completed) ? v.completed : SORT_DEFAULT.completed }; } catch { return { ...SORT_DEFAULT }; }
})();
function sortTasks(list, view) {
  const { k, d } = S.sort[view], get = SORTS[k].get;
  const blank = v => v == null || v === "" || v === -1;
  const cmp = (x, y) => typeof x === "string" ? x.localeCompare(y) : x - y;
  return list.sort((a, b) => {
    const x = get(a), y = get(b);
    if (blank(x) !== blank(y)) return blank(x) ? 1 : -1; // empty values always go last
    const c = blank(x) ? 0 : cmp(x, y) * d;
    if (c) return c;
    if (k === "status") return (a.effTarget || "9999").localeCompare(b.effTarget || "9999") || a.no - b.no; // same status: nearest target first
    return a.no - b.no;
  });
}
let sortFocus = null; // keeps keyboard focus on the sort control after the table is redrawn
function setSort(view, k, d) {
  const cur = S.sort[view];
  S.sort[view] = d ? { k, d } : cur.k === k ? { k, d: -cur.d } : { k, d: SORTS[k].desc ? -1 : 1 };
  store.set("tt.sort", JSON.stringify(S.sort)); refresh();
}
function sortControls(view) {
  const s = S.sort[view];
  const sel = h("select", { id: "sort-" + view, onchange: e => { sortFocus = "sort-" + view; setSort(view, e.target.value, SORTS[e.target.value].desc ? -1 : 1); } },
    Object.entries(SORTS).filter(([k]) => view === "tracker" || k !== "status" || s.k === "status").map(([k, v]) => h("option", { value: k, text: v.label })));
  sel.value = s.k;
  return h("div", { class: "sortbar" },
    h("label", { class: "field" }, h("span", { text: "Sort by" }), sel),
    h("button", { class: "btn", id: "sortdir-" + view, type: "button", "aria-label": "Sort direction: " + (s.d > 0 ? "ascending" : "descending") + ". Select to reverse.",
      text: s.d > 0 ? "↑ Ascending" : "↓ Descending", onclick: () => { sortFocus = "sortdir-" + view; setSort(view, s.k, -s.d); } }));
}
function afterSortRender() { if (sortFocus) { document.getElementById(sortFocus)?.focus(); sortFocus = null; } }

function taskTable(list, archive) {
  const names = a => a.map(personName).join(" / ") || "—";
  const view = archive ? "completed" : "tracker", s = S.sort[view];
  if (!list.length) return h("div", { class: "empty", text: archive ? "No archived tasks match these filters." : "No tasks match these filters. Use New task to add one." });
  return h("div", { class: "tscroll" }, h("table", {},
    h("thead", {}, h("tr", {}, COLUMNS.map(([c, k], i) => {
      const on = s.k === k;
      return h("th", { class: (i === 3 ? "num " : "") + "sortable" + (on ? " sorted" : ""), "aria-sort": on ? (s.d > 0 ? "ascending" : "descending") : "none" },
        h("button", { type: "button", id: "th-" + view + "-" + k, title: "Sort by " + SORTS[k].label.toLowerCase(),
          onclick: () => { sortFocus = "th-" + view + "-" + k; setSort(view, k); } }, c, h("span", { class: "arrow", "aria-hidden": "true", text: on ? (s.d > 0 ? "↑" : "↓") : "↕" })));
    }))),
    h("tbody", {}, list.map(t => h("tr", { class: "click", tabindex: "0", onclick: () => taskSheet(t), onkeydown: e => { if (e.key === "Enter") taskSheet(t); } },
      h("td", { class: "mono muted", text: "#" + String(t.no).padStart(3, "0") }),
      h("td", { class: "nowrap", text: t.category || "—" }),
      h("td", {}, h("div", { class: "task-title", text: t.title }), t.progress ? h("div", { class: "task-prog", text: t.progress }) : null),
      h("td", { class: "num" }, h("div", { class: "pct" }, h("i", {}, h("em", { style: "width:" + t.percent + "%" })), h("span", { class: "mono", text: t.percent + "%" }))),
      h("td", {}, h("span", { class: "urg " + t.urgency, text: t.urgency })),
      h("td", { class: "nowrap" }, custLabel(t.customer)),
      h("td", { class: "nowrap", text: names(t.lead) }), h("td", { class: "nowrap", text: names(t.support) }),
      h("td", { class: "mono nowrap", text: fmt(t.startDate) }),
      h("td", { class: "mono nowrap" }, fmt(t.effTarget), t.pending ? h("span", { class: "pending", text: "awaiting lead" }) : null),
      h("td", { class: "mono nowrap", text: fmt(t.actualDate) }),
      h("td", {}, h("span", { class: "pill " + (STATUS_CLASS[t.status] || ""), text: t.status }),
        !t.approved ? h("span", { class: "pending", text: "new · awaiting approval" }) : t.changePending ? h("span", { class: "pending", text: pendingLabel(t.pendingFields) + " awaiting approval" }) : null))))));
}
function pendingLabel(fields) {
  const f = fields || [];
  return f.includes("target") && f.includes("actual_date") ? "new target & completion" : f.includes("actual_date") ? "completion" : "new target";
}
function tile(label, val, cls) { return h("div", { class: "tile " + (cls || "") }, h("span", { class: "lbl", text: label }), h("b", { text: val })); }
function exportBtn() {
  return h("button", { class: "btn", text: "Export to Excel", onclick: () => {
    const q = isLead() ? "?from=" + S.kpi.from + "&to=" + S.kpi.to : "";
    window.location.href = "/api/teams/" + S.teamId + "/export.xlsx" + q;
  } });
}
function viewTracker(main) {
  const canAdd = !!myKey() || isLead();
  const tiles = h("div", { class: "tiles" }), body = h("div");
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · daily task tracker" }),
    h("div", { class: "row" }, exportBtn(), canAdd ? h("button", { class: "btn primary", onclick: () => taskSheet(null), text: "+ New task" }) : null)),
    tiles, filterBar(["On-Going", "Delay", "No Target", "Completed Early", "Completed On Time", "Completed Late"]), body);
  refreshFn = () => {
    // the tiles follow every filter except Status (they are the status breakdown), so "Only my tasks" shows your own numbers
    const cur = applyFilters(S.tasks.filter(t => !t.archived), true), open = cur.filter(t => !t.actualDate), c = s => open.filter(t => t.status === s).length;
    tiles.replaceChildren(tile("Open tasks", open.length), tile("On-going", c("On-Going"), "info"), tile("Delayed", c("Delay"), "bad"),
      tile("Awaiting approval", cur.filter(t => !t.approved || t.changePending).length, "warn"), tile("No target date", c("No Target"), "warn"));
    const list = sortTasks(applyFilters(S.tasks.filter(t => !t.archived)), "tracker");
    body.replaceChildren(sortControls("tracker"), taskTable(list, false)); afterSortRender();
  };
}
function viewCompleted(main) {
  const body = h("div"), count = h("span", { class: "muted" });
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · archive" }), h("div", { class: "row" }, count, exportBtn())),
    h("p", { class: "muted m0", text: "Tasks move here " + (S.me.archiveDays || 2) + " days after their actual (completed) date." }),
    filterBar(["Completed Early", "Completed On Time", "Completed Late", "Completed"]), body);
  refreshFn = () => {
    const list = sortTasks(applyFilters(S.tasks.filter(t => t.archived)), "completed");
    count.textContent = list.length + " tasks"; body.replaceChildren(sortControls("completed"), taskTable(list, true)); afterSortRender();
  };
}

/* ---------- side sheet ---------- */
function openSheet(title, bodyEls, footEls) {
  closeSheet(); const prev = document.activeElement;
  const scrim = h("div", { class: "scrim", onclick: closeSheet });
  const sheet = h("aside", { class: "sheet", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("div", { class: "sheet-h" }, h("h2", { text: title }), h("button", { class: "btn small", onclick: closeSheet, text: "Close" })),
    h("div", { class: "sheet-b" }, bodyEls), h("div", { class: "sheet-f" }, footEls));
  sheet._prev = prev; document.body.append(scrim, sheet);
  sheet.querySelector(".sheet-b input,.sheet-b select,.sheet-b textarea,.sheet-b button")?.focus();
  document.addEventListener("keydown", escClose);
}
function escClose(e) { if (e.key === "Escape") closeSheet(); }
function closeSheet() {
  const s = document.querySelector(".sheet"); if (!s) return;
  document.querySelector(".scrim")?.remove(); s.remove(); document.removeEventListener("keydown", escClose); s._prev?.focus?.();
}
function peopleToggles(id, selected, disabled) {
  const set = new Set(selected || []);
  const ppl = people().filter(p => p.active || set.has(p.key)).sort((a, b) => a.name.localeCompare(b.name));
  const wrap = h("div", { class: "toggles", id }); wrap.value = () => [...set];
  ppl.forEach(p => {
    const b = h("button", { type: "button", "aria-pressed": String(set.has(p.key)), text: p.name, disabled,
      onclick: () => { set.has(p.key) ? set.delete(p.key) : set.add(p.key); b.setAttribute("aria-pressed", String(set.has(p.key))); } });
    wrap.append(b);
  });
  if (!ppl.length) wrap.append(h("span", { class: "muted", text: "No one on this team yet." }));
  return wrap;
}
function taskSheet(t) {
  const tm = team(), isNew = !t, lead = isLead(), mk = myKey();
  const ro = t ? !t.canEdit : !(lead || mk);
  const myReq = t?.request?.mine ? t.request : null;
  const othersPending = t && t.changePending && !myReq;
  // details save straight away; a member's proposed target date waits for the lead, so show their proposal in the date field
  const src = myReq ? { ...t, effTarget: myReq.data.target || t.effTarget, actualDate: myReq.data.actual_date || t.actualDate } : t;
  const T = src || { category: "", title: "", progress: "", percent: 0, urgency: "Medium", customer: "", lead: mk ? [mk] : [], support: [], startDate: S.today, effTarget: "", actualDate: "" };
  const locked = ro;
  const fCat = h("select", { id: "t-cat", disabled: locked }, h("option", { value: "", text: "Choose…" }), tm.categories.map(c => h("option", { value: c, text: c })));
  fCat.value = T.category || "";
  const fTitle = h("input", { type: "text", id: "t-title", value: T.title, disabled: locked, maxlength: "200", placeholder: "e.g. Quarterly health check" });
  const fCust = h("input", { type: "text", id: "t-cust", value: T.customer || "", disabled: locked, list: "cust-list", maxlength: "100" });
  const dl = h("datalist", { id: "cust-list" }, tm.customers.map(c => h("option", { value: c })));
  const fUrg = h("select", { id: "t-urg", disabled: locked }, tm.urgencies.map(u => h("option", { value: u, text: u }))); fUrg.value = T.urgency;
  const fPct = h("input", { type: "number", id: "t-pct", min: "0", max: "100", step: "5", value: String(T.percent || 0), disabled: locked });
  const fProg = h("textarea", { id: "t-prog", disabled: locked, maxlength: "8000", placeholder: "Latest progress, one update per line" }); fProg.value = T.progress || "";
  const addNote = h("button", { type: "button", class: "btn small", disabled: locked, text: "Add dated update", onclick: () => {
    const d = S.today; fProg.value = d.slice(8, 10) + "/" + d.slice(5, 7) + ": \n" + fProg.value; fProg.focus(); fProg.setSelectionRange(7, 7);
  } });
  const fLead = peopleToggles("t-lead", T.lead, locked), fSup = peopleToggles("t-sup", T.support, locked);
  const fStart = h("input", { type: "date", id: "t-start", value: T.startDate || "", disabled: locked });
  const fActual = h("input", { type: "date", id: "t-actual", value: T.actualDate || "", max: S.today, disabled: locked || (othersPending && !lead) });
  const fTarget = h("input", { type: "date", id: "t-target", value: T.effTarget || "", disabled: locked || (othersPending && !lead) });
  const help = lead ? "Saving sets the official target date. Changes are logged."
    : t?.target ? "Official target " + fmt(t.target) + ". A new date needs your team lead's approval." : "Your proposed target. Your team lead approves it.";
  const banners = [];
  if (ro) banners.push(h("div", { class: "note", text: "You can view this task. Only its Lead Engineer and the team lead can change it." }));
  if (t && t.approved === false) banners.push(h("div", { class: "note warn", text: lead ? "New task waiting for approval. Review it on the Approvals tab." : "This new task is waiting for your team lead's approval. You can still adjust it." }));
  if (myReq) banners.push(h("div", { class: "note warn", text: "Waiting for your team lead (sent " + fmtDT(myReq.at) + "): " + proposalText(myReq.data) + ". Proposing again replaces it." }));
  if (othersPending && !lead) banners.push(h("div", { class: "note warn", text: "Another engineer's " + pendingLabel(t.pendingFields) + " is waiting for the team lead. You can still update the other details." }));
  if (lead && t?.request) banners.push(h("div", { class: "note warn" }, "An engineer proposed: " + proposalText(t.request.data) + ". ",
    h("button", { class: "btn small", type: "button", text: "Review in Approvals", onclick: () => { closeSheet(); S.view = "approvals"; render(); } })));
  if (!lead && !ro) banners.push(h("p", { class: "muted small m0", text: "Your changes to the details save straight away. A new target date, or a completed date earlier than today, needs your team lead's approval." }));
  const hist = h("div", { class: "hist" });
  if (t) loadHistory(t, hist);
  const body = [dl, ...banners,
    h("div", { class: "f2" }, h("label", { class: "field" }, h("span", { text: "Category" }), fCat), h("label", { class: "field" }, h("span", { text: "Urgency" }), fUrg)),
    h("label", { class: "field" }, h("span", { text: "Main task / project" }), fTitle),
    h("label", { class: "field" }, h("span", { text: "Customer" }), (() => {
      const ico = h("span", { class: "cust-slot" }, custIcon(fCust.value));
      fCust.addEventListener("input", () => ico.replaceChildren(custIcon(fCust.value.trim()) || ""));
      return h("span", { class: "cust-field" }, ico, fCust);
    })()),
    h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "lbl", text: "Task progress" }), addNote), fProg),
    h("label", { class: "field w160" }, h("span", { text: "Task percentage" }), fPct),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Lead engineer" }), fLead),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Support engineer" }), fSup),
    h("div", { class: "f2" }, h("label", { class: "field" }, h("span", { text: "Start date" }), fStart),
      h("label", { class: "field" }, h("span", { text: "Target date" + (lead ? "" : " (lead approves)") }), fTarget, h("small", { class: "muted", text: help }))),
    h("label", { class: "field w50" }, h("span", { text: "Actual (completed) date" }), fActual,
      lead ? null : h("small", { class: "muted", text: "Use today's date. An earlier date needs your team lead's approval." })),
    t ? h("p", { class: "muted small m0", text: "Status: " + t.status + (t.updatedAt ? " · last updated " + fmtDT(t.updatedAt) : "") }) : null,
    hist];
  const saveLabel = isNew ? "Add task" : "Save changes";
  const save = h("button", { class: "btn primary", text: saveLabel, disabled: locked, onclick: async () => {
    if (!fTitle.value.trim()) { toast("Give the task a name."); return fTitle.focus(); }
    if (!fCat.value) { toast("Choose a category."); return fCat.focus(); }
    const leads = fLead.value();
    if (!leads.length) return toast("Choose at least one Lead Engineer.");
    if (!lead && !leads.includes(mk)) return toast("Keep yourself as a Lead Engineer. You can only manage tasks you lead.");
    const data = { category: fCat.value, title: fTitle.value, customer: fCust.value, urgency: fUrg.value, percent: Number(fPct.value) || 0, progress: fProg.value,
      lead: leads, support: fSup.value(), startDate: fStart.value || null, actualDate: fActual.value || null, target: fTarget.value || null };
    save.disabled = true;
    try {
      const r = isNew ? await api("POST", "/api/teams/" + S.teamId + "/tasks", data) : await api("PUT", "/api/tasks/" + t.id, data);
      closeSheet();
      if (r.changed === false) toast("No changes to save");
      else if (r.pending && r.pending.length) toast((isNew ? "Task added. " : "Saved. ") + "Waiting for your team lead's approval: " + r.pending.map(k => k === "target" ? "target date" : "backdated completion").join(" and ") + ".");
      else toast(isNew ? "Task added" : "Changes saved");
      reloadTeam();
    } catch (e) { save.disabled = false; toast(e.message); }
  } });
  const foot = [save, h("button", { class: "btn", text: "Cancel", onclick: closeSheet })];
  if (t && lead) {
    let armed = false;
    const del = h("button", { class: "btn danger right", text: "Delete task", onclick: async () => {
      if (!armed) { armed = true; del.textContent = "Click again to delete"; setTimeout(() => { armed = false; del.textContent = "Delete task"; }, 3000); return; }
      try { await api("DELETE", "/api/tasks/" + t.id); closeSheet(); toast("Task deleted"); reloadTeam(); } catch (e) { toast(e.message); }
    } });
    foot.push(del);
  }
  openSheet(isNew ? "New task" : "Task #" + String(t.no).padStart(3, "0"), body, foot);
}
const LOG_LABEL = { category: "Category", title: "Main task", customer: "Customer", urgency: "Urgency", percent: "Task percentage", lead: "Lead engineer",
  support: "Support engineer", start_date: "Start date", requested_target: "Requested target", actual_date: "Actual date", target: "Target date" };
function describe(f, v) {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return "(empty)";
  if (Array.isArray(v)) return v.map(personName).join(" / ");
  if (/date|target/.test(f)) return fmt(v);
  if (f === "percent") return v + "%";
  return String(v);
}
async function loadHistory(t, box) {
  box.append(h("span", { class: "lbl", text: "Change history" }), h("span", { text: "Loading…" }));
  try {
    const r = await api("GET", "/api/tasks/" + t.id + "/history");
    box.replaceChildren(h("span", { class: "lbl", text: "Change history" }));
    if (!r.entries.length) box.append(h("span", { text: r.imported ? "Imported from the Excel workbook. No changes since." : "No changes yet." }));
    r.entries.forEach(e => {
      let lines;
      if (e.kind === "create") lines = [h("div", { text: "Created the task" })];
      else if (e.kind === "approve") lines = [h("div", { class: "tgt", text: e.changes.request === "create" ? "Approved the new task from " + e.changes.of : "Approved " + e.changes.of + "'s changes" })];
      else if (e.kind === "reject") lines = [h("div", { class: "tgt", text: "Rejected " + e.changes.of + "'s changes" + (e.changes.note ? ": " + e.changes.note : "") })];
      else if (e.kind === "target") lines = [h("div", { class: "tgt", text: e.changes.from ? "Changed the official target: " + fmt(e.changes.from) + " → " + fmt(e.changes.to) : "Set the official target: " + fmt(e.changes.to) })];
      else lines = e.changes.map(([f, a, b]) => h("div", { text: f === "progress" ? "Updated the progress notes" : (LOG_LABEL[f] || f) + ": " + describe(f, a) + " → " + describe(f, b) }));
      box.append(h("div", { class: "ev" }, h("div", {}, h("b", { text: e.by }), h("span", { class: "mono", text: "  ·  " + fmtDT(e.at) })), lines));
    });
    if (r.imported && r.entries.length) box.append(h("span", { text: "Imported from the Excel workbook before these changes." }));
  } catch (e) { box.replaceChildren(h("span", { text: "Change history couldn't be loaded." })); }
}


/* ---------- approvals (leads) and my requests (members) ---------- */
function changeLines(changes) {
  return (changes || []).map(([f, a, b]) => h("div", { text: f === "progress" ? "Updated the progress notes" : (LOG_LABEL[f] || f) + ": " + describe(f, a) + " → " + describe(f, b) }));
}
function reqKind(r) {
  if (r.kind === "create") return "New task";
  const k = Object.keys(r.proposed || {});
  if (k.length === 2) return "Target & completion";
  if (k[0] === "actual_date") return "Backdated completion";
  if (k[0] === "target") return "Target date";
  return "Changes";
}
function proposalText(d) {
  const parts = [];
  if (d.target) parts.push("target date " + fmt(d.target));
  if (d.actual_date) parts.push("completed on " + fmt(d.actual_date) + " (backdated)");
  return parts.join(" and ");
}
function requestTitle(r) { return "#" + String(r.no || "").padStart(3, "0") + " " + (r.title || "(deleted task)"); }
function viewApprovals(main) {
  const list = h("div", { class: "grid2" });
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · approvals" }),
    h("span", { class: "muted", text: "Proposed target dates and backdated completions wait here until you approve them." })), list);
  async function load() {
    try {
      const r = await api("GET", "/api/teams/" + S.teamId + "/requests");
      if (!r.requests.length) { list.replaceChildren(h("div", { class: "panel" }, h("p", { class: "muted m0", text: "Nothing waiting. Requests appear here when an engineer proposes a target date or completes a task with an earlier date." }))); return; }
      list.replaceChildren(...r.requests.map(rq => {
        const note = h("input", { type: "text", id: "rej-" + rq.id, maxlength: "500", placeholder: "Reason (shown to " + rq.by + ")" });
        const rejectRow = h("div", { class: "row", hidden: true }, note,
          h("button", { class: "btn danger small", text: "Reject", onclick: () => decide(rq, "reject", note.value) }));
        const detail = rq.kind === "create"
          ? [h("div", { text: "New task · " + rq.task.category + " · " + rq.task.urgency + (rq.task.customer ? " · " + rq.task.customer : "") }),
             h("div", { text: "Lead: " + (rq.task.lead.map(personName).join(" / ") || "—") + (rq.task.support.length ? " · Support: " + rq.task.support.map(personName).join(" / ") : "") }),
             h("div", { text: "Start " + fmt(rq.task.startDate) + " · Proposed target " + fmt(rq.task.target) }),
             rq.task.progress ? h("div", { class: "muted", text: rq.task.progress }) : null]
          : changeLines(rq.changes);
        return h("div", { class: "panel" },
          h("div", { class: "row between" }, h("h3", { text: requestTitle(rq) }), h("span", { class: "pill " + (rq.kind === "create" ? "info" : "warn"), text: reqKind(rq) })),
          h("div", { class: "muted small", text: rq.by + " · " + fmtDT(rq.at) }),
          h("div", { class: "hist" }, detail, rq.backdatedDays ? h("div", { class: "tgt", text: "Completed date is " + rq.backdatedDays + " day" + (rq.backdatedDays === 1 ? "" : "s") + " before today." }) : null),
          h("div", { class: "row" },
            h("button", { class: "btn primary", text: "Approve", onclick: () => decide(rq, "approve") }),
            h("button", { class: "btn", text: "Reject…", onclick: e => { rejectRow.hidden = false; e.target.hidden = true; note.focus(); } }),
            rq.taskId && rq.kind === "edit" ? h("button", { class: "btn small", text: "Open task", onclick: () => { const t = S.tasks.find(x => x.id === rq.taskId); if (t) taskSheet(t); } }) : null),
          rejectRow);
      }));
    } catch (e) { list.replaceChildren(h("p", { class: "bad-text", text: e.message })); }
  }
  async function decide(rq, what, note) {
    try {
      await api("POST", "/api/requests/" + rq.id + "/" + what, what === "reject" ? { note: note || "" } : {});
      toast(what === "approve" ? "Approved: " + requestTitle(rq) : "Rejected: " + requestTitle(rq));
      await reloadTeam(); load();
    } catch (e) { toast(e.message); load(); }
  }
  refreshFn = null;
  load();
}
const REQ_STATUS = { pending: ["Waiting for approval", "warn"], approved: ["Approved", "ok"], rejected: ["Rejected", "bad"], cancelled: ["Withdrawn", ""] };
function viewRequests(main) {
  const list = h("div");
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · my requests" }),
    h("span", { class: "muted", text: "Target dates and backdated completions you sent, and what your team lead decided (last 30 days)." })), list);
  async function load() {
    try {
      const r = await api("GET", "/api/teams/" + S.teamId + "/requests");
      if (!r.requests.length) { list.replaceChildren(h("div", { class: "panel" }, h("p", { class: "muted m0", text: "No requests in the last 30 days." }))); return; }
      list.replaceChildren(h("div", { class: "tscroll" }, h("table", {},
        h("thead", {}, h("tr", {}, ["Task", "Request", "Sent", "Status", "Team lead's note", ""].map(c => h("th", { text: c })))),
        h("tbody", {}, r.requests.map(rq => {
          const [label, cls] = REQ_STATUS[rq.status] || [rq.status, ""];
          return h("tr", {},
            h("td", {}, h("div", { class: "task-title", text: requestTitle(rq) }), rq.kind === "edit" ? h("div", { class: "hist" },
              Object.keys(rq.proposed || {}).length ? h("div", { text: "Proposed: " + proposalText(rq.proposed) }) : changeLines(rq.changes)) : null),
            h("td", { text: reqKind(rq) }),
            h("td", { class: "mono nowrap", text: fmtDT(rq.at) }),
            h("td", {}, h("span", { class: "pill " + cls, text: label }), rq.decidedBy ? h("div", { class: "muted small", text: rq.decidedBy + " · " + fmtDT(rq.decidedAt) }) : null),
            h("td", { text: rq.note || "" }),
            h("td", {}, rq.status === "pending" ? h("button", { class: "btn small", text: "Withdraw", onclick: async () => {
              try { await api("DELETE", "/api/requests/" + rq.id); toast("Request withdrawn"); await reloadTeam(); load(); } catch (e) { toast(e.message); }
            } }) : null));
        })))));
    } catch (e) { list.replaceChildren(h("p", { class: "bad-text", text: e.message })); }
  }
  refreshFn = null;
  load();
}

/* ---------- summary ---------- */
function viewSummary(main) {
  const tiles = h("div", { class: "tiles" }), load = h("div"), byCust = h("div");
  main.append(h("h2", { text: team().name + " · summary" }), tiles,
    h("div", { class: "grid2" }, h("div", { class: "panel" }, h("h3", { text: "Task load by engineer (open tasks)" }), load), h("div", { class: "panel" }, h("h3", { text: "Open tasks by customer" }), byCust)));
  refreshFn = () => {
    const open = S.tasks.filter(t => !t.actualDate), done = S.tasks.filter(t => t.actualDate), ym = (S.today || "").slice(0, 7);
    tiles.replaceChildren(tile("Open", open.length), tile("Delayed", open.filter(t => t.status === "Delay").length, "bad"),
      tile("Completed this month", done.filter(t => t.actualDate.startsWith(ym)).length, "ok"), tile("Completed all time", done.length));
    const rows = people().filter(p => p.active).map(p => {
      const L = open.filter(t => t.lead.includes(p.key)), Su = open.filter(t => t.support.includes(p.key) && !t.lead.includes(p.key));
      return { p, L: L.length, S: Su.length, T: L.length + Su.length, D: [...L, ...Su].filter(t => t.status === "Delay").length };
    }).sort((a, b) => b.T - a.T);
    const max = Math.max(1, ...rows.map(r => r.T));
    load.replaceChildren(h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Engineer", "Lead", "Support", "Total", "Delayed", ""].map((c, i) => h("th", { class: i && i < 5 ? "num" : "", text: c })))),
      h("tbody", {}, rows.map(r => h("tr", {}, h("td", { text: r.p.name }), h("td", { class: "num mono", text: r.L }), h("td", { class: "num mono", text: r.S }), h("td", { class: "num mono", text: r.T }),
        h("td", { class: "num mono" + (r.D ? " bad-text" : ""), text: r.D }), h("td", { style: "width:30%" }, h("div", { class: "meter" }, h("em", { style: "width:" + (r.T / max * 100) + "%" })))))))));
    const cm = {}; open.forEach(t => { const k = t.customer || "(none)"; cm[k] = (cm[k] || 0) + 1; });
    const cr = Object.entries(cm).sort((a, b) => b[1] - a[1]);
    byCust.replaceChildren(cr.length ? h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Customer" }), h("th", { class: "num", text: "Open" }))),
      h("tbody", {}, cr.map(([k, v]) => h("tr", {}, h("td", {}, k === "(none)" ? k : custLabel(k)), h("td", { class: "num mono", text: v })))))) : h("p", { class: "muted", text: "No open tasks." }));
  };
}

/* ---------- KPI ---------- */
function isoLocal(d) { return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); }
function viewKPI(main) {
  const fFrom = h("input", { type: "date", id: "k-from", value: S.kpi.from, onchange: e => { S.kpi.from = e.target.value; loadKPI(); } });
  const fTo = h("input", { type: "date", id: "k-to", value: S.kpi.to, onchange: e => { S.kpi.to = e.target.value; loadKPI(); } });
  const tiles = h("div", { class: "tiles" }), score = h("div"), cats = h("div"), chart = h("div"), rule = h("p", { class: "muted m0" });
  const presets = [["This month", () => { const d = S.today; return [d.slice(0, 8) + "01", d]; }],
    ["This quarter", () => { const d = new Date(), q = Math.floor(d.getMonth() / 3) * 3; return [isoLocal(new Date(d.getFullYear(), q, 1)), isoLocal(new Date(d.getFullYear(), q + 3, 0))]; }],
    ["This year", () => { const y = new Date().getFullYear(); return [y + "-01-01", y + "-12-31"]; }]];
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · KPI dashboard" }),
    h("div", { class: "row" }, exportBtn(), h("button", { class: "btn", text: "KPI settings", onclick: kpiSheet }))),
    h("div", { class: "bar" }, h("label", { class: "field" }, h("span", { text: "Period from (actual date)" }), fFrom), h("label", { class: "field" }, h("span", { text: "Period to" }), fTo),
      h("div", { class: "row" }, presets.map(([l, fn]) => h("button", { class: "btn small", text: l, onclick: () => { const [a, b] = fn(); S.kpi.from = fFrom.value = a; S.kpi.to = fTo.value = b; loadKPI(); } })))),
    rule, tiles, h("div", { class: "panel" }, h("h3", { text: "Engineer KPI scorecard" }), score),
    h("div", { class: "grid2" }, h("div", { class: "panel" }, h("h3", { text: "KPI score by engineer" }), chart), h("div", { class: "panel" }, h("h3", { text: "Lead tasks by category" }), cats)));
  async function loadKPI() {
    try { S.kpiData = await api("GET", "/api/teams/" + S.teamId + "/kpi?from=" + S.kpi.from + "&to=" + S.kpi.to); draw(); } catch (e) { toast(e.message); }
  }
  function draw() {
    const K = S.kpiData; if (!K) return; const c = K.config, T = K.team;
    rule.textContent = "KPI = On-time % × " + Math.round(c.onTime * 100) + "% + Early % × " + Math.round(c.early * 100) + "%. Every lead and support involvement counts individually. Ratings: Excellent ≥ " +
      Math.round(c.excellent * 100) + "%, Good ≥ " + Math.round(c.good * 100) + "%, Needs Improvement ≥ " + Math.round(c.needs * 100) + "%, otherwise At Risk.";
    tiles.replaceChildren(tile("Tasks completed", T.C), tile("On time (incl. early)", T.F, "ok"), tile("Late", T.G, "warn"), tile("On-time %", T.C ? pctf(T.H) : "—", "info"),
      tile("Avg days late", K.avgDaysLate.toFixed(1), "warn"), tile("Team KPI", T.E ? pctf(T.O) : "—", RATING_CLASS[T.rating]));
    const cols = [["Engineer", "name"], ["Lead tasks", "C"], ["Support tasks", "D"], ["Total", "E"], ["Lead on time", "F"], ["Lead late", "G"], ["Lead on-time %", "H", "C"],
      ["Support on time", "I"], ["Support late", "J"], ["Support on-time %", "K", "D"], ["Total on-time %", "L", "E"], ["Completed early", "M"], ["Early %", "N", "E"], ["KPI score", "O", "E"], ["Rating", "rating"]];
    const cell = (r, [, k, base]) => k === "name" ? h("td", { class: "nowrap", text: r.name })
      : k === "rating" ? h("td", {}, RATING_CLASS[r.rating] ? h("span", { class: "pill " + RATING_CLASS[r.rating], text: r.rating }) : h("span", { class: "muted", text: r.rating }))
        : h("td", { class: "num mono", text: base ? (r[base] ? pctf(r[k]) : "—") : r[k] });
    score.replaceChildren(h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, cols.map(([l], i) => h("th", { class: i ? "num" : "", text: l })))),
      h("tbody", {}, K.rows.map(r => h("tr", {}, cols.map(cd => cell(r, cd)))), h("tr", { class: "total" }, cols.map(cd => cell(T, cd)))))));
    const ranked = K.rows.filter(r => r.E).sort((a, b) => b.O - a.O);
    chart.replaceChildren(ranked.length ? h("div", { class: "bars" }, ranked.map(r => h("div", {}, h("span", { class: "nowrap", text: r.name }),
      h("div", { class: "meter tall" }, h("em", { class: RATING_CLASS[r.rating], style: "width:" + (r.O * 100) + "%" }), [c.needs, c.good, c.excellent].map(x => h("i", { style: "left:" + (x * 100) + "%" }))),
      h("span", { class: "mono num", text: pctf(r.O) }))), h("small", { class: "muted", text: "Tick marks show the Needs Improvement, Good and Excellent thresholds." }))
      : h("p", { class: "muted", text: "No tasks were completed in this period." }));
    cats.replaceChildren(h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", { text: "Engineer" }), K.categories.map(x => h("th", { class: "num", text: x })), h("th", { class: "num", text: "Total" }))),
      h("tbody", {}, K.rows.filter(r => r.C).map(r => h("tr", {}, h("td", { text: r.name }), K.categories.map(x => h("td", { class: "num mono", text: r.cats[x] })), h("td", { class: "num mono", text: r.C })))))));
  }
  refreshFn = draw;
  loadKPI();
}
function kpiSheet() {
  const c = team().kpi;
  const num = (id, v) => h("input", { type: "number", id, min: "0", max: "100", step: "1", value: String(Math.round(v * 100)) });
  const a = num("k-ont", c.onTime), b = num("k-early", c.early), e = num("k-exc", c.excellent), g = num("k-good", c.good), n = num("k-needs", c.needs);
  const L = (l, i) => h("label", { class: "field" }, h("span", { text: l }), i);
  openSheet("KPI settings", [h("p", { class: "muted m0", text: "Weights must add up to 100%. Applies to " + team().name + " only." }),
    h("div", { class: "f2" }, L("On-time weight %", a), L("Early completion weight %", b)), h("h3", { text: "Rating thresholds (minimum KPI score %)" }),
    h("div", { class: "f2" }, L("Excellent", e), L("Good", g), L("Needs Improvement", n))],
    [h("button", { class: "btn primary", text: "Save settings", onclick: async () => {
      const v = x => Math.max(0, Math.min(100, Number(x.value) || 0)) / 100;
      try {
        await api("PUT", "/api/teams/" + S.teamId, { kpi: { onTime: v(a), early: v(b), excellent: v(e), good: v(g), needs: v(n) } });
        closeSheet(); toast("KPI settings saved"); await reloadTeam(); render();
      } catch (err) { toast(err.message); }
    } }), h("button", { class: "btn", text: "Cancel", onclick: closeSheet })]);
}

/* ---------- team & invites ---------- */
function personStatus(p) {
  if (!p.active) return ["Removed", ""];
  if (p.joined) return ["Joined", "ok"];
  if (p.inviteExpires) return ["Invite sent", "info"];
  return ["Not invited", "warn"];
}
function viewTeam(main) {
  const list = h("div"), admin = S.me.user.isAdmin;
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · team & invitations" }),
    h("div", { class: "row" }, h("button", { class: "btn", text: "Team settings", onclick: () => teamSheet(team()) }), h("button", { class: "btn primary", text: "+ Add person", onclick: () => personSheet(null) }))),
    h("div", { class: "panel" }, h("h3", { text: "How to invite someone" }),
      h("ol", { class: "steps" },
        h("li", {}, h("b", { text: "Add them" }), " with the name that should appear on tasks" + (admin ? ", and choose Member or Team lead." : ".")),
        h("li", {}, h("b", { text: "Create an invite link" }), " and send it to them privately (Teams, WhatsApp or email). It works once and expires after 7 days."),
        h("li", {}, h("b", { text: "They open the link" }), ", choose a login and password, and land straight in this team.")),
      h("p", { class: "muted m0", text: "Forgotten password? Use Reset password link on their row and send them the new link." })),
    h("div", { class: "panel" }, h("h3", { text: "People" }), list));
  refreshFn = () => {
    const ppl = people();
    list.replaceChildren(ppl.length ? h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Login", "Role", "Status", ""].map(c => h("th", { text: c })))),
      h("tbody", {}, ppl.map(p => {
        const [s, cl] = personStatus(p), canTouch = admin || p.role !== "lead";
        return h("tr", {}, h("td", { text: p.name }), h("td", { class: "mono", text: p.login || "—" }), h("td", { text: p.role === "lead" ? "Team lead" : "Member" }),
          h("td", {}, h("span", { class: "pill " + cl, text: s }), p.inviteExpires && !p.joined ? h("div", { class: "muted small", text: "expires " + fmtDT(p.inviteExpires) }) : null),
          h("td", { class: "nowrap" }, canTouch ? h("button", { class: "btn small", text: "Edit", onclick: () => personSheet(p) }) : null,
            canTouch && p.active ? h("button", { class: "btn small", style: "margin-left:6px", text: p.joined ? "Reset password link" : (p.inviteExpires ? "New invite link" : "Create invite link"), onclick: () => linkFor(p) }) : null));
      })))) : h("p", { class: "muted", text: "No one on this team yet. Use Add person to start." }));
  };
}
async function linkFor(p) {
  try {
    const r = await api("POST", "/api/teams/" + S.teamId + "/people/" + p.id + "/link", {});
    const msg = r.kind === "reset"
      ? "Hi " + p.name + ", here is your password reset link for the " + team().name + " task tracker. It works once and expires " + fmtDT(r.expires) + ":\n" + r.url
      : "Hi " + p.name + ", you've been invited to the " + team().name + " daily task tracker. Open this link to create your login. It works once and expires " + fmtDT(r.expires) + ":\n" + r.url;
    const inp = h("input", { type: "text", id: "link-url", readOnly: true, value: r.url, onfocus: e => e.target.select() });
    const ta = h("textarea", { id: "link-msg", readOnly: true, onfocus: e => e.target.select() }); ta.value = msg;
    const copy = (el, what) => h("button", { class: "btn small", text: "Copy", onclick: async () => {
      try { await navigator.clipboard.writeText(el.value); toast(what + " copied"); } catch { el.focus(); el.select(); toast("Press Ctrl+C to copy the selected text."); }
    } });
    openSheet(r.kind === "reset" ? "Password reset link for " + p.name : "Invite link for " + p.name, [
      h("p", { class: "m0", text: "Send this to " + p.name + " privately. Anyone who has the link can use it, once, until it expires." }),
      h("div", { class: "field" }, h("span", { class: "lbl", text: "Link" }), h("div", { class: "linkbox" }, inp, copy(inp, "Link"))),
      h("div", { class: "field" }, h("div", { class: "row between" }, h("span", { class: "lbl", text: "Ready-to-send message" }), copy(ta, "Message")), ta),
      h("p", { class: "muted small m0", text: "Creating a new link cancels any earlier unused link for this person." })],
      [h("button", { class: "btn danger", text: "Cancel this link", onclick: async () => { try { await api("DELETE", "/api/teams/" + S.teamId + "/people/" + p.id + "/link"); closeSheet(); toast("Link cancelled"); reloadTeam(); } catch (e) { toast(e.message); } } }),
        h("button", { class: "btn right", text: "Done", onclick: () => { closeSheet(); reloadTeam(); } })]);
  } catch (e) { toast(e.message); }
}
function personSheet(p) {
  const isNew = !p, admin = S.me.user.isAdmin;
  const fName = h("input", { type: "text", id: "p-name", value: p?.name || "", maxlength: "60", placeholder: "Name shown on tasks, e.g. Sarah" });
  const fRole = h("select", { id: "p-role", disabled: !admin }, h("option", { value: "member", text: "Member: adds and updates tasks" }), h("option", { value: "lead", text: "Team lead: also sets target dates and sees KPIs" }));
  fRole.value = p?.role || "member";
  const fLogin = h("input", { type: "text", id: "p-login", maxlength: "120", autocomplete: "off", placeholder: "Only if they already use the tracker" });
  const foot = [h("button", { class: "btn primary", text: isNew ? "Add person" : "Save", onclick: async () => {
    if (!fName.value.trim()) { toast("Enter a name."); return fName.focus(); }
    try {
      if (isNew) {
        const r = await api("POST", "/api/teams/" + S.teamId + "/people", { name: fName.value, role: fRole.value, login: fLogin.value });
        closeSheet(); toast(r.joined ? "Added. They'll see this team next time they open the tracker." : "Added. Next, create their invite link."); reloadTeam(); return;
      } else {
        const body = { name: fName.value, role: fRole.value, active: true };
        if (!p.joined && fLogin.value.trim()) body.login = fLogin.value;
        await api("PUT", "/api/teams/" + S.teamId + "/people/" + p.id, body);
        closeSheet(); toast(body.login ? "Linked. " + p.name + " now sees this team with their existing login." : "Saved"); reloadTeam();
      }
    } catch (e) { toast(e.message); }
  } }), h("button", { class: "btn", text: "Cancel", onclick: closeSheet })];
  if (p && p.active) foot.push(h("button", { class: "btn danger right", text: "Remove from team", onclick: async () => {
    try { await api("PUT", "/api/teams/" + S.teamId + "/people/" + p.id, { active: false }); closeSheet(); toast("Removed. Their name stays on past tasks."); reloadTeam(); } catch (e) { toast(e.message); }
  } }));
  openSheet(isNew ? "Add person" : "Edit " + p.name, [
    h("label", { class: "field" }, h("span", { text: "Display name" }), fName),
    h("label", { class: "field" }, h("span", { text: "Role" }), fRole, admin ? null : h("small", { class: "muted", text: "Only the administrator can make someone a team lead." })),
    isNew || !p.joined ? h("label", { class: "field" }, h("span", { text: isNew ? "Existing login (optional)" : "Link to an existing login (optional)" }), fLogin,
      h("small", { class: "muted", text: "If this person already has a tracker account for another team, enter that login so they use one account for both teams. Otherwise leave it empty and send an invite link." })) : null,
    p && !p.active ? h("div", { class: "note", text: "This person was removed. Saving adds them back to the team." }) : null], foot);
}
function teamSheet(tm) {
  const isNew = !tm;
  const fName = h("input", { type: "text", id: "tm-name", value: tm?.name || "", maxlength: "80", placeholder: "e.g. Team Network" });
  const fCats = h("textarea", { id: "tm-cats" }); fCats.value = (tm?.categories || DEFAULT_CATS).join("\n");
  const fCust = h("textarea", { id: "tm-cust" }); fCust.value = (tm?.customers || []).join("\n");
  openSheet(isNew ? "Create team" : "Team settings", [h("label", { class: "field" }, h("span", { text: "Team name" }), fName),
    h("label", { class: "field" }, h("span", { text: "Task categories (one per line)" }), fCats),
    h("label", { class: "field" }, h("span", { text: "Customers (one per line, offered as suggestions)" }), fCust),
    isNew ? null : logoManager(tm)],
    [h("button", { class: "btn primary", text: isNew ? "Create team" : "Save", onclick: async () => {
      const lines = x => x.value.split("\n").map(s => s.trim()).filter(Boolean);
      try {
        const body = { name: fName.value, categories: lines(fCats), customers: lines(fCust) };
        if (isNew) { const r = await api("POST", "/api/teams", body); closeSheet(); toast("Team created. Next, add its team lead."); await loadMe(); await selectTeam(r.id); S.view = "team"; render(); }
        else { await api("PUT", "/api/teams/" + tm.id, body); closeSheet(); toast("Saved"); await loadMe(); }
      } catch (e) { toast(e.message); }
    } }), h("button", { class: "btn", text: "Cancel", onclick: closeSheet })]);
}

// Customer icons in Team settings: upload a logo (shrunk to a 64 × 64 PNG in the browser) or go back to initials.
function logoManager(tm) {
  const box = h("div", { class: "logo-mgr" });
  const draw = () => {
    const names = [...new Set([...(team()?.customers || []), ...Object.keys(team()?.logos || {})])].sort((a, b) => a.localeCompare(b));
    box.replaceChildren(h("span", { class: "lbl", text: "Customer icons" }),
      h("p", { class: "muted small m0", text: "Each customer shows its initials until you upload a logo. PNG, JPG, GIF, WebP or SVG; it is shrunk to a small 64 × 64 icon. Save the customer list above first to add new customers here." }),
      names.length ? h("ul", { class: "logo-list" }, names.map(n => {
        const has = !!team()?.logos?.[n];
        const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", class: "sr-only", id: "logo-" + custHue(n) + "-" + n.length,
          onchange: async e => {
            const f = e.target.files[0]; e.target.value = ""; if (!f) return;
            try { await api("PUT", "/api/teams/" + tm.id + "/logos", { name: n, png: await toIconPng(f) }); await reloadTeam(); draw(); toast("Logo saved for " + n); }
            catch (x) { toast(x.message); }
          } });
        return h("li", {}, custIcon(n, true), h("span", { class: "nm", text: n }),
          h("label", { class: "btn small", for: file.id }, has ? "Change logo" : "Upload logo", file),
          has ? h("button", { class: "btn small", type: "button", text: "Use initials", onclick: async () => {
            try { await api("DELETE", "/api/teams/" + tm.id + "/logos", { name: n }); await reloadTeam(); draw(); toast("Back to initials for " + n); } catch (x) { toast(x.message); }
          } }) : null);
      })) : h("p", { class: "muted small m0", text: "No customers yet." }));
  };
  draw();
  return box;
}
function toIconPng(file) {
  return new Promise((ok, fail) => {
    if (file.size > 5 * 1024 * 1024) return fail(new Error("That image is too big. Pick one under 5 MB."));
    const rd = new FileReader();
    rd.onerror = () => fail(new Error("Couldn't read that file."));
    rd.onload = () => {
      const img = new Image();
      img.onerror = () => fail(new Error("That file isn't an image the browser can open."));
      img.onload = () => {
        const N = 64, c = document.createElement("canvas"); c.width = c.height = N;
        const k = Math.min(N / (img.naturalWidth || N), N / (img.naturalHeight || N)), w = (img.naturalWidth || N) * k, hh = (img.naturalHeight || N) * k;
        const g = c.getContext("2d"); g.imageSmoothingQuality = "high"; g.drawImage(img, (N - w) / 2, (N - hh) / 2, w, hh);
        try { ok(c.toDataURL("image/png")); } catch { fail(new Error("Couldn't convert that image.")); }
      };
      img.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

/* ---------- customers (admin) ---------- */
function viewCustomers(main) {
  const body = h("div", { class: "cust-admin" }), msg = h("p", { class: "muted m0" });
  let data = null, q = "", confirmRemove = null;
  const icon = c => c.logo ? h("img", { class: "cust-ico big", src: c.logo, alt: "", width: "28", height: "28" })
    : h("span", { class: "cust-ico cust-b cust-b" + custHue(c.name) + " big" + (custInitials(c.name).length > 2 ? " wide" : ""), "aria-hidden": "true", text: custInitials(c.name) });
  const save = async (name, teams, done) => {
    try { await api("PUT", "/api/admin/customers", { name, teams }); toast(done); await load(); await reloadTeam(); } catch (e) { toast(e.message); await load(); }
  };
  const fName = h("input", { type: "text", id: "nc-name", maxlength: "100", placeholder: "e.g. CIMB Bank", required: true });
  const fTeams = h("div", { class: "nc-teams" });
  const addForm = h("form", { class: "panel nc-form", onsubmit: async e => {
    e.preventDefault();
    const name = fName.value.trim(), teams = [...fTeams.querySelectorAll("input:checked")].map(i => i.value);
    if (!name) return toast("Enter the customer's name.");
    if (!teams.length) return toast("Tick at least one team for the new customer.");
    if (data.customers.some(c => c.name.toLowerCase() === name.toLowerCase())) return toast(name + " is already in the list. Tick its teams in the table instead.");
    await save(name, teams, "Added " + name); fName.value = "";
  } }, h("h3", { text: "Add a customer" }),
    h("div", { class: "row nc-row" }, h("label", { class: "field grow" }, h("span", { text: "Customer name" }), fName),
      h("div", { class: "field" }, h("span", { text: "Teams that work with this customer" }), fTeams),
      h("button", { class: "btn primary", type: "submit", text: "Add customer" })));
  const search = h("input", { type: "search", id: "cust-q", placeholder: "Search customers…", oninput: e => { q = e.target.value.trim().toLowerCase(); draw(); } });
  main.append(h("div", { class: "row between" }, h("h2", { text: "Customers" })),
    h("p", { class: "muted m0", text: "Add customers and choose which teams work with them. A team's members see its customers as suggestions when they add a task, and the customer's icon beside its name. Removing a customer from a team doesn't change tasks that already name it." }),
    addForm, h("div", { class: "bar" }, h("label", { class: "field grow" }, h("span", { text: "Search" }), search)), msg, body);
  function draw() {
    if (!data) return;
    fTeams.replaceChildren(...data.teams.map(t => h("label", { class: "check" }, h("input", { type: "checkbox", value: t.id, checked: data.teams.length === 1 }), t.name)));
    const list = data.customers.filter(c => !q || c.name.toLowerCase().includes(q));
    msg.textContent = data.customers.length + " customers" + (q ? " · " + list.length + " shown" : "");
    if (!list.length) return body.replaceChildren(h("div", { class: "empty", text: data.customers.length ? "No customers match your search." : "No customers yet. Add the first one above." }));
    body.replaceChildren(h("div", { class: "tscroll" }, h("table", { class: "cust-table" },
      h("thead", {}, h("tr", {}, h("th", { text: "Customer" }), data.teams.map(t => h("th", { class: "ctr", text: t.name })), h("th", { class: "num", text: "Open tasks" }), h("th", { text: "Icon" }), h("th", {}))),
      h("tbody", {}, list.map(c => {
        const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/gif,image/webp,image/svg+xml", class: "sr-only", id: "cl-" + custHue(c.name) + "-" + c.name.length + "-" + c.teams.length,
          onchange: async e => { const f = e.target.files[0]; e.target.value = ""; if (!f) return;
            try { const r = await api("PUT", "/api/admin/customers/logo", { name: c.name, png: await toIconPng(f) }); toast("Logo saved for " + c.name + " in " + r.teams + (r.teams === 1 ? " team" : " teams")); await load(); await reloadTeam(); } catch (x) { toast(x.message); } } });
        const removing = confirmRemove === c.name;
        return h("tr", {},
          h("td", {}, h("span", { class: "cust" }, h("span", { class: "cust-slot big" }, icon(c)), h("b", { text: c.name }))),
          data.teams.map(t => h("td", { class: "ctr" }, h("input", { type: "checkbox", checked: c.teams.includes(t.id), "aria-label": c.name + " in " + t.name,
            onchange: e => { const teams = e.target.checked ? [...c.teams, t.id] : c.teams.filter(x => x !== t.id);
              if (!teams.length) { e.target.checked = true; confirmRemove = c.name; return draw(); }
              save(c.name, teams, (e.target.checked ? "Added " + c.name + " to " : "Removed " + c.name + " from ") + t.name); } }))),
          h("td", { class: "num mono", text: c.openTasks }),
          h("td", { class: "nowrap" }, h("label", { class: "btn small", for: file.id }, c.logo ? "Change" : "Upload", file),
            c.logo ? h("button", { class: "btn small", type: "button", text: "Use initials", onclick: async () => {
              try { await api("PUT", "/api/admin/customers/logo", { name: c.name, png: "" }); toast("Back to initials for " + c.name); await load(); await reloadTeam(); } catch (x) { toast(x.message); } } }) : null),
          h("td", { class: "nowrap" }, removing
            ? h("span", { class: "row" }, h("span", { class: "small", text: "Remove from every team?" }),
                h("button", { class: "btn small danger", type: "button", text: "Remove", onclick: () => { confirmRemove = null; save(c.name, [], "Removed " + c.name); } }),
                h("button", { class: "btn small", type: "button", text: "Keep", onclick: () => { confirmRemove = null; draw(); } }))
            : h("button", { class: "btn small", type: "button", text: "Remove", onclick: () => { confirmRemove = c.name; draw(); } })));
      })))));
  }
  async function load() {
    try { data = await api("GET", "/api/admin/customers"); draw(); }
    catch (e) { body.replaceChildren(h("p", { class: "bad-text", text: e.message })); }
  }
  load();
}

/* ---------- all teams (admin) ---------- */
function viewAdmin(main) {
  const list = h("div"), admins = h("div");
  main.append(h("div", { class: "row between" }, h("h2", { text: "All teams" }), h("button", { class: "btn primary", text: "+ Create team", onclick: () => teamSheet(null) })),
    h("p", { class: "muted m0", text: "As administrator you can open every team. Create a team, add its lead on Team & Invites, and send the lead an invite link. The lead then invites their own members." }), list,
    h("div", { class: "row between" }, h("h2", { text: "Administrators" }), h("button", { class: "btn", text: "Invite new administrator", onclick: inviteAdmin })),
    h("p", { class: "muted m0", text: "Administrators manage every team, create teams and choose team leads. Give access to someone who already has a login below, or invite someone new." }), admins);
  async function load() {
    try {
      const [r, u] = await Promise.all([api("GET", "/api/admin/teams"), api("GET", "/api/admin/users")]);
      list.replaceChildren(h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Team", "Team leads", "People", "Joined", "Open tasks", ""].map(c => h("th", { text: c })))),
        h("tbody", {}, r.teams.map(t => h("tr", {}, h("td", { text: t.name }), h("td", { text: t.leads.join(", ") || "None yet" }), h("td", { class: "mono", text: t.people }),
          h("td", { class: "mono", text: t.joined }), h("td", { class: "mono", text: t.open }),
          h("td", {}, h("button", { class: "btn small", text: "Open", onclick: async () => { await selectTeam(t.id); S.view = "team"; render(); } }))))))));
      admins.replaceChildren(h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["Name", "Login", "Teams", "Access", ""].map(c => h("th", { text: c })))),
        h("tbody", {}, u.users.map(x => h("tr", {}, h("td", { text: x.name + (x.isMe ? " (you)" : "") }), h("td", { class: "mono", text: x.login }),
          h("td", { class: "small", text: x.teams.join(", ") || "—" }),
          h("td", {}, x.isAdmin ? h("span", { class: "pill info", text: "Administrator" }) : h("span", { class: "muted", text: "Team access" })),
          h("td", {}, x.isMe ? null : h("button", { class: "btn small", text: x.isAdmin ? "Remove admin access" : "Make administrator", onclick: async () => {
            try { await api("PUT", "/api/admin/users/" + x.id, { isAdmin: !x.isAdmin }); toast(x.isAdmin ? x.name + " is no longer an administrator" : x.name + " is now an administrator"); load(); }
            catch (e) { toast(e.message); }
          } }))))))));
    } catch (e) { list.replaceChildren(h("p", { class: "bad-text", text: e.message })); }
  }
  refreshFn = load;
}
async function inviteAdmin() {
  try {
    const r = await api("POST", "/api/admin/invite", {});
    const inp = h("input", { type: "text", id: "admin-link", readOnly: true, value: r.url, onfocus: e => e.target.select() });
    openSheet("Invite a new administrator", [
      h("p", { class: "m0", text: "Send this link privately. The person opens it, chooses a login and password, and gets administrator access. It works once and expires " + fmtDT(r.expires) + "." }),
      h("div", { class: "linkbox" }, inp, h("button", { class: "btn small", text: "Copy", onclick: async () => {
        try { await navigator.clipboard.writeText(inp.value); toast("Link copied"); } catch { inp.focus(); inp.select(); toast("Press Ctrl+C to copy the selected text."); }
      } })),
      h("p", { class: "muted small m0", text: "For someone who already has a login, use Make administrator in the list instead." })],
      [h("button", { class: "btn right", text: "Done", onclick: closeSheet })]);
  } catch (e) { toast(e.message); }
}

boot();
