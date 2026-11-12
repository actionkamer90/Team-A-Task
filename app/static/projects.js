"use strict";
/* Projects tab: list, project page with Gantt timeline and plan, plan editor, holidays and export.
   Loaded before app.js; uses its helpers (h, S, api, toast, fmt, team, isLead, openSheet, closeSheet, render, custLabel…) when called. */

const PJ_COLOURS = [["#1F7A99", "#A9CCD8"], ["#ED7D31", "#F8CDB0"], ["#C00000", "#E79E9E"], ["#FFC000", "#FFE79E"], ["#2E75B6", "#AFCAE3"], ["#00B050", "#9EE0BC"]];
const PJ_STATUS_CLASS = { "Active": "info", "Planned": "", "On Hold": "warn", "Completed": "ok", "Cancelled": "", "At Risk": "bad" };
const ITEM_STATUS_CLASS = { "Not Started": "", "In Progress": "info", "Completed": "ok", "At Risk": "bad" };
const ITEM_STATUSES = ["Not Started", "In Progress", "Completed", "At Risk"];
const PROJECT_STATUSES = ["Planned", "Active", "On Hold", "Completed", "Cancelled"];
// Malaysia (Selangor) public holidays, as in the team's Excel timeline. Projects for overseas customers keep their own list.
const MY_HOLIDAYS = [["2026-10-26", "Sultan Selangor PH"], ["2026-11-09", "Deepavali"], ["2026-12-11", "Sultan Selangor's Birthday"], ["2026-12-25", "Christmas Day"],
  ["2027-01-01", "New Year's Day"], ["2027-01-22", "Thaipusam"], ["2027-02-01", "Federal Territory Day"], ["2027-02-06", "Chinese New Year"],
  ["2027-02-07", "Chinese New Year – Day 2"], ["2027-02-08", "Chinese New Year Replacement Holiday"], ["2027-02-24", "Nuzul Al-Quran"],
  ["2027-03-10", "Hari Raya Aidilfitri"], ["2027-03-11", "Hari Raya Aidilfitri – Day 2"], ["2027-05-01", "Labour Day"], ["2027-05-17", "Hari Raya Haji / Aidiladha"],
  ["2027-05-20", "Wesak Day"], ["2027-06-06", "Awal Muharram"], ["2027-06-07", "Yang di-Pertuan Agong's Birthday"], ["2027-06-08", "Replacement Holiday – Awal Muharram"],
  ["2027-08-15", "Maulidur Rasul"], ["2027-08-16", "Replacement Holiday – Maulidur Rasul"], ["2027-08-31", "National Day / Merdeka Day"],
  ["2027-09-16", "Malaysia Day"], ["2027-10-28", "Deepavali"], ["2027-12-11", "Sultan of Selangor's Birthday"], ["2027-12-25", "Christmas Day"]];

const pjPct = x => Math.round((x || 0) * 100) + "%";
const weeksLabel = (a, b) => { const wa = Math.floor((a - 1) / 5) + 1, wb = Math.floor((b - 1) / 5) + 1; return wa === wb ? "Week " + wa : "Week " + wa + "–" + wb; };
// Working day n -> date (day 1 = start date; weekends and the project's holidays skipped), like Excel WORKDAY
function workdays(start, holidays, upto) {
  const hol = new Set(holidays), out = [null];
  let d = new Date(start + "T00:00:00Z");
  out.push(d.toISOString().slice(0, 10));
  while (out.length <= upto) {
    d = new Date(d.getTime() + 864e5);
    const iso = d.toISOString().slice(0, 10), wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !hol.has(iso)) out.push(iso);
  }
  return out;
}
async function reloadProjects() { S.projects = await api("GET", "/api/teams/" + S.teamId + "/projects"); }

function viewProjects(main) {
  if (S.projectId) return projectPage(main, S.projectId);
  const P = S.projects || { projects: [] };
  main.append(h("div", { class: "row between" }, h("h2", { text: team().name + " · projects" }),
    P.canCreate ? h("button", { class: "btn primary", text: "+ New project", onclick: () => projectSheet(null) }) : null));
  if (!P.projects.length) {
    main.append(h("div", { class: "empty", text: P.canCreate ? "No projects yet. Use New project to register the first one; it starts from the implementation template (Requirement Study, Development, SIT, UAT, Production Preparation, Go-Live)."
      : "No projects yet. Your team lead or a Project Manager registers projects here." }));
    return;
  }
  const open = id => { S.projectId = id; render(); };
  const table = list => h("div", { class: "tscroll" }, h("table", { class: "pj-table" },
    h("thead", {}, h("tr", {}, ["Client", "Project", "Project manager", "Status", "Start", "Go-live", "Progress", "Overdue", "Tasks"].map((c, i) => h("th", { class: i >= 6 ? "num" : "", text: c })))),
    h("tbody", {}, list.map(p => h("tr", { class: "click", tabindex: "0", onclick: () => open(p.id), onkeydown: e => { if (e.key === "Enter") open(p.id); } },
      h("td", { class: "nowrap" }, custLabel(p.client)),
      h("td", {}, h("div", { class: "task-title", text: p.name }), p.description ? h("div", { class: "task-prog", text: p.description }) : null),
      h("td", { class: "nowrap", text: p.pmName || "—" }),
      h("td", {}, h("span", { class: "pill " + (PJ_STATUS_CLASS[p.displayStatus] || ""), text: p.displayStatus }),
        p.displayStatus === "At Risk" && p.status !== "At Risk" ? h("div", { class: "muted small", text: p.status }) : null),
      h("td", { class: "mono nowrap", text: fmt(p.startDate) }), h("td", { class: "mono nowrap", text: fmt(p.goLive) }),
      h("td", { class: "num" }, h("div", { class: "pct" }, h("i", {}, h("em", { style: "width:" + Math.round(p.progress * 100) + "%" })), h("span", { class: "mono", text: pjPct(p.progress) })),
        h("div", { class: "muted small", text: p.completed + " of " + p.activities })),
      ["Completed", "Cancelled"].includes(p.status) ? h("td", { class: "num muted", text: "—" }) : h("td", { class: "num mono" + (p.overdue ? " bad-text" : ""), text: p.overdue }),
      h("td", { class: "num mono", text: p.linkedTasks }))))));
  // running projects on top (soonest go-live first); completed and cancelled ones below, newest go-live first, in pages
  const done = p => p.status === "Completed" || p.status === "Cancelled";
  const byGoLive = (a, b) => (a.goLive || "9999").localeCompare(b.goLive || "9999") || a.name.localeCompare(b.name);
  const running = P.projects.filter(p => !done(p)).sort(byGoLive), closed = P.projects.filter(done).sort((a, b) => byGoLive(b, a));
  const R = S.pjRunPage || (S.pjRunPage = { page: 1, size: 20 }), C = S.pjDonePage || (S.pjDonePage = { page: 1, size: 10 });
  const section = (list, A, label, empty) => {
    const box = h("div");
    const draw = () => {
      const pages = Math.max(1, Math.ceil(list.length / A.size));
      A.page = Math.min(Math.max(1, A.page), pages);
      box.replaceChildren(...[list.length ? table(list.slice((A.page - 1) * A.size, A.page * A.size)) : h("p", { class: "muted m0", text: empty }),
        list.length > 10 ? pager(A, list.length, pages, { sizes: [10, 20, 50], label, redraw: draw }) : null].filter(Boolean));
    };
    draw();
    return box;
  };
  if (isLead() || team()?.isPm) main.append(teamLoad());
  main.append(h("h3", { class: "pj-sec", text: "Running projects (" + running.length + ")" }),
    section(running, R, "Running project pages", "No running projects. Completed and cancelled projects are listed below."));
  if (closed.length) main.append(h("h3", { class: "pj-sec", text: "Completed and cancelled (" + closed.length + ")" }),
    section(closed, C, "Completed project pages", ""));
}

function projectSheet(p) {
  const isNew = !p, tm = team();
  const fName = h("input", { type: "text", id: "pj-name", maxlength: "150", value: p?.name || "", placeholder: "e.g. Zena Upgrade" });
  const fClient = h("select", { id: "pj-client" }, h("option", { value: "", text: "— choose —" }),
    [...new Set([...(tm.customers || []), ...(p?.client ? [p.client] : [])])].sort((a, b) => a.localeCompare(b)).map(c => h("option", { value: c, text: c })));
  fClient.value = p?.client || "";
  const fDesc = h("textarea", { id: "pj-desc", maxlength: "4000", placeholder: "Scope and goal of the project" }); fDesc.value = p?.description || "";
  const pms = people().filter(x => x.active && (x.role === "pm" || x.role === "lead"));
  const fPm = h("select", { id: "pj-pm", disabled: !isNew && !isLead() }, h("option", { value: "", text: "— none —" }),
    pms.map(x => h("option", { value: String(x.id), text: x.name + " (" + ROLE_NAMES[x.role] + ")" })));
  fPm.value = p?.pmPersonId ? String(p.pmPersonId) : (isNew && team().isPm ? String((people().find(x => x.key === myKey()) || {}).id || "") : "");
  const fStart = h("input", { type: "date", id: "pj-start", value: p?.startDate || S.today || "" });
  const fStatus = h("select", { id: "pj-status" }, PROJECT_STATUSES.map(s => h("option", { value: s, text: s }))); fStatus.value = p?.status || "Planned";
  const fTpl = h("select", { id: "pj-template" }, Object.entries(S.projects?.templates || {}).map(([k, v]) => h("option", { value: k, text: v })), h("option", { value: "", text: "Blank plan (I'll add the phases myself)" }));
  const err = h("p", { class: "bad-text m0", role: "alert" });
  openSheet(isNew ? "New project" : "Edit project", [
    h("label", { class: "field" }, h("span", { text: "Client" }), fClient, tm.customers?.length ? null : h("small", { class: "muted", text: "Add clients on the Clients tab first." })),
    h("label", { class: "field" }, h("span", { text: "Project name" }), fName),
    h("label", { class: "field" }, h("span", { text: "Description" }), fDesc),
    h("div", { class: "f2" }, h("label", { class: "field" }, h("span", { text: "Project manager" }), fPm), h("label", { class: "field" }, h("span", { text: "Status" }), fStatus)),
    h("label", { class: "field w160" }, h("span", { text: "Start date (day 1 of the plan)" }), fStart),
    isNew ? h("label", { class: "field" }, h("span", { text: "Plan" }), fTpl, h("small", { class: "muted", text: "The template adds the phases, activities and milestones of a standard implementation, with typical durations in working days. Change anything afterwards in Edit plan." })) : null,
    h("p", { class: "muted small m0", text: "The project shows as At Risk on its own when an activity is overdue or marked At Risk." }), err],
    [h("button", { class: "btn primary", text: isNew ? "Create project" : "Save", onclick: async () => {
      err.textContent = "";
      const body = { name: fName.value, client: fClient.value, description: fDesc.value, pmPersonId: fPm.value ? Number(fPm.value) : null, startDate: fStart.value, status: fStatus.value };
      if (isNew) body.template = fTpl.value;
      try {
        const r = isNew ? await api("POST", "/api/teams/" + S.teamId + "/projects", body) : await api("PUT", "/api/projects/" + p.id, body);
        closeSheet(); toast(isNew ? "Project created" : "Saved");
        await reloadProjects(); S.projectId = isNew ? r.id : p.id; S.view = "projects"; render();
      } catch (e) { err.textContent = e.message; }
    } }), h("button", { class: "btn", text: "Cancel", onclick: closeSheet })]);
}

/* ---------- project page ---------- */
function projectPage(main, id) {
  const box = h("div", { class: "pj-page" }, h("p", { class: "muted", text: "Loading the project…" }));
  main.append(h("div", {}, h("button", { class: "linkbtn", text: "← All projects", onclick: () => { S.projectId = null; render(); } })), box);
  let pr = null, editing = false, draft = null;
  const openItems = new Set();  // activities whose daily tasks are shown in the Plan (and highlighted below)
  const ui = { open: openItems, toggle: it => { openItems.has(it.id) ? openItems.delete(it.id) : openItems.add(it.id); draw(); }, assign: null };
  const load = async () => {
    try { pr = await api("GET", "/api/projects/" + id); draw(); }
    catch (e) { box.replaceChildren(h("p", { class: "bad-text", text: e.status === 404 ? "This project no longer exists." : e.message })); }
  };
  const draw = () => {
    const header = h("div", { class: "pj-head" },
      h("div", { class: "row between" }, h("div", {}, h("div", { class: "row" }, custLabel(pr.client), h("h2", { text: pr.name }),
        h("span", { class: "pill " + (PJ_STATUS_CLASS[pr.displayStatus] || ""), text: pr.displayStatus })),
        pr.description ? h("p", { class: "muted m0 pj-desc", text: pr.description }) : null),
        h("div", { class: "row" }, pr.canEdit && !editing ? h("button", { class: "btn", text: "Edit details", onclick: () => projectSheet(pr) }) : null,
          pr.canEdit && !editing ? h("button", { class: "btn primary", text: "Edit plan", onclick: () => { editing = true; draft = toDraft(pr); draw(); } }) : null,
          !editing ? h("button", { class: "btn", text: "Export to Excel", onclick: () => { window.location.href = "/api/projects/" + pr.id + "/export.xlsx"; } }) : null,
          pr.canDelete && !editing ? h("button", { class: "btn danger", text: "Delete", onclick: () => deleteProject(pr) }) : null)),
      h("div", { class: "tiles" }, tile("Project manager", pr.pmName || "—"), tile("Start", fmt(pr.startDate)), tile("Go-live", fmt(pr.goLive)),
        tile("Activities completed", pr.completed + " / " + pr.activities + " (" + pjPct(pr.progress) + ")", "ok"),
        tile("Overdue", pr.overdue, pr.overdue ? "bad" : ""), tile("Linked daily tasks", pr.linkedTasks)),
      pr.displayStatus === "At Risk" && pr.status !== "At Risk" ? h("div", { class: "note bad" }, h("b", { text: "At Risk: " }),
        pr.overdue + " activit" + (pr.overdue === 1 ? "y is" : "ies are") + " past their end date and not completed" + (pr.atRisk > pr.overdue ? ", or marked At Risk" : "") + ". The project status is " + pr.status + ".") : null);
    if (editing) return box.replaceChildren(header, planEditor());
    box.replaceChildren(header,
      h("div", { class: "panel pj-gantt-panel" }, h("div", { class: "row between" }, h("h3", { text: "Timeline" }), ganttLegend()), gantt(pr)),
      h("div", { class: "panel" }, h("div", { class: "row between" }, h("h3", { text: "Plan" }),
        pr.canEdit ? h("span", { class: "muted small", text: "Change an activity's status here; phases follow their activities." }) : null),
        readyNote(), planTable(pr, pr.canEdit ? setStatus : null, Object.assign(ui, { assign: pr.canEdit && pr.status !== "Completed" && pr.status !== "Cancelled" ? it => assignSheet(pr, it, load) : null }))),
      h("div", { class: "panel" }, h("div", { class: "row between" }, h("h3", { text: "Team on this project" }), h("span", { class: "muted small", text: "From the daily tasks linked to this project" })), projectTeam(pr)),
      h("div", { class: "panel" }, h("h3", { text: "Daily tasks linked to this project" }), linkedTasks(pr, openItems)),
      pr.holidays.length ? h("p", { class: "muted small m0", text: "Public holidays skipped in this plan: " + pr.holidays.map(x => fmt(x.date) + " " + x.name).join(" · ") }) :
        h("p", { class: "muted small m0", text: "No public holidays registered for this project yet. Add them in Edit plan → Public holidays." }));
  };

  // the lead / PM changes one activity's status straight from the plan
  const setStatus = async (it, status, ctl) => {
    if (ctl) ctl.disabled = true;
    try { await api("PUT", "/api/projects/" + pr.id + "/items/" + it.id, { status }); toast(it.name + ": " + status); await load(); reloadProjects(); }
    catch (e) { toast(e.message); if (ctl) ctl.disabled = false; draw(); }
  };
  // activities whose linked daily tasks are all completed, waiting for the PM to confirm
  const readyNote = () => {
    if (!pr.canEdit) return null;
    const ready = []; pr.phases.forEach(ph => ph.items.forEach(it => { if (it.tasks && it.tasksDone === it.tasks && it.status !== "Completed") ready.push(it); }));
    if (!ready.length) return null;
    return h("div", { class: "note ok pj-ready-note" }, h("b", { text: ready.length + (ready.length === 1 ? " activity has" : " activities have") + " all linked daily tasks completed: " }),
      ready.map(x => x.name).join(", ") + ". Check them and mark them Completed.");
  };

  /* ---------- editor ---------- */
  const toDraft = p => ({ phases: p.phases.map(ph => ({ id: ph.id, name: ph.name, deliverable: ph.deliverable, startDay: ph.startDay, endDay: ph.endDay,
    items: ph.items.map(it => ({ id: it.id, kind: it.kind, name: it.name, owner: it.owner, startDay: it.startDay, endDay: it.endDay, status: it.status, remarks: it.remarks })) })),
    holidays: p.holidays.map(x => ({ date: x.date, name: x.name })) });
  const planEditor = () => {
    const wrap = h("div", { class: "pj-editor" });
    const redraw = () => wrap.replaceChildren(...editorBody());
    const num = (obj, key, cls) => h("input", { type: "number", min: "1", max: "1000", step: "1", class: "pj-num " + (cls || ""), value: String(obj[key]),
      oninput: e => { obj[key] = Number(e.target.value); dates(); } });
    let dateCells = [];
    const dates = () => {
      const all = draft.phases.flatMap(ph => [ph, ...ph.items]);
      const cal = workdays(pr.startDate, draft.holidays.map(x => x.date), Math.max(1, ...all.map(x => x.endDay || 1)));
      dateCells.forEach(([obj, cell, wk]) => {
        const ok = obj.startDay >= 1 && obj.endDay >= obj.startDay;
        cell.textContent = ok ? fmt(cal[obj.startDay]) + " – " + fmt(cal[obj.endDay]) : "End is before start";
        cell.className = "mono small nowrap" + (ok ? " muted" : " bad-text");
        wk.textContent = ok ? weeksLabel(obj.startDay, obj.endDay) : "";
      });
    };
    const move = (arr, i, d) => { const j = i + d; if (j < 0 || j >= arr.length) return; [arr[i], arr[j]] = [arr[j], arr[i]]; redraw(); };
    const txt = (obj, key, ph, max) => h("input", { type: "text", value: obj[key] || "", placeholder: ph, maxlength: String(max || 200), oninput: e => { obj[key] = e.target.value; } });
    const editorBody = () => {
      dateCells = [];
      const rows = [];
      draft.phases.forEach((ph, pi) => {
        const wk = h("span", { class: "muted small" }), dc = h("span"); dateCells.push([ph, dc, wk]);
        rows.push(h("tr", { class: "pj-phase-row" },
          h("td", { class: "mono", text: String(pi + 1) }), h("td", { colspan: "2" }, txt(ph, "name", "Phase name")),
          h("td", {}, num(ph, "startDay")), h("td", {}, num(ph, "endDay")), h("td", {}, dc, h("div", {}, wk)),
          h("td", { colspan: "2" }, txt(ph, "deliverable", "Deliverable, e.g. SIT test result and sign-off", 300)),
          h("td", { class: "nowrap" }, h("button", { class: "btn small", type: "button", title: "Move phase up", text: "↑", onclick: () => move(draft.phases, pi, -1) }),
            h("button", { class: "btn small", type: "button", title: "Move phase down", text: "↓", onclick: () => move(draft.phases, pi, 1) }),
            h("button", { class: "btn small danger", type: "button", title: "Remove phase and its activities", text: "✕", onclick: () => { draft.phases.splice(pi, 1); redraw(); } }))));
        ph.items.forEach((it, ki) => {
          const wk2 = h("span", { class: "muted small" }), dc2 = h("span"); dateCells.push([it, dc2, wk2]);
          const kind = h("select", { onchange: e => { it.kind = e.target.value; } }, h("option", { value: "activity", text: "Activity" }), h("option", { value: "milestone", text: "◆ Milestone" }));
          kind.value = it.kind;
          const st = h("select", { onchange: e => { it.status = e.target.value; } }, ITEM_STATUSES.map(x => h("option", { value: x, text: x }))); st.value = it.status;
          rows.push(h("tr", {},
            h("td", { class: "mono muted", text: (pi + 1) + "." + (ki + 1) }), h("td", {}, txt(it, "name", "Activity")), h("td", {}, kind),
            h("td", {}, num(it, "startDay")), h("td", {}, num(it, "endDay")), h("td", {}, dc2, h("div", {}, wk2)),
            h("td", {}, txt(it, "owner", "Owner, e.g. Affin / Xmeg", 120)), h("td", {}, st, txt(it, "remarks", "Remarks", 1000)),
            h("td", { class: "nowrap" }, h("button", { class: "btn small", type: "button", text: "↑", title: "Move up", onclick: () => move(ph.items, ki, -1) }),
              h("button", { class: "btn small", type: "button", text: "↓", title: "Move down", onclick: () => move(ph.items, ki, 1) }),
              h("button", { class: "btn small danger", type: "button", text: "✕", title: "Remove", onclick: () => { ph.items.splice(ki, 1); redraw(); } }))));
        });
        rows.push(h("tr", { class: "pj-add-row" }, h("td", {}), h("td", { colspan: "8" },
          h("button", { class: "btn small", type: "button", text: "+ Activity in " + (ph.name || "this phase"), onclick: () => {
            const last = ph.items[ph.items.length - 1];
            ph.items.push({ kind: "activity", name: "", owner: last?.owner || "", startDay: last ? last.endDay : ph.startDay, endDay: last ? last.endDay : ph.startDay, status: "Not Started", remarks: "" });
            redraw(); } }),
          h("button", { class: "btn small", type: "button", text: "+ Milestone", onclick: () => { ph.items.push({ kind: "milestone", name: "", owner: "", startDay: ph.endDay, endDay: ph.endDay, status: "Not Started", remarks: "" }); redraw(); } }))));
      });
      const hol = h("div", { class: "pj-hol" }, h("h3", { text: "Public holidays (skipped when counting working days)" }),
        h("p", { class: "muted small m0", text: "Each project has its own list, because customers can be in other countries." }),
        draft.holidays.length ? h("div", { class: "pj-hol-list" }, draft.holidays.sort((a, b) => a.date.localeCompare(b.date)).map((x, i) =>
          h("div", { class: "row" }, h("input", { type: "date", value: x.date, oninput: e => { x.date = e.target.value; dates(); } }), txt(x, "name", "Holiday name", 100),
            h("button", { class: "btn small danger", type: "button", text: "✕", onclick: () => { draft.holidays.splice(i, 1); redraw(); } })))) : h("p", { class: "muted", text: "None yet." }),
        h("div", { class: "row" }, h("button", { class: "btn small", type: "button", text: "+ Holiday", onclick: () => { draft.holidays.push({ date: S.today, name: "" }); redraw(); } }),
          h("button", { class: "btn small", type: "button", text: "Add Malaysia (Selangor) holidays 2026–2027", onclick: () => {
            const have = new Set(draft.holidays.map(x => x.date)); MY_HOLIDAYS.forEach(([d, n]) => { if (!have.has(d)) draft.holidays.push({ date: d, name: n }); }); redraw(); } })));
      const err = h("p", { class: "bad-text m0", role: "alert" });
      const out = [
        h("p", { class: "muted m0", text: "Days are working days from the start date (" + fmt(pr.startDate) + " is day 1), like the Excel timeline. Weekends and this project's holidays are skipped. Dates update as you type." }),
        h("div", { class: "tscroll" }, h("table", { class: "pj-edit-table" },
          h("thead", {}, h("tr", {}, ["No", "Phase / activity", "Type", "Start day", "End day", "Dates", "Owner / deliverable", "Status / remarks", ""].map(c => h("th", { text: c })))),
          h("tbody", {}, rows))),
        h("div", { class: "row" }, h("button", { class: "btn", type: "button", text: "+ Phase", onclick: () => {
          const last = draft.phases[draft.phases.length - 1];
          draft.phases.push({ name: "", deliverable: "", startDay: last ? last.endDay + 1 : 1, endDay: last ? last.endDay + 5 : 5, items: [] }); redraw(); } })),
        hol, err,
        h("div", { class: "row pj-save" }, h("button", { class: "btn primary", text: "Save plan", onclick: async e => {
          err.textContent = ""; e.target.disabled = true;
          try { await api("PUT", "/api/projects/" + pr.id + "/plan", draft); toast("Plan saved"); editing = false; await reloadProjects(); await load(); }
          catch (x) { err.textContent = x.message; e.target.disabled = false; }
        } }), h("button", { class: "btn", text: "Cancel", onclick: () => { editing = false; draw(); } }))];
      setTimeout(dates, 0);
      return out;
    };
    redraw();
    return wrap;
  };
  load();
}

async function deleteProject(pr) {
  const go = h("button", { class: "btn danger", text: "Delete project", onclick: async () => {
    try { await api("DELETE", "/api/projects/" + pr.id); closeSheet(); toast("Project deleted"); S.projectId = null; await reloadProjects(); render(); }
    catch (e) { toast(e.message); }
  } });
  openSheet("Delete " + pr.name, [h("div", { class: "note bad", text: "This deletes the project, its plan and holidays. The " + pr.linkedTasks + " daily task" + (pr.linkedTasks === 1 ? "" : "s") +
    " linked to it stay in the tracker; they just won't show a project any more." })], [go, h("button", { class: "btn right", text: "Cancel", onclick: closeSheet })]);
}

/* ---------- read-only plan and linked tasks ---------- */
function planTable(pr, setStatus, ui) {
  // ui: {open: Set of item ids whose daily tasks are shown, toggle(it), assign(it)}
  ui = ui || { open: new Set(), toggle() { }, assign: null };
  const rows = [];
  // status: a dropdown for the lead / project manager, a pill for everyone else
  const statusCell = (it, isPh) => {
    const od = it.overdue ? h("span", { class: "pill bad pj-od", text: "Overdue" }) : null;
    if (isPh || !setStatus) return h("td", {}, h("div", { class: "pj-status-cell" }, h("span", { class: "pill " + (ITEM_STATUS_CLASS[it.status] || ""), text: it.status }), od));
    const sel = h("select", { class: "pj-status-sel " + (ITEM_STATUS_CLASS[it.status] || ""), "aria-label": "Status of " + it.name, onchange: () => setStatus(it, sel.value, sel) },
      ["Not Started", "In Progress", "Completed", "At Risk"].map(v => h("option", { value: v, text: v, selected: v === it.status })));
    return h("td", {}, h("div", { class: "pj-status-cell" }, sel, od));
  };
  // linked daily tasks: "1 / 2 tasks done" opens them under the row; all done → offer to mark the activity completed
  const tasksCell = it => {
    const bits = [];
    if (it.remarks) bits.push(h("div", { class: "small", text: it.remarks }));
    if (it.tasks) {
      const all = it.tasksDone === it.tasks, open = ui.open.has(it.id);
      bits.push(h("button", { class: "linkbtn small pj-tcount " + (all ? "ok-text" : ""), "aria-expanded": open ? "true" : "false",
        title: "Show these daily tasks and their latest progress",
        text: it.tasksDone + " / " + it.tasks + " task" + (it.tasks === 1 ? "" : "s") + " done " + (open ? "▴" : "▾"), onclick: () => ui.toggle(it) }));
      if (all && it.status !== "Completed" && setStatus)
        bits.push(h("button", { class: "btn small pj-markdone", text: "✓ Mark completed", onclick: e => setStatus(it, "Completed", e.target) }));
    }
    if (ui.assign && it.status !== "Completed")
      bits.push(h("button", { class: "linkbtn small pj-assign", text: "+ Assign", "aria-label": "Assign " + it.name + " to an engineer", title: "Create a daily task for an engineer on this activity", onclick: () => ui.assign(it) }));
    return h("td", {}, h("div", { class: "pj-tcell" }, bits));
  };
  // the daily tasks of one activity, with their latest progress line
  const taskRows = it => h("tr", { class: "pj-sub" }, h("td"), h("td", { colspan: "8" },
    h("table", { class: "pj-subtable" }, h("tbody", {}, pr.tasks.filter(t => t.itemId === it.id)
      .sort((a, b) => (!!a.actualDate - !!b.actualDate) || (a.target || "9999").localeCompare(b.target || "9999"))
      .map(t => h("tr", {},
        h("td", { class: "mono muted nowrap", text: "#" + String(t.no).padStart(3, "0") }),
        h("td", { class: "nowrap" }, h("b", { text: t.lead.map(personName).join(" / ") }), t.support.length ? h("span", { class: "muted", text: " + " + t.support.map(personName).join(", ") }) : null),
        h("td", { class: "mono nowrap", text: fmt(t.target) }),
        h("td", {}, h("span", { class: "pill " + (STATUS_CLASS[t.status] || ""), text: t.status })),
        h("td", { class: "pj-note", text: t.lastNote || "No progress written yet." }),
        h("td", { class: "num" }, h("button", { class: "btn small", text: "Open", onclick: () => { const x = S.tasks.find(y => y.id === t.id); if (x) taskSheet(x); } }))))))));
  pr.phases.forEach((ph, pi) => {
    const r = (no, it, type, isPh) => h("tr", { class: (isPh ? "pj-phase-row" : "") + (!isPh && it.tasks && it.tasksDone === it.tasks && it.status !== "Completed" ? " pj-ready" : "") + (ui.open.has(it.id) ? " pj-open" : "") },
      h("td", { class: "mono" + (isPh ? "" : " muted"), text: no }), h("td", { text: (type === "Milestone" ? "◆ " : "") + it.name }), h("td", { class: "muted small", text: type }),
      h("td", { class: "small nowrap", text: weeksLabel(it.startDay, it.endDay) }), h("td", { class: "mono nowrap", text: fmt(it.startDate) }), h("td", { class: "mono nowrap", text: fmt(it.endDate) }),
      h("td", { class: "small", text: isPh ? it.deliverable : it.owner }),
      statusCell(it, isPh),
      isPh ? h("td", { class: "small", text: it.remarks || "" }) : tasksCell(it));
    rows.push(r(String(pi + 1), ph, "Phase", true));
    ph.items.forEach((it, ki) => {
      rows.push(r((pi + 1) + "." + (ki + 1), it, it.kind === "milestone" ? "Milestone" : "Activity", false));
      if (ui.open.has(it.id) && it.tasks) rows.push(taskRows(it));
    });
  });
  if (!rows.length) return h("p", { class: "muted", text: "This plan is empty." + (pr.canEdit ? " Use Edit plan to add phases and activities." : "") });
  return h("div", { class: "tscroll" }, h("table", { class: "pj-plan-table" }, h("thead", {}, h("tr", {}, ["No", "Phase / activity", "Type", "Weeks", "Start", "End", "Owner / deliverable", "Status", "Remarks / daily tasks"].map(c => h("th", { text: c })))), h("tbody", {}, rows)));
}
function linkedTasks(pr, hl) {
  hl = hl || new Set();
  if (!pr.tasks.length) return h("p", { class: "muted m0", text: "No daily tasks are linked yet. When someone adds a task, they pick this project and its activity on the task form." });
  const names = {}; pr.phases.forEach(ph => { names[ph.id] = ph.name; ph.items.forEach(it => { names[it.id] = it.name; }); });
  // open tasks first, nearest target date first (no target at the end of them); completed tasks at the bottom
  const list = pr.tasks.slice().sort((a, b) => (!!a.actualDate - !!b.actualDate) || (a.target || "9999").localeCompare(b.target || "9999") || a.no - b.no);
  const A = S.pjTaskPage && S.pjTaskPage.id === pr.id ? S.pjTaskPage : (S.pjTaskPage = { id: pr.id, page: 1, size: 10 });
  const box = h("div");
  // opening an activity's tasks in the Plan highlights them here, on the page where the first one is
  const hlKey = [...hl].join(",");
  if (hlKey && A.hl !== hlKey) { const i = list.findIndex(t => hl.has(t.itemId)); if (i >= 0) A.page = Math.floor(i / A.size) + 1; }
  A.hl = hlKey;
  const draw = () => {
    const pages = Math.max(1, Math.ceil(list.length / A.size));
    A.page = Math.min(Math.max(1, A.page), pages);
    const rows = list.slice((A.page - 1) * A.size, A.page * A.size);
    box.replaceChildren(...[h("div", { class: "tscroll" }, h("table", {}, h("thead", {}, h("tr", {}, ["No", "Task", "Activity", "Lead", "Target", "Completed", "Status"].map(c => h("th", { text: c })))),
      h("tbody", {}, rows.map(t => h("tr", { class: "click" + (t.actualDate ? " pj-task-done" : "") + (hl.has(t.itemId) ? " pj-hl" : ""), onclick: () => { const x = S.tasks.find(y => y.id === t.id); if (x) taskSheet(x); } },
        h("td", { class: "mono muted", text: "#" + String(t.no).padStart(3, "0") }), h("td", { text: t.title }), h("td", { class: "small", text: names[t.itemId] || "—" }),
        h("td", { class: "nowrap", text: t.lead.map(personName).join(" / ") }),
        h("td", { class: "mono nowrap", text: fmt(t.target) }), h("td", { class: "mono nowrap", text: fmt(t.actualDate) }),
        h("td", {}, h("span", { class: "pill " + (STATUS_CLASS[t.status] || ""), text: t.status }))))))),
      list.length > 10 ? pager(A, list.length, pages, { sizes: [10, 25, 50], label: "Linked task pages", redraw: draw }) : null].filter(Boolean));
  };
  draw();
  return box;
}

/* ---------- Gantt timeline (SVG, like the Excel timeline: one column per working day) ---------- */
function ganttLegend() {
  return h("div", { class: "help-legend pj-legend" }, h("span", {}, h("i", { class: "sw", style: "background:#1F7A99" }), "Phase"), h("span", {}, h("i", { class: "sw", style: "background:#A9CCD8" }), "Activity"),
    h("span", {}, "◆ Milestone"), h("span", {}, h("i", { class: "ln", style: "border-top:2px solid #C00000" }), "Today"), h("span", {}, h("i", { class: "sw pj-sw-od" }), "Overdue"));
}
function gantt(pr) {
  // two SVGs side by side: the phase / activity names stay put, the day columns scroll left and right
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.append(e); return e; };
  const txt = (s, attrs, parent) => { const e = el("text", attrs, parent); e.textContent = s; return e; };
  const rows = [];
  pr.phases.forEach((ph, pi) => { rows.push({ it: ph, ph: pi, phase: true, no: String(pi + 1) }); ph.items.forEach((it, ki) => rows.push({ it, ph: pi, phase: false, no: (pi + 1) + "." + (ki + 1) })); });
  const ndays = Math.max(5, Math.ceil(Math.max(1, ...rows.map(r => r.it.endDay)) / 5) * 5);
  const cal = pr.calendar.length >= ndays ? pr.calendar : workdays(pr.startDate, pr.holidays.map(x => x.date), ndays).slice(1);
  const LW = 330, CW = 24, RH = 22, TOP = 46, W = ndays * CW + 10, H = TOP + rows.length * RH + 8;
  const left = el("svg", { class: "pj-gantt", viewBox: "0 0 " + LW + " " + H, width: LW, height: H, role: "img", "aria-label": "Phases and activities" });
  const svg = el("svg", { class: "pj-gantt", viewBox: "0 0 " + W + " " + H, width: W, height: H, role: "img", "aria-label": "Project timeline" });
  // header: week labels, day numbers, dates
  let todayX = null;
  for (let d = 1; d <= ndays; d++) {
    const x = (d - 1) * CW, date = cal[d - 1];
    if ((d - 1) % 5 === 0) {
      el("rect", { x, y: 0, width: CW * 5, height: 16, class: "pj-wk" + (((d - 1) / 5) % 2 ? " alt" : "") }, svg);
      const mon = date ? " · " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(date.slice(5, 7)) - 1] + " " + date.slice(2, 4) : "";
      txt("Week " + ((d - 1) / 5 + 1) + mon, { x: x + CW * 2.5, y: 12, class: "pj-wk-t", "text-anchor": "middle" }, svg);
    }
    const isToday = date === pr.today;
    if (isToday) { todayX = x; el("rect", { x, y: 16, width: CW, height: H - 16, class: "pj-today-col" }, svg); }
    txt(String(d), { x: x + CW / 2, y: 29, class: "pj-day" + (isToday ? " today" : ""), "text-anchor": "middle" }, svg);
    if (date) { const t = txt(date.slice(8, 10), { x: x + CW / 2, y: 41, class: "pj-date" + (isToday ? " today" : ""), "text-anchor": "middle" }, svg); el("title", {}, t).textContent = fmt(date) + (isToday ? " (today)" : ""); }
    if ((d - 1) % 5 === 0) el("line", { x1: x, x2: x, y1: 16, y2: H, class: "pj-wkline" }, svg);
  }
  txt("Phase / activity", { x: 8, y: 41, class: "pj-head-t" }, left);
  rows.forEach((r, i) => {
    const y = TOP + i * RH, it = r.it, [dark, light] = PJ_COLOURS[r.ph % PJ_COLOURS.length];
    for (const [s, w] of [[left, LW], [svg, W]]) {
      if (r.phase) el("rect", { x: 0, y, width: w, height: RH, class: "pj-phase-bg" }, s);
      el("line", { x1: 0, x2: w, y1: y + RH, y2: y + RH, class: "pj-row" }, s);
    }
    const base = (r.phase ? r.no + "  " : "    " + r.no + "  ") + (it.kind === "milestone" ? "◆ " : ""), max = (it.overdue ? 34 : 44) + (r.phase ? 0 : 4);
    const shown = (base + it.name).length > max ? (base + it.name).slice(0, max) + "…" : base + it.name;
    const label = txt(shown, { x: 8, y: y + 15, class: "pj-label" + (r.phase ? " phase" : "") }, left);
    if (it.overdue) { const od = el("tspan", { class: "pj-od-t" }, label); od.textContent = " (Overdue)"; }
    el("title", {}, label).textContent = it.name + "\n" + fmt(it.startDate) + " – " + fmt(it.endDate) + " · " + it.status + (it.overdue ? " · OVERDUE" : "");
    const x1 = (it.startDay - 1) * CW, x2 = it.endDay * CW;
    const g = el("g", { class: "pj-bar-g" }, svg);
    el("title", {}, g).textContent = it.name + "\n" + fmt(it.startDate) + " – " + fmt(it.endDate) + " · " + it.status + (it.overdue ? " · OVERDUE" : "");
    if (it.kind === "milestone") {
      const cx = (it.endDay - 0.5) * CW, cy = y + RH / 2;
      el("path", { d: `M${cx},${cy - 7} L${cx + 7},${cy} L${cx},${cy + 7} L${cx - 7},${cy} Z`, class: "pj-ms" + (it.status === "Completed" ? " done" : "") + (it.overdue ? " od" : "") }, g);
    } else {
      el("rect", { x: x1 + 1, y: y + (r.phase ? 4 : 6), width: Math.max(4, x2 - x1 - 2), height: r.phase ? RH - 8 : RH - 12, rx: 3, fill: r.phase ? dark : light, class: "pj-bar" + (it.overdue ? " od" : "") }, g);
      if (it.status === "Completed" && !r.phase) txt("✓", { x: x2 - 9, y: y + 15, class: "pj-check" }, g);
    }
  });
  const scroller = h("div", { class: "pj-gantt-scroll" }, svg);
  // open on the current week (a week before today), so the work in hand is in view
  if (todayX !== null) requestAnimationFrame(() => { scroller.scrollLeft = Math.max(0, todayX - CW * 5); });
  return h("div", { class: "pj-gantt-wrap" }, h("div", { class: "pj-gantt-names" }, left), scroller);
}

/* ---------- team load (from the daily tasks: lead and support engineers, open tasks) ---------- */
const LOAD_LEVELS = [[7, "bad", "overloaded"], [4, "warn", "busy"], [1, "ok", ""], [0, "", ""]];
function loadLevel(n) { return LOAD_LEVELS.find(([min]) => n >= min); }
function isoAdd(iso, days) { const d = new Date(iso + "T00:00:00"); d.setDate(d.getDate() + days); return isoLocal(d); }
function onTask(t, key) { return t.lead.includes(key) || t.support.includes(key); }
function openTasksOf(key) { return S.tasks.filter(t => !t.actualDate && onTask(t, key)); }
// the days an open task occupies: start date (today if none) to target date; overdue or no target → until today
function taskSpan(t) {
  const start = t.startDate || S.today, end = t.effTarget && t.effTarget > S.today ? t.effTarget : S.today;
  return [start < end ? start : end, end];
}
function loadPill(n) {
  const [, cls, word] = loadLevel(n);
  return h("span", { class: "pill " + cls, title: n + " open task" + (n === 1 ? "" : "s") + " in total (every project, tickets and other work)", text: n + (word ? " · " + word : "") });
}
function loadSummary(key) {
  const open = openTasksOf(key), soon = isoAdd(S.today, 7);
  const thisWeek = open.filter(t => t.effTarget && t.effTarget >= S.today && t.effTarget <= soon).length;
  return personName(key) + " already has " + open.length + " open task" + (open.length === 1 ? "" : "s") + (thisWeek ? ", " + thisWeek + " due in the next 7 days" : "") + ".";
}

/* 2a. Team on this project */
function projectTeam(pr) {
  const keys = new Set();
  pr.tasks.forEach(t => [...t.lead, ...t.support].forEach(k => { if (!isOutside(k)) keys.add(k); }));
  if (!keys.size) return h("p", { class: "muted m0", text: "No one has a task on this project yet." + (pr.canEdit ? " Use + Assign on an activity in the Plan." : "") });
  const names = {}; pr.phases.forEach(ph => { names[ph.id] = ph.name; ph.items.forEach(it => { names[it.id] = it.name; }); });
  const soon = isoAdd(S.today, 14);
  const rows = [...keys].map(k => {
    const mine = pr.tasks.filter(t => t.lead.includes(k) || t.support.includes(k)), open = mine.filter(t => !t.actualDate);
    return { k, open: open.length, overdue: open.filter(t => t.target && t.target < S.today).length,
      soon: open.filter(t => t.target && t.target >= S.today && t.target <= soon).length, done: mine.length - open.length,
      on: [...new Set(open.map(t => names[t.itemId]).filter(Boolean))], all: openTasksOf(k).length };
  }).sort((a, b) => b.open - a.open || personName(a.k).localeCompare(personName(b.k)));
  return h("div", { class: "tscroll" }, h("table", {},
    h("thead", {}, h("tr", {}, [["Engineer"], ["Open", "num"], ["Overdue", "num"], ["Due in 2 weeks", "num"], ["Done", "num"], ["Working on"], ["All open tasks", "num"]].map(([c, cl]) => h("th", { class: cl || "", text: c })))),
    h("tbody", {}, rows.map(r => h("tr", {},
      h("td", { class: "nowrap" }, h("b", { text: personName(r.k) })), h("td", { class: "num mono", text: r.open }),
      h("td", { class: "num mono" + (r.overdue ? " bad-text" : ""), text: r.overdue }), h("td", { class: "num mono", text: r.soon }), h("td", { class: "num mono", text: r.done }),
      h("td", { class: "small", title: r.on.join("\n"), text: (r.on.slice(0, 4).join(" · ") + (r.on.length > 4 ? " · + " + (r.on.length - 4) + " more" : "")) || "—" }), h("td", { class: "num" }, loadPill(r.all)))))));
}

/* 2b. Team load: engineers × this week and the next 7 */
function teamLoad() {
  const monday = (() => { const d = new Date(S.today + "T00:00:00"); d.setDate(d.getDate() - (d.getDay() + 6) % 7); return isoLocal(d); })();
  const weeks = Array.from({ length: 8 }, (_, i) => { const a = isoAdd(monday, i * 7); return [a, isoAdd(a, 6)]; });
  const ppl = people().filter(p => p.active).sort((a, b) => a.name.localeCompare(b.name));
  const open = S.tasks.filter(t => !t.actualDate);
  const cell = (k, [a, b]) => open.filter(t => onTask(t, k)).filter(t => { const [s, e] = taskSpan(t); return s <= b && e >= a; });
  const detail = h("div");
  let picked = null;
  const grid = h("div", { class: "pj-load", style: "grid-template-columns:minmax(110px,160px) repeat(" + weeks.length + ",minmax(48px,1fr))" });
  const draw = () => {
    grid.replaceChildren(h("div", { class: "h" }), ...weeks.map(([a], i) => h("div", { class: "h", text: (i ? "" : "Week of ") + a.slice(8, 10) + "/" + a.slice(5, 7) })));
    ppl.forEach(p => {
      grid.append(h("div", { class: "n", text: p.name }));
      weeks.forEach((w, i) => {
        const list = cell(p.key, w), [, cls] = loadLevel(list.length), on = picked && picked.k === p.key && picked.i === i;
        grid.append(h("button", { class: "c l-" + (cls || "none") + (on ? " on" : ""), type: "button", text: String(list.length),
          "aria-label": p.name + ", week of " + fmt(w[0]) + ": " + list.length + " open tasks", "aria-pressed": on ? "true" : "false",
          onclick: () => { picked = on ? null : { k: p.key, i }; draw(); } }));
      });
    });
    if (!picked) return detail.replaceChildren();
    const w = weeks[picked.i], list = cell(picked.k, w).sort((a, b) => (a.effTarget || "9999").localeCompare(b.effTarget || "9999"));
    detail.replaceChildren(h("div", { class: "tscroll" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", { colspan: "5", text: personName(picked.k) + " · week of " + fmt(w[0]) + " · " + list.length + " task" + (list.length === 1 ? "" : "s") }))),
      h("tbody", {}, list.length ? list.map(t => h("tr", { class: "click", onclick: () => taskSheet(t) },
        h("td", { class: "mono muted", text: "#" + String(t.no).padStart(3, "0") }),
        h("td", {}, h("div", { text: t.projectName ? t.projectName + (t.projectItemName ? " › " + t.projectItemName : "") : t.title }), t.projectName && t.title !== t.projectName ? h("div", { class: "muted small", text: t.title }) : null),
        h("td", { class: "mono nowrap", text: fmt(t.effTarget) }), h("td", {}, h("span", { class: "pill " + (STATUS_CLASS[t.status] || ""), text: t.status })),
        h("td", { class: "muted small", text: (t.customer || "") + (t.projectName ? "" : " (no project)") }))) :
        h("tr", {}, h("td", { colspan: "5", class: "muted", text: "No open tasks that week." }))))));
  };
  draw();
  return h("div", { class: "panel" },
    h("div", { class: "row between" }, h("h3", { text: "Team load" }),
      h("div", { class: "pj-load-legend" }, h("span", {}, h("i", { class: "l-none" }), "0"), h("span", {}, h("i", { class: "l-ok" }), "1–3 tasks"),
        h("span", {}, h("i", { class: "l-warn" }), "4–6"), h("span", {}, h("i", { class: "l-bad" }), "7 or more"))),
    h("p", { class: "muted small m0", text: "Open daily tasks each engineer (lead or support) has running in each week, from start date to target date, on projects and off them. Overdue tasks count until they are completed. Click a number to see the tasks." }),
    h("div", { class: "tscroll pj-load-wrap" }, grid), detail);
}

/* 1. Assign: the lead or the project's PM creates a daily task for an engineer on one activity */
function assignSheet(pr, it, after) {
  const tm = team(), cat = tm.categories.find(c => /project/i.test(c)) || tm.categories[0];
  const info = h("div", { class: "note small", text: "Pick the lead engineer." });
  const fSup = peopleToggles("as-sup", [], false, true);
  const fLead = peopleToggles("as-lead", [], false, false, leads => { fSup.block(leads); info.textContent = leads.length ? leads.map(loadSummary).join(" ") : "Pick the lead engineer."; });
  const fNote = h("textarea", { id: "as-note", maxlength: "2000", placeholder: "What should they do? e.g. Run SIT cases 1–12 with the customer" });
  const fUrg = h("select", { id: "as-urg" }, tm.urgencies.map(u => h("option", { value: u, text: u }))); fUrg.value = "Medium";
  const go = h("button", { class: "btn primary", text: "Assign", onclick: async () => {
    const lead = fLead.value();
    if (!lead.length) return toast("Pick the lead engineer.");
    go.disabled = true;
    try {
      await api("POST", "/api/teams/" + S.teamId + "/tasks", { category: cat, title: pr.name, urgency: fUrg.value, percent: 0, progress: fNote.value,
        lead, support: fSup.value(), startDate: S.today, projectId: pr.id, projectItemId: it.id });
      closeSheet(); toast("Assigned to " + lead.map(personName).join(" / ")); await reloadTeam(); after && after();
    } catch (e) { toast(e.message); go.disabled = false; }
  } });
  openSheet("Assign: " + it.name, [
    h("p", { class: "muted small m0", text: "Creates a daily task for the engineer, linked to this activity. It shows on their Tracker straight away; they update its progress as usual." }),
    h("div", { class: "f2" }, h("label", { class: "field" }, h("span", { text: "Project" }), h("input", { type: "text", value: (pr.client ? pr.client + " · " : "") + pr.name, disabled: true })),
      h("label", { class: "field" }, h("span", { text: "Target date (from the plan)" }), h("input", { type: "text", value: fmt(it.endDate), disabled: true }))),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Lead engineer" }), fLead),
    h("div", { class: "field" }, h("span", { class: "lbl", text: "Support engineer" }), fSup),
    h("div", { class: "f2" }, h("label", { class: "field" }, h("span", { text: "Category" }), h("input", { type: "text", value: cat, disabled: true })), h("label", { class: "field" }, h("span", { text: "Urgency" }), fUrg)),
    h("label", { class: "field" }, h("span", { text: "Note for the engineer (first line of Task progress)" }), fNote),
    info], [go, h("button", { class: "btn", text: "Cancel", onclick: closeSheet })]);
}
