# Muenot — Deployment Guide (Hostinger + MySQL)

## 1. Database setup (phpMyAdmin)

1. In hPanel, create a MySQL database + user, and note the **host, database name, username, password**.
2. Open **phpMyAdmin**, select your new database, go to the **Import** tab.
3. Upload `database/schema.sql` from this project and run the import.
   - This creates all tables (`employees`, `modules`, `features`, `employee_permissions`, `sessions`)
   - Seeds the 5 modules (HR, Sales, Finance, Recruitment, Operations) with their features
   - Seeds one admin account:
     - **Email:** `admin@company.com`
     - **Password:** `Admin@123`
     - **Change this password immediately after first login** (use the "Change Password" option from the profile menu).

## 2. Environment variables

Copy `.env.local.example` to `.env.local` (or configure these in your Node host's environment):

```
DB_HOST=your-mysql-host
DB_PORT=3306
DB_USER=your-mysql-user
DB_PASSWORD=your-mysql-password
DB_NAME=your-mysql-database
SESSION_SECRET=generate-a-long-random-string-here
```

Generate a strong `SESSION_SECRET` with: `openssl rand -base64 32`

## 3. Hosting requirement

This app is a Next.js server app (uses API routes, cookies, and a Node MySQL driver) — it needs a **Node.js runtime**, not static hosting. On Hostinger this means:

- **Hostinger's Node.js hosting / VPS plan** — run `npm run build` then `npm run start` (or use PM2), pointing your domain at the Node process port.
- Static/shared PHP hosting plans will **not** run this app — they only serve static files.

## 4. Build & run

```bash
npm install
npm run build
npm run start
```

## 5. First login

1. Go to `/login`, sign in with `admin@company.com` / `Admin@123`.
2. Change the password immediately.
3. Go to **Admin → Employees → Invite Employee** to create accounts for your team.
4. Click **Permissions** next to any employee to grant granular access per module/feature.

## 6. High availability (SPEC 77)

The application is designed to run as **multiple stateless application servers**
(and background workers) behind a load balancer, with no single point of
failure inside the app tier. All durable state lives in shared MySQL, so any
node can serve any request and nodes can be added, removed, or restarted freely.

### Run more than one node

Each node runs the same `npm run build && npm run start`. Point the load
balancer at every node's port. Because there is no local session or counter
state, no sticky sessions are required.

- **Sessions** are stateless signed JWT cookies validated against the shared
  `user_sessions` table (revocation + concurrent-session cap), so a node
  restart never signs users out.
- **Rate limiting** (both the tenant API limiter and the pre-auth limiter for
  login/signup) is backed by shared MySQL tables, so limits are enforced
  consistently across nodes and survive restarts. If the database is briefly
  unreachable the pre-auth limiter fails open to per-node protection rather than
  blocking logins.
- **Background jobs & scheduled (cron) jobs** are durable DB queues with
  row-locked claiming (`FOR UPDATE`), idempotency keys, and per-slot uniqueness.
  Every node can run the worker/scheduler safely — a job is claimed by exactly
  one node, and a crashed node's in-flight jobs are recovered by timeout.
- **File storage** uses a pluggable provider layer (managed platform storage /
  S3 / Vercel Blob) resolved per tenant from the database — no reliance on a
  single local disk.

### Load-balancer health probes

Point the load balancer / orchestrator at these unauthenticated endpoints:

- **Liveness — `GET /api/health`**: returns `200` whenever the process can
  serve HTTP (no dependency checks). Use this to decide when to *restart* a node.
- **Readiness — `GET /api/health/ready`**: returns `200` only when the node's
  database is reachable, otherwise `503`. Use this to decide when to *route
  traffic* to a node, so a node that has lost its database is drained instead of
  serving errors. Storage configuration is reported for observability but does
  not gate readiness.

Both responses contain only booleans, latencies, and short status strings — no
secrets — and are safe to expose to infrastructure.

### Recommended scaling notes

- Run the DB-backed scheduler cron (`* * * * *`) on every node; claiming is
  race-safe, so duplicate schedulers do not double-run jobs.
- Use a managed/replicated MySQL (primary + replica or a managed cluster) to
  remove the database as a single point of failure; the app already reuses a
  bounded connection pool per node.
- Expired pre-auth rate-limit counters are pruned by the existing
  `api_rate_limit_cleanup` scheduled job.
