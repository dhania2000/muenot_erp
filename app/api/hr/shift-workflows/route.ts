import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const tables = { requests: "hr_shift_change_requests", assignments: "hr_shift_assignments", rotations: "hr_shift_rotations", sequences: "hr_shift_rotation_sequences", employees: "hr_shift_rotation_employees" } as const
const allowed = new Set(Object.keys(tables))
// Rotation-owned kinds are managed exclusively through validated services
// (auto-IDs, eligibility, conflict detection, versioning, audit). Generic
// column-level writes here would let a client set record_id/current_sequence/
// status and bypass all of that (§ no raw CRUD), so writes are refused and
// callers are pointed at the dedicated, authorized endpoints.
const rotationManaged: Record<string, string> = {
  rotations: "/api/hr/shift-rotations",
  sequences: "/api/hr/shift-rotations/[id]/versions",
  employees: "/api/hr/rotation-employees",
}
function guardManagedWrite(kind: string) {
  const endpoint = rotationManaged[kind]
  if (!endpoint) return null
  return NextResponse.json(
    { error: `Direct writes to "${kind}" are not allowed. Use ${endpoint}.` },
    { status: 405 },
  )
}
export async function GET(req: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const kind = new URL(req.url).searchParams.get("kind") || "requests"; if (!allowed.has(kind)) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  const rows = await query(`SELECT * FROM ${tables[kind as keyof typeof tables]} ORDER BY id DESC`); return NextResponse.json({ rows })
}
export async function POST(req: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json(); const kind = String(body.kind || "requests"); if (!allowed.has(kind)) return NextResponse.json({ error: "Invalid kind" }, { status: 400 })
  const table = tables[kind as keyof typeof tables]; const data = { ...body }; delete data.kind; delete data.id
  const fields = Object.keys(data).filter((key) => /^[a-z_]+$/.test(key)); if (!fields.length) return NextResponse.json({ error: "No fields" }, { status: 400 })
  const values = fields.map((key) => data[key]); const result: any = await query(`INSERT INTO ${table} (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`, values)
  return NextResponse.json({ id: result.insertId }, { status: 201 })
}
export async function PATCH(req: Request) {
  const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json(); const kind = String(body.kind || "requests"); const id = Number(body.id); if (!allowed.has(kind) || !id) return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  const table = tables[kind as keyof typeof tables]; const data = { ...body }; delete data.kind; delete data.id; const fields = Object.keys(data).filter((key) => /^[a-z_]+$/.test(key)); await query(`UPDATE ${table} SET ${fields.map((key) => `${key}=?`).join(",")} WHERE id=?`, [...fields.map((key) => data[key]), id]); return NextResponse.json({ ok: true })
}
