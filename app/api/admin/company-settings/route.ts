import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { companySettingsSections } from "@/lib/company-settings-config"

// Keys that must never be returned in plain text.
const secretKeys = new Set(
  companySettingsSections.flatMap((s) => s.fields.filter((f) => f.secret).map((f) => f.key)),
)

async function ensureTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS company_settings (
      skey VARCHAR(160) NOT NULL PRIMARY KEY,
      svalue TEXT DEFAULT NULL,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  )
}

async function guard() {
  const s = await getSession()
  return s?.role === "admin" ? s : null
}

export async function GET() {
  if (!(await guard())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  await ensureTable()
  const rows = await query<any[]>("SELECT skey, svalue FROM company_settings")
  const values: Record<string, string> = {}
  for (const r of rows) {
    values[r.skey] = secretKeys.has(r.skey) && r.svalue ? "••••••••" : (r.svalue ?? "")
  }
  return NextResponse.json({ values })
}

export async function POST(req: Request) {
  const s = await guard()
  if (!s) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => null)
  if (!body || typeof body.values !== "object" || body.values === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }
  await ensureTable()
  const entries = Object.entries(body.values as Record<string, unknown>)
  for (const [key, value] of entries) {
    if (typeof key !== "string" || key.length > 160) continue
    // Skip masked secret values so we never overwrite a stored secret with dots.
    if (secretKeys.has(key) && value === "••••••••") continue
    const v = value == null ? "" : String(value)
    await query(
      "INSERT INTO company_settings (skey, svalue, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_by=VALUES(updated_by)",
      [key, v, s.userId],
    )
  }
  return NextResponse.json({ ok: true, saved: entries.length })
}
