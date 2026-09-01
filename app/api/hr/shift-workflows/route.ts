import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

const tables = { requests: "hr_shift_change_requests", assignments: "hr_shift_assignments", rotations: "hr_shift_rotations", sequences: "hr_shift_rotation_sequences", employees: "hr_shift_rotation_employees" } as const
const allowed = new Set(Object.keys(tables))
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
