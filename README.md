# Team Task Tracker

A self-hosted daily task tracker for multiple teams. It replaces the Excel template
`Team_A_Daily_Task_Tracker_Template_2026.xlsm` and runs on your own server with Docker.

## Features

- **Logins with invite links.** Nobody can sign up on their own. A team lead creates a one-time
  invite link (valid 7 days) and sends it privately. The person picks a login and password.
  Forgotten passwords are handled the same way, with a reset link from the lead.
- **Roles, enforced by the server**
  | Role | Can do |
  |---|---|
  | Member | See their team's tasks; add tasks they lead; update the details of tasks where they are a **Lead Engineer** (saved straight away). A new or changed **target date**, and a **completion dated before today** (backdated actual date), wait for the team lead's **approval**; they follow these under *My Requests*. Support engineers see a task but can't change it. |
  | Team lead | Change any task in their team directly; **approve or reject** proposed target dates and backdated completions (with a reason); see the **KPI dashboard**; invite and remove members; edit categories, customers and KPI settings |
  | Administrator | Everything, on every team; create teams; add team leads; give or remove administrator access and invite new administrators (*All Teams → Administrators*) |
- **Teams are separate.** People see only the teams they belong to: no tasks, history, KPI or export
  from any other team. **One person can belong to several teams** with one login: a lead adds them
  by their existing login, or they accept the new team's invite with "I already have an account",
  then switch teams at the top of the page. Their role can differ per team.
- **Target dates.** Until the lead approves, a member's proposed date on a task with no official target
  shows as "awaiting lead"; on a task with an official target, the official date stays in force.
- **Multiple teams.** Each team has its own people, categories, customers and KPI settings.
- **Daily tasks.** Status is calculated from the target and actual dates, as in the workbook:
  On-Going, Delay, No Target, Completed Early, Completed On Time, Completed Late.
- **Customers tab (administrators).** One list of every customer: add a customer, tick which teams work with
  it, and upload its logo once for all of those teams. Team leads can still edit their own team's list in
  *Team settings*.
- **Customer icons.** Every customer name has a small icon: a coloured badge with its initials, or a logo a
  team lead uploads in *Team settings* (stored as a 64 × 64 PNG in the database).
- **Signed progress notes.** When someone saves a task, every new or changed line in Task progress is
  stamped with their name and the date and time, e.g. `[11/11/2026 10:03 Izuan] Log collected`.
- **Help tab.** The **user guide** is for everyone and is also linked from the log-in page. Administrators
  also get a **data model** diagram, an **architecture** (component) diagram and this README as the
  **setup guide**; the server only sends those to administrators.
- **Sorting.** On the Tracker and Archive, click any column header to sort by it (click again to
  reverse), or use the *Sort by* menu, which also works on phones. Each tab remembers its own sort.
- **Archive.** Tasks move to the Archive 2 days after their actual date (the old
  `ArchiveOldCompletedTasks` rule; change with `TT_ARCHIVE_DAYS`).
- **KPI dashboard (leads only).** KPI = On-time % × 80% + Early % × 20%. Each lead and support
  involvement counts individually. Ratings: Excellent ≥ 90%, Good ≥ 70%, Needs Improvement ≥ 60%,
  otherwise At Risk. Weights and thresholds are editable per team.
- **Change history** on every task: who changed what, and when.
- **Export to Excel (.xlsx)**: Daily Task Tracker and Archive sheets for everyone, plus KPI Scorecard
  and Lead Tasks by Category for leads.

No external services and no Python packages: Python standard library + SQLite. The browser loads
nothing from the internet.

## Install on the server

Needs Docker with the Compose plugin.

```bash
git clone https://github.com/actionkamer90/Team-A-Task.git
cd Team-A-Task
cp .env.example .env        # set TT_BASE_URL to the address people will use, e.g. http://ddtaskserver:8080
docker compose up -d --build
docker compose logs app     # shows a one-time link to create the administrator account
```

Open the link from the logs, create the administrator account, then:

1. **All Teams → Create team** (or import the workbook data, below).
2. **Team & Invites → Add person** for the team lead, choose *Team lead*, then **Create invite link**
   and send it to them.
3. The lead invites their own members the same way.

### AlmaLinux / RHEL 9 with Podman (no Docker)

This is how ddtaskserver runs it: a Podman Quadlet unit, managed by systemd, starting on boot.

```bash
podman build --format docker -t localhost/team-task-tracker:latest .
cp deploy/team-task-tracker.container /etc/containers/systemd/   # edit TT_BASE_URL first
systemctl daemon-reload && systemctl start team-task-tracker
firewall-cmd --permanent --add-port=8080/tcp && firewall-cmd --reload
podman exec team-task-tracker python server.py admin-link      # one-time admin setup link
```

With Podman, use `podman cp` / `podman exec team-task-tracker ...` wherever this README says
`docker compose cp` / `docker compose exec app ...`. To update: `git pull`, rebuild the image,
then `systemctl restart team-task-tracker`. Data stays in the `tracker-data` volume.

### Import the Excel workbook data

Each team can bring its existing Daily Task Tracker workbook (`.xlsm` or `.xlsx`, 2026 template).
The import reads the *Daily Task Tracker*, *Archive* and *Customer* sheets, creates the team, adds
everyone named as a Lead or Support Engineer, and marks the names you pass with `--lead` as team
leads. Macros are never run.

**Never commit a workbook to this repository**: it is public, and the workbooks contain customer
names and task notes. Copy the file straight to the server (for example with WinSCP or `scp`), then:

```bash
docker compose cp YourTeamWorkbook.xlsm app:/data/import.xlsm
docker compose exec app python server.py import-xlsm /data/import.xlsm --team "Team Automation" --lead "Lead Name" --dry-run
docker compose exec app python server.py import-xlsm /data/import.xlsm --team "Team Automation" --lead "Lead Name"
docker compose exec app rm /data/import.xlsm
```

The `--dry-run` line only checks the workbook: it lists the people it found and any problems, such
as a date that doesn't exist. An import only creates a new team; it refuses to run if a team with
that name already exists.

### Update a team from a newer copy of its workbook

While a team still keeps its Excel file during the changeover, bring the tracker up to date from the
latest copy. Tasks are matched by task number; the workbook's values win, new tasks are added, and
nothing is deleted. An empty or invalid target date in the workbook never erases a target already set
in the tracker. Every change shows in the task's history as coming from the Excel workbook.

```bash
podman cp LatestWorkbook.xlsm team-task-tracker:/data/sync.xlsm
podman exec team-task-tracker python server.py sync-xlsm /data/sync.xlsm --team-id team-automation --dry-run
podman exec team-task-tracker python server.py sync-xlsm /data/sync.xlsm --team-id team-automation
podman exec -u 0 team-task-tracker rm /data/sync.xlsm
```

Back up first (see *Everyday admin*). Note that a sync also overwrites changes made in the tracker
since the last import, so stop syncing once the team works in the tracker.

## Update to a new version

With Docker:

```bash
git pull
docker compose up -d --build
```

With Podman (AlmaLinux, as on ddtaskserver), from the repository folder:

```bash
podman exec team-task-tracker python server.py backup /data/backup.db
mkdir -p backups && podman cp team-task-tracker:/data/backup.db ./backups/tracker-$(date +%F).db
git pull
podman build --format docker -t localhost/team-task-tracker:latest .
systemctl restart team-task-tracker
```

Data lives in the volume `tracker-data` and survives updates and rebuilds. Browser tabs that were
already open show a bar asking people to reload.

## Everyday admin

| Task | Command |
|---|---|
| Give an existing login administrator access | `podman exec team-task-tracker python server.py make-admin LOGIN` (or *All Teams → Administrators*) |
| Invite a new administrator | `podman exec team-task-tracker python server.py invite-admin` (prints a one-time link) |
| Forgot the administrator password | `docker compose exec app python server.py admin-link` (prints a reset link) |
| Back up the database | `docker compose exec app python server.py backup /data/backup.db && docker compose cp app:/data/backup.db ./backups/tracker-$(date +%F).db` |
| See logs | `docker compose logs -f app` |
| Load customer icons in bulk | Copy a folder of PNGs named after the customers (e.g. `RHB.png`) into the container with `podman cp logos team-task-tracker:/data/logos`, then run `podman exec team-task-tracker python server.py import-logos /data/logos --team-id team-a` (add `--dry-run` first to check; existing logos are kept unless you add `--replace`) |

Back up regularly, for example with a daily cron job running the backup command.

## HTTPS

Invite links and passwords should travel over HTTPS. Put a reverse proxy (nginx, Caddy, IIS)
with a certificate in front of the app, then set in `.env`:

```
TT_BASE_URL=https://tasks.example.com
TT_PUBLISH=127.0.0.1:8080
TT_COOKIE_SECURE=1
TT_TRUST_PROXY=1
```

Without HTTPS, the app still works on your internal network, but anyone who can watch that network
traffic could read passwords and session cookies.

## Security notes

- Passwords are hashed with scrypt; minimum 10 characters.
- Sessions are random tokens in `HttpOnly`, `SameSite=Strict` cookies, valid 14 days. Changing or
  resetting a password logs out other sessions.
- Invite and reset links are single-use, expire after 7 days, are stored only as hashes, and are kept
  in the URL fragment so they never reach server logs.
- Login is rate limited (5 failures per login per 15 minutes).
- Every permission is checked on the server. Hiding a button in the browser is never the protection.
- Strict Content-Security-Policy; the container runs as a non-root user.

## Development

```bash
python app/server.py serve                    # http://localhost:8080, database in ./data
python -m unittest discover -s tests -v       # API tests (standard library only)
```
