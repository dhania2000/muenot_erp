// Seed two isolated tenants for the E2E smoke suite (test-e2e/).
//
//   node scripts/ci/seed-e2e.mjs   (reads DB_* and E2E_PASSWORD from env)
//
// Idempotent: re-running updates the same rows. Prints the fixture ids as
// JSON so the smoke tests can target them.
import mysql from "mysql2/promise"
import bcrypt from "bcryptjs"

const password = process.env.E2E_PASSWORD
if (!password) {
  console.error("E2E_PASSWORD is required")
  process.exit(1)
}

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
})

async function upsertTenant(slug, name) {
  await db.execute(
    "INSERT INTO tenants (name, slug, status, plan) VALUES (?, ?, 'active', 'e2e') ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active'",
    [name, slug],
  )
  const [[row]] = await db.execute("SELECT id FROM tenants WHERE slug = ?", [slug])
  return Number(row.id)
}

async function upsertUser(email, name, role, tenantId, hash) {
  const tenantRole = role === "admin" ? "tenant_admin" : "employee"
  await db.execute(
    `INSERT INTO users (name, email, password_hash, role, status, tenant_id, tenant_role, must_change_password)
     VALUES (?, ?, ?, ?, 'active', ?, ?, 0)
     ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = VALUES(role), status = 'active',
       tenant_id = VALUES(tenant_id), tenant_role = VALUES(tenant_role), must_change_password = 0`,
    [name, email, hash, role, tenantId, tenantRole],
  )
  const [[row]] = await db.execute("SELECT id FROM users WHERE email = ?", [email])
  return Number(row.id)
}

async function upsertInvoice(tenantId, invoiceNo, total) {
  await db.execute(
    `INSERT INTO billing_invoices (tenant_id, invoice_no, issue_date, due_date, currency, subtotal, total, credit_applied, amount_paid, status)
     VALUES (?, ?, CURDATE(), CURDATE() + INTERVAL 14 DAY, 'USD', ?, ?, 0, 0, 'open')
     ON DUPLICATE KEY UPDATE total = VALUES(total), subtotal = VALUES(subtotal), amount_paid = 0, credit_applied = 0, status = 'open'`,
    [tenantId, invoiceNo, total, total],
  )
  const [[row]] = await db.execute("SELECT id FROM billing_invoices WHERE tenant_id = ? AND invoice_no = ?", [tenantId, invoiceNo])
  await db.execute("DELETE FROM billing_payments WHERE tenant_id = ? AND invoice_id = ?", [tenantId, row.id])
  return Number(row.id)
}

const hash = await bcrypt.hash(password, 10)
const tenantA = await upsertTenant("e2e-alpha", "E2E Alpha")
const tenantB = await upsertTenant("e2e-beta", "E2E Beta")

const fixtures = {
  tenantA,
  tenantB,
  adminA: { id: await upsertUser("admin-a@e2e.test", "Admin Alpha", "admin", tenantA, hash), email: "admin-a@e2e.test" },
  memberA: { id: await upsertUser("member-a@e2e.test", "Member Alpha", "employee", tenantA, hash), email: "member-a@e2e.test" },
  adminB: { id: await upsertUser("admin-b@e2e.test", "Admin Beta", "admin", tenantB, hash), email: "admin-b@e2e.test" },
  invoiceA: await upsertInvoice(tenantA, "E2E-A-0001", 125),
  invoiceB: await upsertInvoice(tenantB, "E2E-B-0001", 90),
}

await db.end()
console.log(JSON.stringify(fixtures))
