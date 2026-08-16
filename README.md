# Side Job Tracker

A self-hosted web app for tracking income, expenses, mileage, and receipts across
multiple side jobs (Rover, DoorDash, Uber Eats, Instacart, etc.) — with an
automatically-calculating self-employment tax estimate.

## Features

- **Job tabs** — each side job gets its own tab with its own income, expenses,
  mileage, and receipts. Add a new job any time with the **+** button.
- **"All Jobs" combined tab** — shows your total self-employment tax picture
  across every job, since the IRS taxes combined self-employment income, not
  each gig separately. This is the number that determines your real quarterly
  obligation.
- **Receipt uploads** — attach a photo or PDF to any entry.
- **Auto-calculating tax panel** — self-employment tax, federal, state, and a
  plain-language note on whether you're over the $1,000 quarterly-payment
  threshold.
- **PDF exports** — one button for a full transaction + tax report, another
  for a bundle of every receipt image in a single PDF.
- **Light/dark mode**, remembered between visits.
- Password-protected login. No bank linking, no third-party subscriptions —
  everything runs on your own server.

## What's in this package

```
server.js            Backend (Express + SQLite)
package.json          Dependencies
public/index.html      Dashboard UI
public/login.html      Login page
Dockerfile            Container build instructions
docker-compose.yml      Container run configuration
.env.example          Template for your real .env file (copy and fill in)
hash-password.js       Helper to generate your login password hash
.gitignore            Keeps .env and your data out of version control
```

## First-time setup (new install)

1. Upload this whole folder to your server (e.g. via GitHub, then `git clone`
   on the server), into a directory like `/opt/side-job-tracker`.
2. `cd` into that directory.
3. Copy the environment template:
   ```
   cp .env.example .env
   ```
4. Build the container:
   ```
   docker-compose build
   ```
   (On servers using Docker Compose v2, use `docker compose` — no hyphen —
   instead of `docker-compose` everywhere in these instructions.)
5. Generate a password hash for logging in:
   ```
   docker-compose run --rm rover-tracker node hash-password.js "yourpassword"
   ```
   Copy the printed `APP_PASSWORD_HASH=...` line.
6. Edit `.env`:
   ```
   nano .env
   ```
   Paste in the `APP_PASSWORD_HASH` line, and set `SESSION_SECRET` to any
   long random string of your choosing.
7. Start it:
   ```
   docker-compose up -d
   ```
8. Set up a reverse proxy (Apache/Nginx) pointing your chosen subdomain at
   `127.0.0.1:3010`, get an SSL certificate (e.g. via `certbot`), and you're
   live.

The app auto-creates its database and a default "Rover" job tab on first run.

## Upgrading an existing install

If you already have this app running and are updating to a new version:

1. Pull the new code (e.g. `git pull` if using GitHub) into the same folder.
2. Rebuild and restart:
   ```
   docker-compose build && docker-compose up -d
   ```
   If you're on the older `docker-compose` v1 and see a `ContainerConfig`
   error during this step, it's a known bug in that version. Work around it
   with:
   ```
   docker-compose build && docker rm -f rover-tracker && docker-compose up -d
   ```
3. **Your data is safe.** Entries, receipts, and the database live in the
   `data/` and `uploads/` folders on your server (mounted into the
   container), not inside the container image itself. Rebuilding never
   touches them. The one exception: `docker-compose down -v` would delete
   them (the `-v` flag removes volumes) — never run that unless you mean to
   wipe everything.
4. If you're upgrading from a version of this app that didn't have job tabs,
   no action is needed — the app automatically creates a "Rover" job on
   startup and moves all your existing entries into it. Nothing is lost.

## Configuration (.env)

| Variable | Purpose |
|---|---|
| `APP_PASSWORD_HASH` | Login password (hashed — never store it in plain text) |
| `SESSION_SECRET` | Random string used to secure login sessions |
| `PORT` | Internal port the app listens on (default 3000) |
| `SE_TAX_RATE` | Self-employment tax rate (default 0.153 = 15.3%) |
| `SE_TAXABLE_FRACTION` | IRS adjustment factor (default 0.9235) |
| `FEDERAL_RATE` | Your marginal federal tax rate estimate |
| `STATE_RATE` | Your state tax rate estimate |
| `MILEAGE_RATE` | Current IRS standard business mileage rate — check
[irs.gov](https://www.irs.gov) each year, as this changes annually |

**Note:** all tax figures produced by this app are estimates based on the
rates you configure — not tax advice. Verify against current IRS guidance or
a tax professional, especially near filing deadlines.

## Backing up your data

Back up the `data/` and `uploads/` folders periodically (same routine as your
other self-hosted apps) — that's the entirety of what this app stores.

## Adding a new job

Click the **+** tab in the app itself — no file changes or redeployment
needed. Job tabs are created live through the UI.
