/* global TT */
(() => {
'use strict';
const { CATEGORIES: CATS, URGENCIES: URG, STATUSES, status, today, addDays, diffDays } = TT;

const S = {
  me: null, tasks: new Map(), cfg: { ...TT.DEFAULT_SETTINGS }, users: [], loaded: false, error: null,
  view: 'tasks', f: { q: '', eng: '', status: 'open', cat: '', urg: '' }, sort: { k: 'target', d: 1 }, aq: '',
  kpiFrom: new Date().getFullYear() + '-01-01', kpiTo: new Date().getFullYear() + '-12-31',
  edit: null, draft: null, confirmDel: false, confirmArchive: false, activity: [], saving: false,
};
try {
  const v = JSON.parse(localStorage.getItem('tt-prefs') || '{}');
  if (v.f) Object.assign(S.f, v.f);
  if (v.kpiFrom) { S.kpiFrom = v.kpiFrom; S.kpiTo = v.kpiTo; }
} catch (e) { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem('tt-prefs', JSON.stringify({ f: S.f, kpiFrom: S.kpiFrom, kpiTo: S.kpiTo })); } catch (e) { /* ignore */ } };

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmt = (s) => { if (!s) return '—'; const [y, m, d] = s.slice(0, 10).split('-'); return +d + ' ' + MON[m - 1] + ' ' + y; };
const fmtTime = (s) => { const d = new Date(s); return fmt(TT.isoDate(d)) + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
const pctTxt = (x) => Math.round((x || 0) * 100) + '%';
const slug = (s) => String(s).replace(/\s+/g, '-');
const cls = (p, s) => p + '-' + slug(s);
const isDone = (t) => !!t.actual;
const all = () => [...S.tasks.values()];
const canEdit = () => S.me && (S.me.role === 'engineer' || S.me.role === 'admin');
const isAdmin = () => S.me && S.me.role === 'admin';
const toast = (m) => { const el = document.createElement('div'); el.className = 'toast'; el.textContent = m; document.body.appendChild(el); setTimeout(() => el.remove(), 3200); };

// ---------- API ----------
async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: { 'X-Requested-With': 'tracker', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (res.status === 401 && url !== '/api/login') { showLogin(); }
  if (!res.ok) { const err = new Error(data.error || 'Request failed (' + res.status + ').'); err.status = res.status; throw err; }
  return data;
}

async function loadTasks() {
  const { tasks } = await api('GET', '/api/tasks');
  S.tasks = new Map(tasks.map((t) => [String(t.no), t]));
  S.loaded = true;
  $('#sync').textContent = 'live · ' + tasks.length + ' tasks';
}
async function loadSettings() { const { settings } = await api('GET', '/api/settings'); S.cfg = settings; }
async function loadUsers() { if (isAdmin()) { const { users } = await api('GET', '/api/users'); S.users = users; } }

let events = null;
function listen() {
  if (events) events.close();
  events = new EventSource('/api/events');
  events.addEventListener('change', async (e) => {
    const { type } = JSON.parse(e.data);
    try {
      if (type === 'tasks') await loadTasks(); else await loadSettings();
      render();
    } catch (err) { /* will retry on next event */ }
  });
  events.onerror = () => { $('#sync').textContent = 'reconnecting…'; };
  events.onopen = () => { if (S.loaded) { $('#sync').textContent = 'live · ' + S.tasks.size + ' tasks'; loadTasks().then(render).catch(() => {}); } };
}

// ---------- session ----------
function showLogin() {
  if (events) { events.close(); events = null; }
  S.me = null;
  $('#appView').hidden = true;
  $('#loginView').hidden = false;
  setTimeout(() => $('#lUser').focus(), 0);
}
async function start() {
  try {
    const { user } = await api('GET', '/api/me');
    S.me = user;
  } catch (e) { if (e.status !== 401) { document.body.textContent = 'Could not reach the tracker server. Check that it is running and refresh.'; } return; }
  $('#loginView').hidden = true;
  $('#appView').hidden = false;
  $('#whoName').textContent = S.me.name;
  $('#whoRole').textContent = { admin: 'Admin', engineer: 'Engineer', viewer: 'View only' }[S.me.role];
  $('#newBtn').hidden = !canEdit();
  try {
    await Promise.all([loadTasks(), loadSettings(), loadUsers()]);
  } catch (e) { S.error = e.message; }
  listen();
  route();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#lErr').textContent = '';
  $('#lBtn').disabled = true;
  try {
    await api('POST', '/api/login', { username: $('#lUser').value, password: $('#lPass').value });
    $('#lPass').value = '';
    await start();
  } catch (err) { $('#lErr').textContent = err.message; } finally { $('#lBtn').disabled = false; }
});
$('#logoutBtn').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch (e) { /* ignore */ } showLogin(); });

// ---------- routing ----------
const VIEWS = ['tasks', 'workload', 'kpi', 'archive', 'setup'];
function route() { const h = location.hash.slice(1); S.view = VIEWS.includes(h) ? h : 'tasks'; render(); }
addEventListener('hashchange', route);

// ---------- render ----------
function render() {
  if (!S.me) return;
  document.querySelectorAll('#nav a').forEach((a) => { if (a.dataset.v === S.view) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  const app = $('#app');
  if (S.error && !S.loaded) { app.innerHTML = `<div class="empty">${esc(S.error)}</div>`; return; }
  if (!S.loaded) { app.innerHTML = '<div class="empty">Loading the team\'s tasks…</div>'; return; }
  const q = document.activeElement && document.activeElement.id;
  const pos = q && document.activeElement.selectionStart;
  app.innerHTML = ({ tasks: vTasks, workload: vWorkload, kpi: vKpi, archive: vArchive, setup: vSetup })[S.view]();
  if (q === 'q' || q === 'aq') { const el = $('#' + q); if (el) { el.focus(); el.setSelectionRange(pos, pos); } }
}

function filtered() {
  const f = S.f; const q = f.q.trim().toLowerCase(); const t0 = today();
  let rows = all().filter((t) => !t.archived);
  if (f.status === 'open') rows = rows.filter((t) => !isDone(t));
  else if (f.status === 'due7') rows = rows.filter((t) => !isDone(t) && t.target && t.target >= t0 && t.target <= addDays(t0, 7));
  else if (f.status === 'done') rows = rows.filter(isDone);
  else if (f.status) rows = rows.filter((t) => status(t) === f.status);
  if (f.eng) rows = rows.filter((t) => t.lead.includes(f.eng) || t.support.includes(f.eng));
  if (f.cat) rows = rows.filter((t) => t.category === f.cat);
  if (f.urg) rows = rows.filter((t) => t.urgency === f.urg);
  if (q) rows = rows.filter((t) => [t.title, t.customer, t.progress, t.lead.join(' '), t.support.join(' '), t.no].join(' ').toLowerCase().includes(q));
  const k = S.sort.k; const d = S.sort.d; const ur = (u) => URG.indexOf(u);
  rows.sort((a, b) => {
    let x; let y;
    if (k === 'urgency') { x = ur(a.urgency); y = ur(b.urgency); } else if (k === 'pct') { x = a.pct; y = b.pct; } else if (k === 'no') { x = a.no; y = b.no; } else if (k === 'status') { x = STATUSES.indexOf(status(a)); y = STATUSES.indexOf(status(b)); } else { x = a[k] || '9999'; y = b[k] || '9999'; }
    return ((x < y ? -1 : x > y ? 1 : 0) * d) || (a.no - b.no);
  });
  return rows;
}
function dueTxt(t) {
  if (isDone(t) || !t.target) return '';
  const n = diffDays(t.target, today());
  if (n < 0) return `<div class="due late">${-n} day${n === -1 ? '' : 's'} overdue</div>`;
  if (n === 0) return '<div class="due soon">due today</div>';
  return `<div class="due ${n <= 7 ? 'soon' : ''}">in ${n} day${n === 1 ? '' : 's'}</div>`;
}
function taskRows(rows, archive) {
  return rows.map((t) => {
    const st = status(t);
    return `<tr data-no="${t.no}" class="${cls('sev', t.urgency)}" tabindex="0">
    <td class="num">${t.no}</td>
    <td><span class="tag">${esc(t.category)}</span></td>
    <td style="min-width:220px"><div class="t-title">${esc(t.title)}</div><div class="t-cust">${esc(t.customer)}</div></td>
    <td><div class="t-prog">${esc(t.progress.trim()) || '<i>No update yet</i>'}</div></td>
    <td><div class="pct"><div class="bar"><i style="width:${Math.round(t.pct * 100)}%"></i></div><span class="num">${pctTxt(t.pct)}</span></div></td>
    <td class="${cls('u', t.urgency)}">${esc(t.urgency)}</td>
    <td class="people"><div>${esc(t.lead.join(', ')) || '—'}</div>${t.support.length ? `<div class="sup">+ ${esc(t.support.join(', '))}</div>` : ''}</td>
    <td class="num" style="white-space:nowrap">${archive ? fmt(t.actual) : fmt(t.target)}${archive ? `<div class="due">target ${fmt(t.target)}</div>` : dueTxt(t)}</td>
    <td><span class="pill ${cls('st', st)}">${st}</span></td></tr>`;
  }).join('');
}
const th = (k, label) => { const a = S.sort.k === k ? (S.sort.d > 0 ? ' ↑' : ' ↓') : ''; return `<th class="sortable" data-sort="${k}">${label}${a}</th>`; };
const opt = (v, l, cur) => `<option value="${esc(v)}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`;
const readyToArchive = () => TT.readyToArchive(all(), S.cfg.archiveAfterDays);

function vTasks() {
  const act = all().filter((t) => !t.archived); const t0 = today();
  const c = {
    open: act.filter((t) => !isDone(t)).length,
    Delay: act.filter((t) => status(t) === 'Delay').length,
    due7: act.filter((t) => !isDone(t) && t.target && t.target >= t0 && t.target <= addDays(t0, 7)).length,
    done: act.filter(isDone).length,
  };
  const ready = readyToArchive();
  const rows = filtered(); const f = S.f;
  const engs = [...new Set([...S.cfg.engineers, ...act.flatMap((t) => [...t.lead, ...t.support])])];
  return `<div class="stack">
  <div class="row between"><div><h2>Daily tasks</h2><p class="sub">${fmt(t0)} · status updates itself from the target and actual dates.</p></div>
    <div class="row">${ready.length && canEdit() ? `<button id="archBtn" type="button">Archive ${ready.length} finished task${ready.length > 1 ? 's' : ''}</button>` : ''}<a class="btn" href="/api/export.csv?which=active">Export CSV</a></div></div>
  ${S.confirmArchive ? `<div class="confirm">Move ${ready.length} task${ready.length > 1 ? 's' : ''} completed ${S.cfg.archiveAfterDays}+ days ago to the Archive? They stay counted in the KPI scorecard. <button class="danger" id="archYes" type="button">Archive them</button><button class="ghost" id="archNo" type="button">Cancel</button></div>` : ''}
  <div class="strip">
    <button type="button" data-st="open" class="${f.status === 'open' ? 'on' : ''}"><span class="eyebrow">Open</span><b>${c.open}</b></button>
    <button type="button" data-st="Delay" class="bad ${f.status === 'Delay' ? 'on' : ''}"><span class="eyebrow">Delayed</span><b>${c.Delay}</b></button>
    <button type="button" data-st="due7" class="warn ${f.status === 'due7' ? 'on' : ''}"><span class="eyebrow">Due in 7 days</span><b>${c.due7}</b></button>
    <button type="button" data-st="done" class="ok ${f.status === 'done' ? 'on' : ''}"><span class="eyebrow">Completed, not archived</span><b>${c.done}</b></button>
  </div>
  <div class="filters">
    <input type="search" id="q" placeholder="Search task, customer, update, person…" value="${esc(f.q)}" aria-label="Search tasks">
    <select id="fEng" aria-label="Engineer">${opt('', 'All engineers', f.eng)}${engs.map((e) => opt(e, e, f.eng)).join('')}</select>
    <select id="fSt" aria-label="Status">${opt('', 'All statuses', f.status)}${opt('open', 'Open (On-Going + Delay)', f.status)}${opt('due7', 'Due in 7 days', f.status)}${opt('done', 'Completed', f.status)}${STATUSES.map((s) => opt(s, s, f.status)).join('')}</select>
    <select id="fCat" aria-label="Category">${opt('', 'All categories', f.cat)}${CATS.map((s) => opt(s, s, f.cat)).join('')}</select>
    <select id="fUrg" aria-label="Urgency">${opt('', 'Any urgency', f.urg)}${URG.map((s) => opt(s, s, f.urg)).join('')}</select>
    ${f.q || f.eng || f.cat || f.urg || f.status !== 'open' ? '<button class="ghost" id="clr" type="button">Reset filters</button>' : ''}
  </div>
  <div class="tbl"><table><thead><tr>${th('no', 'No')}${th('category', 'Category')}${th('title', 'Task / Customer')}<th>Latest progress</th>${th('pct', 'Done')}${th('urgency', 'Urgency')}<th>Lead + Support</th>${th('target', 'Target')}${th('status', 'Status')}</tr></thead>
  <tbody>${taskRows(rows)}</tbody></table>${rows.length ? '' : `<div class="empty">No tasks match these filters.${act.length ? '' : canEdit() ? ' Add the first task with <b>+ New task</b>.' : ''}</div>`}</div>
  <p class="meta">${rows.length} of ${act.length} active tasks shown. Left edge marks High (amber) and Critical (red) urgency.</p>
  </div>`;
}

function vWorkload() {
  const open = all().filter((t) => !t.archived && !isDone(t));
  const engs = [...new Set([...S.cfg.engineers, ...open.flatMap((t) => t.lead)])];
  const data = engs.map((e) => {
    const L = open.filter((t) => t.lead.includes(e)); const Sp = open.filter((t) => t.support.includes(e));
    return { e, L, Sp, delay: [...L, ...Sp].filter((t) => status(t) === 'Delay').length };
  }).sort((a, b) => (b.L.length + b.Sp.length) - (a.L.length + a.Sp.length));
  const max = Math.max(1, ...data.map((d) => d.L.length + d.Sp.length));
  return `<div class="stack"><div class="row between"><div><h2>Workload</h2><p class="sub">Open tasks (On-Going and Delay) per engineer, as lead or support.</p></div>
  <div class="legend"><span><i></i>Lead</span><span><i style="opacity:.4"></i>Support</span></div></div>
  <div class="load">${data.map((d) => {
    const tot = d.L.length + d.Sp.length;
    const list = [...d.L.map((t) => [t, 'Lead']), ...d.Sp.map((t) => [t, 'Support'])].sort((a, b) => ((a[0].target || '9') < (b[0].target || '9') ? -1 : 1));
    return `<div class="card"><div class="row between"><h3>${esc(d.e)}</h3><span class="num">${tot} open${d.delay ? ` · <span style="color:var(--bad)">${d.delay} delayed</span>` : ''}</span></div>
    <div class="lbar" style="width:${Math.max(4, (tot / max) * 100)}%" title="${d.L.length} lead, ${d.Sp.length} support"><i class="l" style="width:${tot ? (d.L.length / tot) * 100 : 0}%"></i><i class="s" style="width:${tot ? (d.Sp.length / tot) * 100 : 0}%"></i></div>
    <div class="meta">${d.L.length} lead · ${d.Sp.length} support</div>
    ${list.length ? `<ul class="mini">${list.map(([t, r]) => `<li data-no="${t.no}"><span class="nm">${esc(t.title)}</span><span class="row" style="gap:6px;flex-wrap:nowrap"><span class="meta">${r}</span><span class="pill ${cls('st', status(t))}">${status(t) === 'Delay' ? 'Delay' : fmt(t.target)}</span></span></li>`).join('')}</ul>` : '<div class="meta">No open tasks.</div>'}</div>`;
  }).join('')}</div></div>`;
}

function vKpi() {
  const C = S.cfg; const { team, rows } = TT.kpi(all(), C, S.kpiFrom, S.kpiTo);
  const p = (x) => Math.round(x * 100) + '%'; const d1 = (x) => (x ? x.toFixed(1) : '0');
  const ticks = [0, 0.2, 0.4, 0.6, 0.8, 1];
  return `<div class="stack">
  <div class="row between"><div><h2>KPI scorecard</h2><p class="sub">Completed tasks with an actual date in the period, from both active and archived tasks.</p></div>
    <div class="row"><label class="f">From<input type="date" id="kFrom" value="${S.kpiFrom}"></label><label class="f">To<input type="date" id="kTo" value="${S.kpiTo}"></label></div></div>
  <div class="tiles">
    <div class="tile"><span class="eyebrow">Tasks completed</span><b>${team.completed}</b></div>
    <div class="tile"><span class="eyebrow">On time or early</span><b style="color:var(--ok)">${team.onTime}</b></div>
    <div class="tile"><span class="eyebrow">Late</span><b style="color:var(--warn)">${team.late}</b></div>
    <div class="tile"><span class="eyebrow">On-time rate</span><b>${p(team.onTimePct)}</b></div>
    <div class="tile"><span class="eyebrow">Avg days late</span><b>${d1(team.avgDaysLate)}</b></div>
    <div class="tile"><span class="eyebrow">Avg cycle time (days)</span><b>${d1(team.avgCycle)}</b></div>
  </div>
  <div class="scorechart" role="img" aria-label="KPI score per engineer">
    <div class="row between"><h3>KPI score</h3><span class="meta">Score = On-time % × ${p(C.wOnTime)} + Early % × ${p(C.wEarly)} · dashed lines: Good ${p(C.tGood)}, Excellent ${p(C.tExcellent)}</span></div>
    ${rows.map((r) => `<div class="sc-row"><span>${esc(r.engineer)}</span><div class="sc-track"><i style="width:${Math.min(100, r.score * 100)}%;${r.total ? '' : 'opacity:0'}"></i><s style="left:${C.tGood * 100}%"></s><s style="left:${C.tExcellent * 100}%"></s></div><span class="num" style="text-align:right">${r.total ? p(r.score) : '—'}</span></div>`).join('')}
    <div class="sc-axis">${ticks.map((t) => `<span style="left:${t * 100}%">${t * 100}%</span>`).join('')}</div>
  </div>
  <div class="tbl"><table class="score"><thead><tr><th>Engineer</th><th class="num">Lead</th><th class="num">Support</th><th class="num">Total</th><th class="num">Lead on-time</th><th class="num">Support on-time</th><th class="num">Total on-time</th><th class="num">Early</th><th class="num">High/Critical led</th><th class="num">Avg days late</th><th class="num">Avg cycle</th><th class="num">Score</th><th>Rating</th></tr></thead>
  <tbody>${rows.map((r) => `<tr><td><b>${esc(r.engineer)}</b></td><td class="num">${r.lead}</td><td class="num">${r.support}</td><td class="num">${r.total}</td>
    <td class="num">${r.leadOnTime}/${r.lead} · ${p(r.leadOnTimePct)}</td><td class="num">${r.supportOnTime}/${r.support} · ${p(r.supportOnTimePct)}</td><td class="num">${p(r.totalOnTimePct)}</td><td class="num">${r.early} · ${p(r.earlyPct)}</td>
    <td class="num">${r.highLed}</td><td class="num">${d1(r.avgDaysLate)}</td><td class="num">${d1(r.avgCycle)}</td><td class="num"><b>${r.total ? p(r.score) : '—'}</b></td><td><span class="pill ${cls('r', r.rating)}">${r.rating}</span></td></tr>`).join('')}</tbody></table></div>
  <p class="meta">Ratings: Excellent ≥ ${p(C.tExcellent)} · Good ≥ ${p(C.tGood)} · Needs Improvement ≥ ${p(C.tNeeds)} · otherwise At Risk.${isAdmin() ? ' Change the weights and thresholds under Team setup.' : ''}</p>
  </div>`;
}

function vArchive() {
  const q = S.aq.trim().toLowerCase();
  let rows = all().filter((t) => t.archived);
  const total = rows.length;
  if (q) rows = rows.filter((t) => [t.title, t.customer, t.progress, t.lead.join(' '), t.support.join(' '), t.no, t.category].join(' ').toLowerCase().includes(q));
  rows.sort((a, b) => ((b.actual || '') < (a.actual || '') ? -1 : 1));
  return `<div class="stack"><div class="row between"><div><h2>Archive</h2><p class="sub">${total} finished tasks. Open one to read its history${canEdit() ? ' or move it back to Daily tasks' : ''}.</p></div><a class="btn" href="/api/export.csv?which=archive">Export CSV</a></div>
  <div class="filters"><input type="search" id="aq" placeholder="Search archived tasks…" value="${esc(S.aq)}" aria-label="Search archive"></div>
  <div class="tbl"><table><thead><tr><th>No</th><th>Category</th><th>Task / Customer</th><th>Progress notes</th><th>Done</th><th>Urgency</th><th>Lead + Support</th><th>Completed</th><th>Status</th></tr></thead><tbody>${taskRows(rows, true)}</tbody></table>${rows.length ? '' : `<div class="empty">${total ? 'No archived tasks match.' : 'Nothing archived yet. Finished tasks move here from Daily tasks.'}</div>`}</div></div>`;
}

function vSetup() {
  const C = S.cfg; const ro = !isAdmin(); const dis = ro ? 'disabled' : '';
  const lst = (key, items) => `<div class="list-edit">${items.map((x, i) => `<span>${esc(x)}${ro ? '' : `<button type="button" data-rm="${key}" data-i="${i}" aria-label="Remove ${esc(x)}">×</button>`}</span>`).join('')}</div>
    ${ro ? '' : `<form class="row" data-add="${key}"><input id="add-${key}" placeholder="Add ${key === 'engineers' ? 'engineer' : 'customer'}" style="flex:1"><button type="submit">Add</button></form>`}`;
  const n = (id, label, v, step) => `<label class="f">${label}<input type="number" id="${id}" value="${v}" step="${step || 0.05}" min="0" ${dis}></label>`;
  const roleOpts = (cur) => ['admin', 'engineer', 'viewer'].map((r) => opt(r, { admin: 'Admin', engineer: 'Engineer', viewer: 'View only' }[r], cur)).join('');
  return `<div class="stack"><div><h2>Team setup</h2><p class="sub">Lists, scoring rules and accounts used across the tracker.${ro ? ' Only admins can change the team lists and scoring.' : ''}</p></div>
  <div class="grid2">
    <div class="panel"><h3>My account</h3>
      <form id="pwForm" class="stack" style="gap:10px">
        <label class="f">Current password<input type="password" id="pwCur" autocomplete="current-password" required></label>
        <label class="f">New password (8+ characters)<input type="password" id="pwNew" autocomplete="new-password" minlength="8" required></label>
        <div><button type="submit">Change password</button></div>
      </form></div>
    <div class="panel"><h3>Export</h3><p class="meta">Download tasks as a CSV file that opens in Excel.</p>
      <div class="links"><a class="btn" href="/api/export.csv?which=active">Active tasks</a><a class="btn" href="/api/export.csv?which=archive">Archive</a><a class="btn" href="/api/export.csv?which=all">Everything</a></div></div>
    <div class="panel"><h3>Engineers</h3><p class="meta">Shown as picks on every task and as rows in Workload and KPI.</p>${lst('engineers', C.engineers)}</div>
    <div class="panel"><h3>Customers</h3>${lst('customers', C.customers)}</div>
    <div class="panel"><h3>KPI scoring</h3>
      <div class="pairs">${n('wOnTime', 'On-time weight', C.wOnTime)}${n('wEarly', 'Early completion weight', C.wEarly)}
      ${n('tExcellent', 'Excellent from', C.tExcellent)}${n('tGood', 'Good from', C.tGood)}${n('tNeeds', 'Needs Improvement from', C.tNeeds)}${n('archiveAfterDays', 'Archive after (days)', C.archiveAfterDays, 1)}</div>
      ${ro ? '' : '<div><button class="primary" id="saveCfg" type="button">Save scoring rules</button></div>'}
      <p class="meta">Weights should add up to 1. Currently ${(+C.wOnTime + +C.wEarly).toFixed(2)}.</p></div>
  </div>
  ${isAdmin() ? `<div class="panel"><div class="row between"><h3>User accounts</h3><span class="meta">Engineers can add and edit tasks. View-only users can read everything. Only admins can delete tasks and manage accounts.</span></div>
    <div class="tbl"><table class="users"><thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Active</th><th>Reset password</th></tr></thead><tbody>
    ${S.users.map((u) => `<tr data-user="${u.id}"><td>${esc(u.name)}</td><td class="num">${esc(u.username)}</td>
      <td><select data-urole="${u.id}" aria-label="Role for ${esc(u.name)}">${roleOpts(u.role)}</select></td>
      <td><input type="checkbox" data-uactive="${u.id}" ${u.active ? 'checked' : ''} aria-label="${esc(u.name)} can sign in"></td>
      <td><form class="row" data-upw="${u.id}"><input type="password" placeholder="New password" minlength="8" autocomplete="new-password" aria-label="New password for ${esc(u.name)}"><button type="submit">Set</button></form></td></tr>`).join('')}
    </tbody></table></div>
    <form id="newUser" class="row" style="align-items:flex-end">
      <label class="f">Name<input id="nuName" required placeholder="e.g. Khaidir"></label>
      <label class="f">Username<input id="nuUser" required placeholder="khaidir" autocomplete="off"></label>
      <label class="f">Role<select id="nuRole">${roleOpts('engineer')}</select></label>
      <label class="f">Password<input id="nuPass" type="password" minlength="8" required autocomplete="new-password"></label>
      <button class="primary" type="submit">Add user</button>
    </form></div>` : ''}
  </div>`;
}

// ---------- drawer ----------
function blankTask() {
  return { no: '', category: 'Tickets', title: '', progress: '', pct: 0, urgency: 'Medium', customer: '', lead: [], support: [], start: today(), target: '', actual: '', archived: false };
}
function openTask(no) {
  const t = no ? S.tasks.get(String(no)) : null;
  S.edit = no ? String(no) : 'new'; S.confirmDel = false; S.activity = [];
  S.draft = t ? JSON.parse(JSON.stringify(t)) : blankTask();
  renderDrawer();
  if (t) api('GET', '/api/tasks/' + t.no + '/activity').then((r) => { if (S.edit === String(t.no)) { S.activity = r.activity; readDraft(); renderDrawer(); } }).catch(() => {});
  setTimeout(() => { const el = $('#d-title'); if (el && !no) el.focus(); }, 30);
}
function closeDrawer() { S.edit = null; S.draft = null; renderDrawer(); }
function renderDrawer() {
  const L = $('#layer'); if (!S.edit) { L.innerHTML = ''; return; }
  const d = S.draft; const isNew = S.edit === 'new'; const ro = !canEdit(); const C = S.cfg;
  const people = [...new Set([...C.engineers, ...d.lead, ...d.support])];
  const custs = [...new Set([...C.customers, ...(d.customer ? [d.customer] : [])])];
  const dis = ro ? 'disabled' : '';
  const seg = (k, opts) => `<div class="seg" role="group">${opts.map((o) => `<button type="button" data-seg="${k}" data-v="${esc(o)}" aria-pressed="${d[k] === o}" ${dis}>${esc(o)}</button>`).join('')}</div>`;
  const chips = (role) => `<div class="chips">${people.map((p) => `<button type="button" class="chip" data-role="${role}" data-p="${esc(p)}" aria-pressed="${d[role].includes(p)}" ${dis}>${esc(p)}</button>`).join('')}</div>`;
  const st = status(d); const orig = isNew ? null : S.tasks.get(S.edit);
  const actLabel = { created: 'Created', updated: 'Updated', archived: 'Archived', restored: 'Restored', deleted: 'Deleted' };
  L.innerHTML = `<div class="scrim" id="scrim"></div><aside class="drawer" role="dialog" aria-modal="true" aria-label="${isNew ? 'New task' : 'Edit task'}">
  <div class="dh"><div><span class="eyebrow">${isNew ? 'New task' : 'Task · No ' + d.no}${d.archived ? ' · Archived' : ''}</span><div><span class="pill ${cls('st', st)}" id="d-status">${st}</span></div></div><button class="ghost" id="dClose" type="button" aria-label="Close">✕</button></div>
  <form class="db" id="dForm">
    <label class="f full">Main task / project<input id="d-title" value="${esc(d.title)}" required placeholder="e.g. RHB Health Check H2" ${dis}></label>
    <label class="f">Customer<select id="d-customer" ${dis}><option value="">— choose —</option>${custs.map((c) => `<option${c === d.customer ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
    <label class="f">Task no<input id="d-no" type="number" min="1" value="${d.no}" placeholder="next free number" ${isNew ? '' : 'disabled'}></label>
    <div class="f full"><span class="f">Category</span>${seg('category', CATS)}</div>
    <div class="f full"><span class="f">Urgency</span>${seg('urgency', URG)}</div>
    <div class="f full"><span class="f">Lead engineer</span>${chips('lead')}</div>
    <div class="f full"><span class="f">Support engineer</span>${chips('support')}${ro ? '' : '<div class="row" style="margin-top:6px"><input id="d-other" placeholder="Add someone not in the team list" style="flex:1"><button type="button" id="d-addp">Add</button></div>'}</div>
    <label class="f full">Task progress<textarea id="d-progress" rows="6" placeholder="Latest status, next step, blockers…" ${dis}>${esc(d.progress)}</textarea></label>
    <label class="f full"><span>Task percentage · <span class="num" id="d-pctv">${pctTxt(d.pct)}</span></span><input id="d-pct" type="range" min="0" max="100" step="5" value="${Math.round((d.pct || 0) * 100)}" ${dis}></label>
    <label class="f">Start date<input id="d-start" type="date" value="${d.start || ''}" ${dis}></label>
    <label class="f">Target date<input id="d-target" type="date" value="${d.target || ''}" ${dis}></label>
    <label class="f">Actual date (completed)<input id="d-actual" type="date" value="${d.actual || ''}" ${dis}></label>
    <div class="f" style="justify-content:flex-end">${ro ? '' : '<button type="button" id="d-done">Mark done today</button>'}</div>
    ${orig ? `<div class="full"><span class="eyebrow">History</span>${S.activity.length ? `<ul class="history" style="margin-top:8px">${S.activity.map((a) => `<li><b>${actLabel[a.action] || esc(a.action)}</b>${a.by ? ' by ' + esc(a.by) : ''} <span class="when">· ${fmtTime(a.at)}</span>${a.detail ? `<div>${a.action === 'updated' ? 'Changed: ' : ''}${esc(a.detail)}</div>` : ''}</li>`).join('')}</ul>` : `<p class="meta">Last saved ${fmt(orig.updatedAt)}${orig.updatedBy ? ' by ' + esc(orig.updatedBy) : ''}.</p>`}</div>` : ''}
  </form>
  <div class="df">
    ${S.confirmDel ? '<div class="confirm" style="flex:1">Delete this task for everyone? This can\'t be undone. <button class="danger" id="dDelYes" type="button">Delete</button><button class="ghost" id="dDelNo" type="button">Keep</button></div>' : `
    ${ro ? '<span class="meta">Your account is view-only.</span>' : `<button class="primary" id="dSave" type="button" ${S.saving ? 'disabled' : ''}>${isNew ? 'Add task' : 'Save changes'}</button>`}
    <button class="ghost" id="dCancel" type="button">${ro ? 'Close' : 'Cancel'}</button>
    <span style="flex:1"></span>
    ${!isNew && !ro ? `${d.archived ? '<button type="button" id="dRestore">Move back to Daily tasks</button>' : d.actual ? '<button type="button" id="dArchive">Archive</button>' : ''}${isAdmin() ? '<button class="danger" id="dDel" type="button">Delete</button>' : ''}` : ''}`}
  </div></aside>`;
}
function readDraft() {
  const d = S.draft; if (!d || !$('#d-title')) return;
  const v = (id) => { const el = $('#' + id); return el ? el.value : undefined; };
  d.title = v('d-title'); d.customer = v('d-customer'); d.progress = v('d-progress'); d.pct = (+v('d-pct')) / 100;
  d.start = v('d-start'); d.target = v('d-target'); d.actual = v('d-actual');
  if (S.edit === 'new') d.no = v('d-no');
}
async function saveDraft(extra) {
  readDraft();
  const d = { ...S.draft, ...(extra || {}) };
  if (!d.title.trim()) { toast('Give the task a name before saving.'); $('#d-title').focus(); return; }
  if (!d.lead.length) { toast('Pick a lead engineer.'); return; }
  const body = { ...d, start: d.start || null, target: d.target || null, actual: d.actual || null };
  S.saving = true;
  try {
    if (S.edit === 'new') { delete body.updatedAt; await api('POST', '/api/tasks', body); toast('Task added'); } else { await api('PUT', '/api/tasks/' + S.edit, body); toast(extra && 'archived' in extra ? (extra.archived ? 'Moved to Archive' : 'Back in Daily tasks') : 'Saved'); }
    closeDrawer();
    await loadTasks(); render();
  } catch (err) { toast(err.message); } finally { S.saving = false; if (S.edit) renderDrawer(); }
}

async function saveSettings(next, msg) {
  try { const { settings } = await api('PUT', '/api/settings', next); S.cfg = settings; render(); if (msg) toast(msg); } catch (err) { toast(err.message); }
}

// ---------- events ----------
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button,tr[data-no],li[data-no],th[data-sort]'); if (!t || !S.me) return;
  if (t.id === 'newBtn') { openTask(null); return; }
  if (t.matches('tr[data-no],li[data-no]') && !t.closest('.drawer')) { openTask(t.dataset.no); return; }
  if (t.matches('th[data-sort]')) { const k = t.dataset.sort; S.sort = S.sort.k === k ? { k, d: -S.sort.d } : { k, d: 1 }; render(); return; }
  if (t.dataset.st) { S.f.status = S.f.status === t.dataset.st && t.dataset.st !== 'open' ? 'open' : t.dataset.st; savePrefs(); render(); return; }
  if (t.id === 'clr') { S.f = { q: '', eng: '', status: 'open', cat: '', urg: '' }; savePrefs(); render(); return; }
  if (t.id === 'archBtn') { S.confirmArchive = true; render(); return; }
  if (t.id === 'archNo') { S.confirmArchive = false; render(); return; }
  if (t.id === 'archYes') {
    S.confirmArchive = false; render();
    try { const r = await api('POST', '/api/tasks/archive-finished'); toast('Archived ' + r.archived + ' task' + (r.archived === 1 ? '' : 's')); await loadTasks(); render(); } catch (err) { toast(err.message); }
    return;
  }
  // drawer
  if (t.id === 'dClose' || t.id === 'dCancel') { closeDrawer(); return; }
  if (t.dataset.seg) { readDraft(); S.draft[t.dataset.seg] = t.dataset.v; renderDrawer(); return; }
  if (t.dataset.role) {
    readDraft(); const r = t.dataset.role; const o = r === 'lead' ? 'support' : 'lead'; const p = t.dataset.p; const d = S.draft;
    if (d[r].includes(p)) d[r] = d[r].filter((x) => x !== p); else { d[r].push(p); d[o] = d[o].filter((x) => x !== p); }
    renderDrawer(); return;
  }
  if (t.id === 'd-addp') { const nm = $('#d-other').value.trim(); readDraft(); if (nm && !S.draft.support.includes(nm) && !S.draft.lead.includes(nm)) S.draft.support.push(nm); renderDrawer(); return; }
  if (t.id === 'd-done') { readDraft(); S.draft.actual = today(); S.draft.pct = 1; renderDrawer(); return; }
  if (t.id === 'dSave') { await saveDraft(); return; }
  if (t.id === 'dArchive') { await saveDraft({ archived: true }); return; }
  if (t.id === 'dRestore') { await saveDraft({ archived: false }); return; }
  if (t.id === 'dDel') { readDraft(); S.confirmDel = true; renderDrawer(); return; }
  if (t.id === 'dDelNo') { S.confirmDel = false; renderDrawer(); return; }
  if (t.id === 'dDelYes') { try { await api('DELETE', '/api/tasks/' + S.edit); toast('Task deleted'); closeDrawer(); await loadTasks(); render(); } catch (err) { toast(err.message); } return; }
  // setup
  if (t.dataset.rm) { const k = t.dataset.rm; const arr = [...S.cfg[k]]; arr.splice(+t.dataset.i, 1); await saveSettings({ [k]: arr }); return; }
  if (t.id === 'saveCfg') {
    const g = (id) => +$('#' + id).value;
    await saveSettings({ wOnTime: g('wOnTime'), wEarly: g('wEarly'), tExcellent: g('tExcellent'), tGood: g('tGood'), tNeeds: g('tNeeds'), archiveAfterDays: g('archiveAfterDays') }, 'Scoring rules saved');
  }
});
document.addEventListener('click', (e) => { if (e.target.id === 'scrim') closeDrawer(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && S.edit) { closeDrawer(); return; }
  if (e.key === 'Enter' && e.target.matches('tr[data-no]')) openTask(e.target.dataset.no);
});
document.addEventListener('submit', async (e) => {
  const form = e.target;
  if (form.id === 'loginForm') return;
  e.preventDefault();
  if (form.dataset.add) {
    const k = form.dataset.add; const v = $('#add-' + k).value.trim(); if (!v) return;
    if (S.cfg[k].includes(v)) { toast(v + ' is already on the list'); return; }
    const arr = [...S.cfg[k], v]; if (k === 'customers') arr.sort((a, b) => a.localeCompare(b));
    await saveSettings({ [k]: arr });
  } else if (form.id === 'pwForm') {
    try { await api('PUT', '/api/me/password', { current: $('#pwCur').value, next: $('#pwNew').value }); form.reset(); toast('Password changed'); } catch (err) { toast(err.message); }
  } else if (form.id === 'newUser') {
    try {
      await api('POST', '/api/users', { name: $('#nuName').value, username: $('#nuUser').value, role: $('#nuRole').value, password: $('#nuPass').value });
      await loadUsers(); render(); toast('User added');
    } catch (err) { toast(err.message); }
  } else if (form.dataset.upw) {
    const pw = form.querySelector('input').value;
    try { await api('PUT', '/api/users/' + form.dataset.upw, { password: pw }); form.reset(); toast('Password updated. They need to sign in again.'); } catch (err) { toast(err.message); }
  }
});
document.addEventListener('input', (e) => {
  const id = e.target.id;
  if (id === 'q') { S.f.q = e.target.value; savePrefs(); render(); } else if (id === 'aq') { S.aq = e.target.value; render(); } else if (id === 'd-pct') { $('#d-pctv').textContent = e.target.value + '%'; }
});
document.addEventListener('change', async (e) => {
  const el = e.target; const id = el.id; const m = { fEng: 'eng', fSt: 'status', fCat: 'cat', fUrg: 'urg' };
  if (m[id]) { S.f[m[id]] = el.value; savePrefs(); render(); return; }
  if (id === 'kFrom' || id === 'kTo') { if (id === 'kFrom') S.kpiFrom = el.value; else S.kpiTo = el.value; savePrefs(); render(); return; }
  if (el.dataset.urole || el.dataset.uactive) {
    const uid = el.dataset.urole || el.dataset.uactive;
    const body = el.dataset.urole ? { role: el.value } : { active: el.checked };
    try { await api('PUT', '/api/users/' + uid, body); toast('Account updated'); } catch (err) { toast(err.message); }
    await loadUsers(); render(); return;
  }
  if (S.edit && id && id.startsWith('d-') && id !== 'd-other' && id !== 'd-no') {
    // Update in place: re-rendering here would replace the button the user is about to click.
    readDraft();
    if (id === 'd-actual' && el.value && S.draft.pct < 1) {
      S.draft.pct = 1; $('#d-pct').value = 100; $('#d-pctv').textContent = '100%';
    }
    const pill = $('#d-status'); const st = status(S.draft);
    if (pill) { pill.className = 'pill ' + cls('st', st); pill.textContent = st; }
  }
});

start();
})();
