# Team A Task Tracker

A shared daily task tracker for Team A. It replaces the Excel template
`Team_A_Daily_Task_Tracker_Template_2026.xlsm`: everyone works on one live list
in the browser instead of passing the workbook around.

## Features

- **Daily tasks**: add, edit, filter and sort tasks. Status is calculated from
  the target and actual dates with the same rule as the workbook
  (On-Going, Delay, Completed Early, Completed On Time, Completed Late).
- **Workload**: open tasks per engineer, split into lead and support.
- **KPI scorecard**: score = On-time % × 80% + Early % × 20%, rated Excellent
  (≥ 90%), Good (≥ 70%), Needs Improvement (≥ 60%) or At Risk. Weights and
  thresholds are editable.
- **Archive**: tasks completed 2 or more days ago can be archived in one click,
  the same rule as the old `ArchiveOldCompletedTasks` macro.
- **History**: every change records who made it and what changed.
- **Live updates**: when someone saves, everyone's screen updates.
- **Accounts and roles**:
  - *Admin*: everything, including deleting tasks, team lists, KPI rules and user accounts.
  - *Engineer*: add, edit and archive tasks.
  - *View only*: read everything and export.
- **Export**: download tasks as CSV for Excel.

## Requirements

- A Linux server with **Docker** and the **Docker Compose plugin**
  (1 CPU, 1 GB RAM and 10 GB disk is enough).
- Git, to download this repository.

Without Docker you need **Node.js 22.13 or later** (uses Node's built-in SQLite).

## Install on the server (Docker)

1. Download the code:

   ```bash
   git clone https://github.com/actionkamer90/Team-A-Task.git
   cd Team-A-Task
   ```

2. Create the settings file and set an admin password:

   ```bash
   cp .env.example .env
   nano .env
   ```

   Set `ADMIN_PASSWORD` to a password of at least 8 characters. Change
   `HTTP_PORT` if port 80 is already used on the server.

3. Start the tracker:

   ```bash
   docker compose up -d --build
   ```

4. Open `http://<server-name>/` (for example `http://ddtaskserver/`) and sign
   in as `admin` with the password from `.env`.

5. Under **Team setup → User accounts**, create an account for each team member.

### Import the existing Excel workbook (one time)

Copy the workbook into the `import` folder next to `docker-compose.yml`, then run
the import:

```bash
mkdir -p import && cp /path/to/Team_A_Daily_Task_Tracker_Template_2026.xlsm import/tracker.xlsm && chmod 644 import/tracker.xlsm
```

```bash
docker compose run --rm tracker node scripts/import-xlsx.js /import/tracker.xlsm
```

The import reads the **Daily Task Tracker** sheet (active tasks), the
**Archive** sheet (archived tasks) and the **Customer** sheet. It prints a note
for anything it had to fix, such as an impossible date like `31-11-2026`.
Running it again updates tasks with the same Task No instead of duplicating
them. Add `--dry-run` to check the file without saving, or `--replace` to wipe
all tasks first.

After importing, you can delete the copy: `rm import/tracker.xlsm`.

## Day-to-day operations

| Task | Command |
|---|---|
| See if it's running | `docker compose ps` |
| View the logs | `docker compose logs -f` |
| Restart | `docker compose restart` |
| Stop | `docker compose down` |
| Update to the latest code | `git pull && docker compose up -d --build` |

### Backups

All data is in one SQLite database inside the `tracker-data` Docker volume.
Make a backup (safe while the tracker is running):

```bash
docker compose exec tracker node scripts/backup.js
```

Copy the backups out of the container to the server:

```bash
docker compose cp tracker:/data/backups ./backups
```

The 30 most recent backups are kept. To back up every night at 1 am, add
this line with `crontab -e` (change the path to where you cloned the repo):

```
0 1 * * * cd /home/USER/Team-A-Task && docker compose exec -T tracker node scripts/backup.js && docker compose cp tracker:/data/backups ./backups
```

### Forgotten admin password

Another admin can set a new password under **Team setup → User accounts**.
If no admin can sign in, reset it from the server:

```bash
docker compose exec tracker node -e "const {open,repo}=require('./src/db');const {hashPassword}=require('./src/auth');const s=repo(open('/data/tracker.db'));const u=s.getUserByName('admin');s.updateUser(u.id,{passwordHash:hashPassword(process.argv[1]),active:true});console.log('Password reset')" 'NewPassword123'
```

### HTTPS

On an office network, plain HTTP is usually fine. If the tracker will be
reachable from the internet, put it behind a reverse proxy with HTTPS, such as
Nginx with a Let's Encrypt certificate, and set `COOKIE_SECURE=true` and
`TRUST_PROXY=true` in `.env`.

## Development

```bash
npm install
npm start          # http://localhost:3000, data in ./data
npm test
```

On first start without `ADMIN_PASSWORD`, a random admin password is printed in
the log.

### Project layout

```
public/            Browser app (index.html, app.js, styles.css)
public/logic.js    Status, archive and KPI rules, shared by browser, server and tests
src/app.js         HTTP API (Express)
src/db.js          SQLite schema and queries
src/auth.js        Passwords (scrypt) and sessions
src/index.js       Server start-up and first admin account
scripts/           Excel import and backup
test/              Tests (node --test)
```
