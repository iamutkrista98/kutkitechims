# AssetTrack v3 — cPanel Deployment Guide
## School Inventory & Asset Management System (Production MySQL Edition)

---

## What's in v3

- MySQL-backed, image blobs stored directly in the database (avatars, item photos, school logo, procurement bills, petty cash receipts)
- FIFO/LIFO stock batch tracking per item, with a permanent, unchangeable purchase log (including the bill image) for accountability
- Annual budget plans, weekly stock orders, and petty cash allocations with approval workflow
- Grid / list / compact inventory views, tag-based search and filtering
- Forgot-password via emailed OTP, themed HTML emails with the school logo
- Production hardening: helmet, compression, rate limiting, graceful shutdown, connection draining, structured error handling

---

## Prerequisites

| Requirement | Notes |
|---|---|
| cPanel with Node.js | Version 18+ recommended |
| MySQL 5.7 / 8.0 or MariaDB 10.11+ | Provided by cPanel/WHM |
| SMTP email access | For OTP and notification emails |

---

## Step 1 — Create MySQL Database

1. Log in to cPanel → **MySQL Databases**
2. Create a new database, e.g. `youraccount_assettrack`
3. Create a MySQL user, e.g. `youraccount_atuser` with a strong password
4. Add the user to the database with **All Privileges**
5. Note down: host (`localhost`), database name, username, password

---

## Step 2 — Upload & Extract Files

1. Go to cPanel → **File Manager** → navigate to your domain root (or a subdirectory)
2. Upload `assettrack-v3.zip`
3. Right-click → **Extract**
4. All project files should be in e.g. `/home/youraccount/assettrack/`

---

## Step 3 — Configure Environment Variables

1. Copy `.env.example` to `.env`:
   ```bash
   cp .env.example .env
   ```
2. Edit `.env` with your actual values:
   ```
   DB_HOST=localhost
   DB_PORT=3306
   DB_USER=youraccount_atuser
   DB_PASS=your_strong_password
   DB_NAME=youraccount_assettrack
   SESSION_SECRET=a-very-long-random-string-change-this
   SMTP_HOST=mail.yourdomain.com
   SMTP_PORT=587
   SMTP_USER=noreply@yourdomain.com
   SMTP_PASS=your_email_password
   ```

> **Session secret:** generate one with:
> ```bash
> node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
> ```

If using cPanel's **Setup Node.js App** panel instead of a `.env` file, add each variable individually under **Environment Variables** — both approaches are supported since the app reads from `process.env`.

---

## Step 4 — Set Up Node.js App in cPanel

1. Go to cPanel → **Setup Node.js App**
2. Click **Create Application**
3. Fill in:
   - **Node.js version:** 18.x or 20.x
   - **Application mode:** Production
   - **Application root:** `/home/youraccount/assettrack`
   - **Application URL:** your domain or subdomain
   - **Application startup file:** `server.js`
4. Add the environment variables from Step 3
5. Click **Create**

---

## Step 5 — Install Dependencies

In the cPanel Node.js app panel, click **Run NPM Install**, or via SSH:
```bash
cd /home/youraccount/assettrack
npm install
```

---

## Step 6 — Seed Initial Data (first run only)

Two seed scripts are available — choose the one that matches how you want
to start:

**Option A — full demo dataset** (for evaluation, training, or a demo
environment):
```bash
node seed.js
```
This creates a realistic starter dataset for "Silver Oak School":
- 5 departments, 8 staff accounts, 10 locations, 8 categories, 16 items
- Stock batches (FIFO and LIFO examples), purchase logs, 4 stocking plans, 4 petty cash expenses
- **Admin login:** `rajesh.shrestha@silveroak.edu.np` / `Admin@123`
- **Staff login:** `anita.rai@silveroak.edu.np` / `Welcome@123`

**Option B — blank install for real use** (recommended for a genuine
school deployment where all data will be entered by hand):
```bash
node seed-blank.js
```
This creates only:
- The school's branding, set to "Gyan Kunj Secondary School"
- One administrator account and one staff account — nothing else
  (no departments, locations, categories, vendors, items, transfers,
  procurement requests, repairs, stocking plans, or petty cash entries)
- **Admin login:** `admin@gyankunj.edu.np` / `Admin@123`
- **Staff login:** `staff@gyankunj.edu.np` / `Welcome@123`

After signing in as the administrator, use **Departments**, **Locations**,
**Categories**, **Vendors**, and **Inventory → Add Item** to build up the
school's real data from scratch. To use a different school name, either
edit the `schoolName` in `seed-blank.js` before running it, or just change
it afterward from **Branding** once signed in.

> ⚠️ Change all default passwords immediately after first login via **My Profile → Change Password**.

Either script is safe to run only once on a fresh database — running it
again will fail on duplicate-key errors for the fixed user ids (`usr_1`,
`usr_2`, ...). If you need to reset, drop and recreate the database first.

---

## Step 7 — Start the App

Click **Start App** in the cPanel Node.js panel, or via SSH:
```bash
node server.js
```

On startup the app will:
1. Connect to MySQL
2. Auto-create all tables and safely `ALTER TABLE` any missing columns on existing installs (safe to run repeatedly)
3. Start listening on the configured port
4. Begin periodic housekeeping (expired OTP cleanup every 30 minutes)

The app also handles `SIGTERM`/`SIGINT` gracefully — in-flight requests (e.g. a large bill upload) are allowed to finish before the process exits, which matters on cPanel redeploys/restarts.

---

## Step 8 — Configure Your Domain

In cPanel → **Domains** or **Subdomains**, point your domain/subdomain to the Node.js app port. cPanel's Passenger/reverse proxy handles this automatically.

---

## Post-Deployment Checklist

- [ ] Log in as admin and change the default password
- [ ] Update school name, tagline and **logo** under **Branding** — the logo appears in the sidebar, the login page, and every outgoing email
- [ ] Add your departments, locations and categories
- [ ] Invite staff via **Staff & Users** → Add User (they receive a welcome email with a temporary password, if SMTP is configured)
- [ ] Set up annual/weekly/petty stocking plans under **Stocking Plans**
- [ ] Set the petty cash per-expense limit if different from the Rs. 5,000 default (Settings)
- [ ] Test the forgot-password OTP flow end-to-end
- [ ] Verify email notifications are working (check SMTP settings and server logs — if SMTP isn't configured, emails are logged to the console instead of failing silently)

---

## Image & File Storage

Images and documents (avatars, item photos, school logo, procurement bills, purchase-log bills, petty cash receipts) are stored on **disk**, under an `uploads/` directory next to `server.js` — not in the database. This is deliberately chosen for cPanel and shared hosting generally: serving a file from disk is far cheaper than round-tripping it through Node and a MySQL query every time, it keeps the database small and fast to back up, and it avoids an entire class of bug where a large BLOB column bloats every unrelated query unless carefully excluded.

```
uploads/
├── avatars/                    (public — served via /api/images/avatar/:id)
├── items/                      (public — served via /api/images/item/:id)
├── logo/                       (public — served via /api/images/logo)
└── private/
    ├── bills/                  (auth required — procurement bills)
    ├── purchase-logs/          (auth required — permanent audit-trail copies)
    └── petty-receipts/         (auth required — petty cash receipts)
```

The `/api/images/...` URLs stay the same as earlier versions — the app resolves the stored file path (a small database lookup) and streams the file with `res.sendFile()`, which natively supports range requests and conditional GETs. "Public" here only means "no database round-trip and no sensitive content" (an avatar or item photo isn't private); bills and receipts stay behind the same `requireAuth` checks as before.

### ⚠️ This directory must persist across deployments

On cPanel, if you redeploy by re-extracting a fresh zip over your application root, **make sure `uploads/` is excluded from that overwrite** (or back it up and restore it after), the same way you'd protect a database — this directory now holds real, irreplaceable data (uploaded photos, bills, receipts) that doesn't exist anywhere else. The app creates the folder structure automatically on startup if it's missing, but an empty `uploads/` folder means every previously-uploaded image is gone.

**Recommended:** include `uploads/` in your regular backup routine alongside your MySQL database dump — the two together are the complete state of the application's data.

Purchase log entries (the permanent audit trail created whenever procurement is received into inventory) keep their **own copy** of the bill file on disk, independent of the original procurement request's bill — so if someone later removes or replaces the bill on the procurement request itself, the purchase record's copy is untouched.

Upload limits: all uploads (item/avatar/logo photos and bills/receipts/PDFs) are capped at 256 KB — deliberately tight, since shared-hosting proxies/WAFs (the cPanel + ModSecurity combination this was tuned against) commonly impose their own low, often-undocumented multipart body-size ceiling that a larger "valid" upload could otherwise sail past client-side and still get silently killed by. Photos are automatically compressed in the browser before upload to fit under this; PDFs cannot be auto-compressed, so a large PDF bill/receipt needs to be shrunk manually before uploading. The upload widgets validate file size and type in the browser before sending, so oversized or wrong-type files are rejected immediately with a clear message rather than after a slow upload attempt.

---

## File Structure

```
assettrack/
├── server.js          # Main Express application (60+ routes)
├── db.js              # MySQL data layer — pool, schema, FIFO/LIFO batches,
│                       # purchase logs, stocking plans, petty cash
├── fileStorage.js      # Filesystem storage for images/documents (uploads/)
├── mailer.js           # Themed HTML email system (OTP, notifications, welcome)
├── exports.js          # Excel report builders (inventory, transfers, etc.)
├── nepaliDate.js       # Bikram Sambat date utilities
├── seed.js             # Full demo dataset seeder (Silver Oak School)
├── seed-blank.js       # Minimal seeder — admin + staff only, no demo data
├── package.json
├── .env                # Environment variables (NOT committed to git)
├── .env.example         # Template
├── uploads/             # Uploaded files — see "Image & File Storage" above;
│                        # back this up like a database, don't wipe on redeploy
└── public/
    ├── index.html      # Login + forgot password (OTP flow)
    ├── dashboard.html   # Main application shell + all modals
    ├── css/style.css    # Full design system
    └── js/
        ├── common.js    # API wrapper, toast, themed confirm dialog, upload validation
        └── app.js       # Full application logic
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| `ER_ACCESS_DENIED_ERROR` | Check `DB_USER` and `DB_PASS` in `.env` |
| `ECONNREFUSED` on port 3306 | Verify `DB_HOST=localhost` and MySQL is running |
| OTP email not sending | Check SMTP settings; look at Node.js error logs — unconfigured SMTP logs the OTP to the console instead of failing |
| `Cannot find module 'mysql2'` (or similar) | Run `npm install` again |
| Session lost on restart | Expected to *not* happen — sessions are stored in MySQL via `express-mysql-session`, not in memory |
| Duplicate-key error running `seed.js` | The database already has seed data; drop and recreate the database first if you need a clean reset |
| Uploaded file rejected as "too large" | All uploads are capped at 256 KB. Photos are auto-compressed by the browser before upload; a PDF bill/receipt over the limit needs to be shrunk manually first |
| A photo/bill/avatar disappeared after an unrelated edit | This was a known issue in early builds where saving any row in a table could wipe blob columns for other rows; v3's data layer fixes this by using `INSERT ... ON DUPLICATE KEY UPDATE` scoped to non-blob columns only, verified against a live database before release |
| Uploads return `EACCES`/permission denied, or `ENOENT` writing to `uploads/` | The Node process needs write permission to the `uploads/` directory. On cPanel this is usually automatic (the app runs as your account), but if you manually created the folder via File Manager first, check its permissions (755 for directories) and ownership match your cPanel user |
| Uploaded images/bills disappeared after a redeploy | The `uploads/` directory wasn't preserved across the redeploy — see "Image & File Storage" above. Back it up like a database; don't let a fresh zip extraction overwrite it |
| Images uploaded fine locally but "nothing happens" on cPanel | See the dedicated **Diagnosing "Uploads Do Nothing" on cPanel** section below — as of this version, every upload route logs the real cause to the Node.js error log, so check that first |

---

## Diagnosing "Uploads Do Nothing" on cPanel

If an upload (photo, avatar, logo, bill, receipt) appears to silently do
nothing on cPanel while working locally, work through this in order —
each step rules out one specific, well-known cause.

### 1. It is very unlikely to be a relative-path problem

Every file path in this app is built from `__dirname` (the actual
directory the `.js` file lives in on disk), never from `process.cwd()`
(the directory the process happened to be *launched from*). This
distinction matters specifically because Passenger/cPanel can spawn the
Node process from a different working directory than the app's own
folder — code that built paths like `./uploads` or `path.resolve('uploads')`
would break in exactly that scenario, but `__dirname`-based paths (what
this app uses throughout — see `fileStorage.js`) resolve correctly
regardless of where the process was started from. `require('./db')`-style
module imports are similarly always resolved relative to the requiring
file, never the working directory, so those are not a factor either. In
short: this specific class of bug has already been designed around and
verified in the code, so it's an unlikely root cause — treat the steps
below as the more probable culprits first.

### 2. Check the Node.js error log

Every upload route now logs the real underlying error before responding
— go to cPanel → **Setup Node.js App** → your app → and open the error
log (or tail it via SSH: `tail -f /home/youraccount/logs/yourapp/error.log`
— exact path shown in the cPanel panel). Trigger the failing upload again
and watch for a line starting with `[upload]`. This will show you the
*actual* exception — permission denied, disk quota exceeded, an unexpected
field name, etc. — instead of a blank client-side failure.

If the log shows `multer rejected ... Request aborted`, this specific
message means the client's connection closed before the file finished
uploading — it is not a permissions or disk problem. Confirm you're
running a version of `public/js/common.js` where file uploads use a
longer client-side timeout than regular API calls (120s vs 30s) — on a
real network + reverse-proxy hop (cPanel/Passenger), even a modest image
can take longer than a plain JSON request to fully transfer, and earlier
versions of this app applied the same short timeout to every request
including uploads, aborting the upload from the browser side before it
completed. This never showed up on localhost because uploads there
complete near-instantly over loopback.

### 3. Check for an intermediate proxy/WAF rejecting the request

Shared hosting frequently runs ModSecurity or a similar Apache-level
firewall in front of Node apps, and its default rule sets sometimes flag
multipart/form-data POSTs (especially larger ones) before they ever reach
your Node process — in that case nothing will appear in *your* app's
error log at all, because the request never got there. Check cPanel's
main **Apache error log** (not the Node.js app's own log) for entries
around the time of the failed upload, and ask your host to whitelist the
app's upload endpoints if ModSecurity is confirmed as the cause.

### 4. Confirm `uploads/` exists and is writable

The app creates the full `uploads/` folder tree automatically on boot.
Check cPanel's File Manager to confirm it exists next to `server.js`, and
that its permissions allow the app's own user to write to it (755 for
directories is standard on cPanel; ownership should match your cPanel
account automatically since the app runs as that user).

### 5. Check disk quota

If the cPanel account is at or near its disk quota, writes will fail with
`ENOSPC` — this now surfaces clearly in the Node.js error log per step 2
above, but is easy to overlook as a cause if you're not expecting it.
Check **cPanel → Disk Usage**.

### 6. Confirm the Node.js version matches `package.json`'s `engines` field

This app requires Node 18 or newer (declared in `package.json`). In
**cPanel → Setup Node.js App**, confirm the selected version is 18.x or
later — an older selected version can cause `npm install` to silently
install incompatible package versions or fail in ways that only surface
once a specific code path (like a file upload) is exercised.

---

## Security Notes

- Change `SESSION_SECRET` to a unique random value per installation
- Use HTTPS (cPanel's Let's Encrypt SSL) in production
- The `.env` file must never be publicly accessible — prefer cPanel's Node.js app environment variables panel for secrets
- OTP codes expire after 10 minutes and are single-use
- Rate limiting: login (30/15 min), OTP requests (5/10 min)
- `helmet` sets standard security headers; `compression` reduces response payload sizes
- The app exits gracefully on `SIGTERM`/`SIGINT` and logs (without crashing) on unhandled promise rejections

---

## Multiuser Production Readiness — Audit Summary

This section documents what was checked when auditing the app for memory
leaks and correctness under real multiuser production load, so future
changes can be checked against the same list.

**Sessions — MySQL-backed, not in-memory.** Login sessions are stored via
`express-mysql-session`, not `express-session`'s default in-process
`MemoryStore`. This matters two ways: the default MemoryStore is
explicitly documented as unsuitable for production (it never evicts
expired sessions on its own, so its memory footprint grows without bound
for as long as the process runs), and it is also process-local — under
Passenger, which can spawn more than one Node worker process for the same
app, sessions stored in one process's memory are invisible to another,
so a person could get logged out at random depending which worker
happened to handle their next request. The MySQL-backed store avoids both
problems, and the app also runs its own periodic cleanup
(`db.cleanOtps()`, every 30 minutes) to keep the sessions/OTP tables from
growing unbounded over time.

**No unbounded in-memory state.** Audited every module-level `let`/`const`
for anything that accumulates over the app's lifetime — no growing
arrays, Maps, or caches were found anywhere in `server.js`, `db.js`, or
`mailer.js`. The only long-lived timers are the OTP cleanup interval and
the graceful-shutdown force-exit timer, neither of which retains
per-request data.

**Connection pooling — sized for shared hosting, not leaked.** The MySQL
pool (`db.js`) and the session store's own pool are both bounded
(`DB_CONNECTION_LIMIT`, default 8; `SESSION_CONNECTION_LIMIT`, default 3)
and every connection acquired via `withTx()` is released in a `finally`
block even on error, so a failed request can't hold a connection open.
If you increase cPanel's Node.js app to run more than one instance, the
total connections used is roughly `(DB_CONNECTION_LIMIT +
SESSION_CONNECTION_LIMIT) × instance count` — keep that comfortably under
your MySQL user's connection quota (check with your host if unsure).

**Uploads never buffer to disk before processing.** `multer.memoryStorage()`
keeps an uploaded file entirely in a request-scoped RAM buffer with no
temp-file step; that buffer is only referenced for the lifetime of the
request handler and is never assigned to any module-level variable, so
it's eligible for garbage collection the moment the request completes —
verified by inspecting every upload route in `server.js`.

**Rate limiting is per-process.** `express-rate-limit`'s default store is
also process-local, same caveat as the old session behavior above. This
is fine for the standard "single Node.js app instance" cPanel setup this
app is designed for; if you deliberately run multiple instances behind a
load balancer, be aware rate limits are tracked separately per instance
(each instance allows the full configured limit independently) rather
than shared — this is a security/correctness nuance to know about, not a
memory leak.

**Batched writes, not per-row.** The data layer's `save()` function
upserts changed rows in a small number of multi-row batches rather than
one round-trip per row (see the comment above `save()` in `db.js` for
the history of why this matters) — under concurrent multiuser load this
keeps individual requests fast and avoids connection-pool exhaustion from
many slow sequential queries piling up.

**Email sends never block a response.** Every notification email is
fired through `notifyAsync()` (a fire-and-forget wrapper with its own
error logging) rather than being awaited inline — a slow or failing SMTP
server affects only the background email, never the person waiting on
their approve/reject/submit action to complete.
