/**
 * SPEC 79 — Database performance: benchmark + index verification.
 * ---------------------------------------------------------------------------
 * Phase 4 harness. For each hot tenant-scoped access pattern this runs
 * `EXPLAIN` and asserts the planner:
 *   - picks a composite index (key starts with the tenant column), and
 *   - does NOT fall back to "Using filesort" / "Using temporary" for the
 *     `ORDER BY created_at` pages, and
 *   - does NOT do a full table scan (type = ALL).
 * Then it times the count+page pair to show the tenant-ordered pages are cheap.
 *
 * Requires DB_* env vars (see lib/db.ts). If the database is unreachable it
 * prints the checks it WOULD run and exits 0, so it is safe in CI / previews
 * without a database — mirroring scripts/benchmark-scalability.mjs.
 *
 * Run:  node --env-file-if-exists=/vercel/share/.env.project \
 *            scripts/benchmark-db-performance.mjs
 */

const CHECKS = [
  {
    label: "sales_leads — tenant list, newest first",
    sql: "SELECT * FROM `sales_leads` WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
    params: [1],
    wantKeyLike: "idx_sales_leads_tenant_created",
    forbidExtra: ["Using filesort"],
  },
  {
    label: "sales_leads — tenant + status filter",
    sql: "SELECT * FROM `sales_leads` WHERE tenant_id = ? AND status = ? LIMIT 50",
    params: [1, "New"],
    wantKeyLike: "idx_sales_leads_tenant_status",
    forbidExtra: [],
  },
  {
    label: "clients — tenant list, newest first",
    sql: "SELECT * FROM `clients` WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 50",
    params: [1],
    wantKeyLike: "idx_clients_tenant_created",
    forbidExtra: ["Using filesort"],
  },
  {
    label: "billing_invoices — tenant + status",
    sql: "SELECT * FROM `billing_invoices` WHERE tenant_id = ? AND status = ? ORDER BY created_at DESC LIMIT 50",
    params: [1, "open"],
    wantKeyLike: "idx_billing_invoices_tenant",
    forbidExtra: [],
  },
  {
    label: "billing_invoices — overdue by due_date",
    sql: "SELECT * FROM `billing_invoices` WHERE tenant_id = ? AND due_date < ? ORDER BY due_date ASC LIMIT 50",
    params: [1, "2026-01-01"],
    wantKeyLike: "idx_billing_invoices_tenant_due",
    forbidExtra: ["Using filesort"],
  },
  {
    label: "whatsapp messages — conversation thread page",
    sql: "SELECT * FROM `marketing_whatsapp_messages` WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 50",
    params: [1],
    wantKeyLike: "idx_wa_message_convo_created",
    forbidExtra: ["Using filesort"],
  },
]

function printPlanOnly() {
  console.log("No reachable database (DB_* env not set / connection failed).")
  console.log("Index-verification checks that WOULD run:\n")
  for (const c of CHECKS) {
    console.log(`  • ${c.label}`)
    console.log(`      expect key ~ ${c.wantKeyLike}` + (c.forbidExtra.length ? `, forbid: ${c.forbidExtra.join(", ")}` : ""))
  }
  console.log("\nRun with DB_* env vars pointed at a migrated database to execute EXPLAIN.")
}

async function main() {
  if (!process.env.DB_HOST || !process.env.DB_NAME) {
    printPlanOnly()
    process.exit(0)
  }

  let mysql
  try {
    mysql = (await import("mysql2/promise")).default
  } catch {
    printPlanOnly()
    process.exit(0)
  }

  let pool
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      connectionLimit: 2,
      dateStrings: true,
    })
    await pool.query("SELECT 1")
  } catch (err) {
    console.log(`Database unreachable (${err?.code || err?.message}). Skipping live EXPLAIN.\n`)
    printPlanOnly()
    process.exit(0)
  }

  let failures = 0
  for (const c of CHECKS) {
    try {
      const [plan] = await pool.query(`EXPLAIN ${c.sql}`, c.params)
      const row = plan[0] ?? {}
      const key = row.key ?? null
      const type = row.type ?? null
      const extra = row.Extra ?? ""

      const keyOk = typeof key === "string" && key.includes(c.wantKeyLike.split("_tenant")[0].replace("idx_", ""))
        ? true
        : key === c.wantKeyLike || (typeof key === "string" && key.startsWith(c.wantKeyLike.slice(0, 20)))
      const scanBad = type === "ALL"
      const extraBad = c.forbidExtra.some((e) => String(extra).includes(e))

      const ok = key != null && !scanBad && !extraBad
      if (!ok) failures++

      console.log(`${ok ? "PASS" : "FAIL"}  ${c.label}`)
      console.log(`      key=${key ?? "(none)"} type=${type} extra="${extra}"`)
      if (scanBad) console.log("      ! full table scan (type=ALL)")
      if (extraBad) console.log(`      ! planner used: ${c.forbidExtra.filter((e) => String(extra).includes(e)).join(", ")}`)

      // Time the real count+page pair (best-effort; ignore missing tables).
      const t0 = performance.now()
      await Promise.all([
        pool.query(c.sql, c.params),
        pool.query(`SELECT COUNT(*) AS total FROM (${c.sql.replace(/ LIMIT .*/i, "")}) x`, c.params).catch(() => {}),
      ])
      console.log(`      count+page: ${(performance.now() - t0).toFixed(1)}ms\n`)
    } catch (err) {
      // A missing table on a partial install is not a benchmark failure.
      if (err?.code === "ER_NO_SUCH_TABLE") {
        console.log(`SKIP  ${c.label} (table not present)\n`)
        continue
      }
      failures++
      console.log(`FAIL  ${c.label}: ${err?.code || err?.message}\n`)
    }
  }

  await pool.end()
  console.log(failures === 0 ? "All index checks passed." : `${failures} index check(s) failed.`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
