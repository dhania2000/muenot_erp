import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { query } from "@/lib/db"
import { invalidateSettingsCache } from "@/lib/settings/server"
import {
  CAREERS_KEYS,
  careersContentToValues,
  resolveCareersContent,
  type CareersContent,
} from "@/lib/careers-content"

const CAREERS_SKEYS = Object.values(CAREERS_KEYS)

async function ensureTable() {
  await query(
    `CREATE TABLE IF NOT EXISTS company_settings (
      skey VARCHAR(160) NOT NULL PRIMARY KEY,
      svalue TEXT DEFAULT NULL,
      updated_by BIGINT UNSIGNED DEFAULT NULL,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`,
  )
  // Widen svalue so inline data-URL images (used when no Blob storage is
  // connected) are not truncated by TEXT's ~64KB limit. Safe to run repeatedly.
  try {
    await query("ALTER TABLE company_settings MODIFY svalue MEDIUMTEXT DEFAULT NULL")
  } catch {}
}

// GET — return the current (effective) careers content for the editor.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureTable()
  const rows = await query<any[]>(
    `SELECT skey, svalue FROM company_settings WHERE skey IN (${CAREERS_SKEYS.map(() => "?").join(",")})`,
    CAREERS_SKEYS,
  )
  const map: Record<string, string> = {}
  for (const r of rows) map[r.skey] = r.svalue ?? ""
  return NextResponse.json({ content: resolveCareersContent(map) })
}

// POST — save edited careers content (recruiters/admins only).
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const canManage =
    session.role === "admin" || (await userHasFeature(session.userId, session.role, "recruitment.view_jobs"))
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  if (!body || typeof body.content !== "object" || body.content === null) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  await ensureTable()
  const values = careersContentToValues(body.content as Partial<CareersContent>)
  const entries = Object.entries(values)
  for (const [key, value] of entries) {
    await query(
      "INSERT INTO company_settings (skey, svalue, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE svalue=VALUES(svalue), updated_by=VALUES(updated_by)",
      [key, value == null ? "" : String(value), session.userId],
    )
  }
  invalidateSettingsCache()
  return NextResponse.json({ ok: true, saved: entries.length })
}
