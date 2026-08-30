import { NextResponse } from "next/server"
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

export const dynamic = "force-dynamic"

type EnvRow = { id: number; name: string; category: string; is_secret: number; value_encrypted: Buffer; updated_at: string }

function key() {
  const secret = process.env.SETTINGS_ENCRYPTION_KEY
  if (!secret) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured")
  return createHash("sha256").update(secret).digest()
}
function encrypt(value: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key(), iv)
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64")
}
function decrypt(value: Buffer | string) {
  const payload = Buffer.from(value)
  const decipher = createDecipheriv("aes-256-gcm", key(), payload.subarray(0, 32))
  decipher.setAuthTag(payload.subarray(12, 28))
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8")
}
async function admin() {
  const session = await getSession()
  return session?.role === "admin" ? session : null
}
async function ensureTable() {
  await query(`CREATE TABLE IF NOT EXISTS environment_variables (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, category VARCHAR(80) NOT NULL DEFAULT 'General', value_encrypted BLOB NOT NULL, is_secret TINYINT(1) NOT NULL DEFAULT 1, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`)
}
function present(row: EnvRow) {
  const value = decrypt(row.value_encrypted)
  return { id: row.id, name: row.name, category: row.category, isSecret: Boolean(row.is_secret), maskedValue: row.is_secret ? "••••••••" : value, value: row.is_secret ? undefined : value, updatedAt: row.updated_at }
}

export async function GET() {
  if (!(await admin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try { await ensureTable(); const rows = await query<EnvRow[]>("SELECT * FROM environment_variables ORDER BY category, name"); return NextResponse.json(rows.map(present)) }
  catch (error) { console.error("[v0] env GET failed", error); return NextResponse.json({ error: "Unable to load environment variables" }, { status: 500 }) }
}

export async function POST(request: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try {
    const body = await request.json(); const name = String(body.name || "").trim(); const value = String(body.value || ""); const category = String(body.category || "General").trim() || "General"; const isSecret = body.isSecret !== false
    if (!/^[A-Z][A-Z0-9_]{1,119}$/.test(name) || !value) return NextResponse.json({ error: "Use a valid variable name and non-empty value" }, { status: 400 })
    await ensureTable(); await query("INSERT INTO environment_variables (name, category, value_encrypted, is_secret) VALUES (?, ?, ?, ?)", [name, category, encrypt(value), isSecret ? 1 : 0]); return NextResponse.json({ ok: true }, { status: 201 })
  } catch (error: any) { return NextResponse.json({ error: error?.code === "ER_DUP_ENTRY" ? "Variable already exists" : "Unable to save variable" }, { status: error?.code === "ER_DUP_ENTRY" ? 409 : 500 }) }
}

export async function PATCH(request: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try { const body = await request.json(); const id = Number(body.id); const value = String(body.value || ""); const category = String(body.category || "General").trim() || "General"; if (!Number.isInteger(id) || !value) return NextResponse.json({ error: "Invalid variable" }, { status: 400 }); await ensureTable(); await query("UPDATE environment_variables SET value_encrypted = ?, category = ?, is_secret = ? WHERE id = ?", [encrypt(value), category, body.isSecret === false ? 0 : 1, id]); return NextResponse.json({ ok: true }) }
  catch { return NextResponse.json({ error: "Unable to update variable" }, { status: 500 }) }
}

export async function DELETE(request: Request) {
  if (!(await admin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  try { const id = Number(new URL(request.url).searchParams.get("id")); if (!Number.isInteger(id)) return NextResponse.json({ error: "Invalid variable" }, { status: 400 }); await ensureTable(); await query("DELETE FROM environment_variables WHERE id = ?", [id]); return NextResponse.json({ ok: true }) }
  catch { return NextResponse.json({ error: "Unable to delete variable" }, { status: 500 }) }
}

export { decrypt }
export async function getStoredEnvironmentVariable(name: string) { await ensureTable(); const rows = await query<EnvRow[]>("SELECT * FROM environment_variables WHERE name = ? LIMIT 1", [name]); return rows[0] ? decrypt(rows[0].value_encrypted) : undefined }
