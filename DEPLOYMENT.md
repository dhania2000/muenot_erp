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
