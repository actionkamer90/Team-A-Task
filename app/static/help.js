"use strict";
/* Help tab. The user guide is for everyone (also from the log-in page).
   Data model, Architecture and Setup guide are in help_admin.js, which only administrators can load.
   Loaded before app.js; uses its helpers (h, S, store, render) only when called. */

// [id, label, admin only]. Admin sections live in help_admin.js, which the server sends only to administrators.
const HELP_SECTIONS = [["guide", "User guide", false], ["model", "Data model", true], ["arch", "Architecture", true], ["readme", "Setup guide (README)", true]];
let adminHelpLoading = null;
function loadAdminHelp() {
  if (typeof helpModel === "function") return Promise.resolve();
  if (!adminHelpLoading) adminHelpLoading = new Promise((ok, fail) => {
    const s = document.createElement("script"); s.src = "/api/help/admin.js";
    s.onload = () => ok(); s.onerror = () => { adminHelpLoading = null; s.remove(); fail(new Error("Couldn't load this section. Only administrators can open it.")); };
    document.head.append(s);
  });
  return adminHelpLoading;
}

function helpView(main, standalone) {
  const isAdmin = !standalone && !!S.me?.user?.isAdmin;
  const sections = HELP_SECTIONS.filter(s => !s[2] || isAdmin);
  let section = store.get("tt.help") || "guide";
  if (!sections.some(s => s[0] === section)) section = "guide";
  const body = h("div", { class: "help-body" });
  const tabs = sections.length > 1 ? h("div", { class: "seg help-seg", role: "tablist", "aria-label": "Help sections" }) : null;
  const show = id => {
    section = id; store.set("tt.help", id);
    tabs?.querySelectorAll("button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.id === id)));
    if (id === "guide") return body.replaceChildren(helpGuide(isAdmin));
    body.replaceChildren(h("p", { class: "muted", text: "Loading…" }));
    loadAdminHelp().then(() => { if (section === id) body.replaceChildren(id === "model" ? helpModel() : id === "arch" ? helpArch() : helpReadme()); })
      .catch(e => { if (section === id) body.replaceChildren(h("p", { class: "bad-text", text: e.message })); });
  };
  if (tabs) sections.forEach(([id, label, adm]) => tabs.append(h("button", { type: "button", role: "tab", "data-id": id, onclick: () => show(id) }, label, adm ? h("span", { class: "help-admin-mark", text: "admin" }) : null)));
  main.append(h("div", { class: "row between" }, h("h2", { text: standalone ? "User guide" : "Help" }),
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
function helpGuide(isAdmin) {
  const sec = (id, title, ...kids) => h("section", { class: "help-sec", id: "help-" + id }, h("h3", { text: title }), ...kids);
  const list = items => h("ul", {}, items.map(i => h("li", {}, i)));
  const steps = items => h("ol", {}, items.map(i => h("li", {}, i)));
  const toc = [["start", "Getting started"], ["roles", "Who can do what"], ["tracker", "Tracker tab"], ["status", "What each status means"],
    ["update", "Adding and updating tasks"], ["approve", "Approvals and My Requests"], ["archive", "Archive"], ["summary", "Summary"],
    ["projects", "Projects"], ["kpi", "KPI Dashboard"], ["team", "Team & Invites"], ["admin", "Clients and All Teams"], ["export", "Export to Excel"]];
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
          [B("Project Manager"), "Everything a member can do, plus create projects and run the plans of the projects they manage. The team lead makes someone a Project Manager on Team & Invites."],
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
          [h("span", { class: "pill early", text: "Completed Early" }), "Actual (completed) date is before the target date."],
          [h("span", { class: "pill ok", text: "Completed On Time" }), "Actual date is the target date."],
          [h("span", { class: "pill warn", text: "Completed Late" }), "Actual date is after the target date."],
          [h("span", { class: "pill ok", text: "Completed" }), "Finished, but the task never had a target date."],
        ]),
        P("A date shown with ", h("span", { class: "pending", text: "awaiting lead" }), " is a target proposed by a member that the team lead hasn't approved yet.")),
      sec("update", "Adding and updating tasks",
        steps([
          ["Click ", B("+ New task"), ". Fill in the main task, category, urgency, customer, Lead and Support engineers, start date and target date."],
          ["Write progress in ", B("Task progress"), ", one update per line. ", B("Add update"), " starts a new line at the top. When you save, every new or changed line is signed automatically at the start, for example ", C("[11/11/2026 10:33 Khaidir] Log collected"), ". Lines you didn't touch keep their original signature."],
          ["Move the percentage as work goes on."],
          ["When the work is done, set the ", B("Actual date"), ". The task moves to the Archive after the number of days your team lead has set (2 unless changed)."],
        ]),
        list([
          ["Only the task's Lead Engineers and the team lead can change it. Support engineers can view it."],
          [B("Support engineer from outside the team: "), "type their name in the box under Support engineer and press Add (another team, a vendor, the customer). They show on the task but not in the Engineer filter or the KPI. Someone picked as Lead engineer is greyed out under Support."],
          ["Changing the target date, or entering a completed date earlier than today, sends a request to the team lead. Other changes save immediately. If the target had already passed, the team lead is warned that an earlier completed date would turn a late task into an on-time one."],
          ["Once a task is in the Archive, only the team lead can change it."],
          ["The task's ", B("History"), " lists every change: who, when, and what it was before."],
        ])),
      sec("approve", "Approvals and My Requests",
        list([
          [B("Approvals "), "(team leads): proposed target dates and backdated completions wait here. Approve, or reject with a reason."],
          [B("My Requests "), "(members): the requests you sent in the last 30 days and what the lead decided."],
        ])),
      sec("archive", "Archive",
        P("Finished tasks appear here a set number of days after their actual date: 2 unless your team lead changes it in Team & Invites → Team settings (0 to 90 days; 0 means as soon as the task is completed). Search, filter and sort work the same as on the Tracker; by default the most recently completed tasks come first. Open a task to read its history."),
        P(B("Completed: "), "show only tasks completed in a period: this week or last week (Monday to Sunday), this month, last month, the last 3 months, this year, last year, or your own dates with Custom dates. The count at the top shows how many tasks match."),
        P(B("Pages: "), "the Archive shows 50 tasks a page. Use the page numbers, Previous and Next under the table, or choose 25 or 100 per page. Changing a filter or the sort goes back to page 1. Export to Excel still downloads the whole Archive.")),
      sec("projects", "Projects",
        P("A project groups the work for one client: its phases (for example Requirement Study, SIT, UAT, Production Preparation, Go-Live), the activities and milestones (◆) in each phase, who owns them and their status. The team lead or the project's Project Manager registers it and keeps the plan up to date."),
        list([
          [B("New project: "), "client, name, description, project manager, start date and status. Start from the implementation template, which adds the usual phases and activities with typical durations, or from a blank plan."],
          [B("Edit plan: "), "dates are counted in working days from the start date, like the Excel timeline: day 1 is the start date, weekends and the project's own public holidays are skipped. Change a start or end day and the dates update. Each project keeps its own holiday list, because customers can be overseas."],
          [B("Status: "), "each activity is Not Started, In Progress, Completed or At Risk. An activity past its end date and not completed is marked Overdue. A phase follows its activities, and the whole project shows At Risk when anything in it is overdue or At Risk. The lead or Project Manager changes an activity's status straight from the Status column of the Plan, without opening Edit plan."],
          [B("Linked tasks done: "), "the Plan shows how many of an activity's linked daily tasks are completed (e.g. 2 / 2 linked tasks done). When all of them are, the row turns green and the Project Manager sees a ✓ Mark completed button and a note at the top of the Plan to check and close the activity."],
          [B("Timeline: "), "a Gantt chart with one column per working day, phase colours, ◆ for milestones and today's column in red. Hover over a bar for its dates and status."],
          [B("Your daily tasks: "), "when a task belongs to a project, pick the project and its phase or activity on the task form; the client fills in by itself. Write the details in the task as usual. The task then shows under the project, and the Tracker can be filtered by project."],
          [B("Export to Excel: "), "the plan in the same layout as the team's timeline workbook, with the Gantt colours and a Holidays sheet. Values only, no formulas."],
        ])),
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
          [B("Customer icons: "), "every customer shows a coloured badge with its initials. In ", B("Team settings"), " you can upload a logo for a customer instead; it is shrunk to a small icon and shown beside the customer's name everywhere."],
        ])),
      sec("admin", "Clients and All Teams",
        P(B("Clients"), " (team leads and administrators): every client with its short name (shown on tasks, e.g. RHB) and full name (e.g. RHB Bank Bhd). Add a client, tick the teams that work with it, and upload its logo once for all of those teams. Team leads see and change their own teams only. Unticking a client's last team asks before removing it. Tasks that already name a client keep it."),
        P(B("All Teams"), ": create teams, open any team, delete a team (type its name to confirm; the tracker saves a full backup of the database first), and manage administrators. To start a new team: create it, add its lead on Team & Invites, and send the lead an invite link. The lead invites the rest.")),
      sec("export", "Export to Excel",
        P(B("Export to Excel"), " on the Tracker and Archive downloads an .xlsx file with the Daily Task Tracker and Archive sheets. Team leads also get the KPI Scorecard and Lead Tasks by Category sheets for the KPI period."),
        P("Questions the guide doesn't answer? Ask your team lead or the tracker's administrator."),
        isAdmin ? P("As an administrator you also see the ", B("Data model"), ", ", B("Architecture"), " and ", B("Setup guide (README)"), " sections at the top of Help.") : null)));
}

