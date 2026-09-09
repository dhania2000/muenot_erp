import { put } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

async function allowed() {
  const session = await getSession()
  if (!session) return null
  if (session.role === "admin") return session
  const rows = await query<any[]>(`SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.view_employees' LIMIT 1`, [session.userId])
  return rows.length ? session : null
}

export async function GET(request: Request) {
  const session = await allowed()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const employeeId = new URL(request.url).searchParams.get("employee_id")
  const docs = await query(`SELECT d.*, e.employee_id AS employee_code, e.employee_name, u.name AS verifier_name FROM hr_employee_documents d JOIN hr_employees e ON e.id=d.employee_id LEFT JOIN users u ON u.id=d.verified_by ${employeeId ? "WHERE d.employee_id=?" : ""} ORDER BY d.created_at DESC`, employeeId ? [employeeId] : [])
  return NextResponse.json({ documents: docs })
}

export async function POST(request: Request) {
  const session = await allowed()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const form = await request.formData()
  const employeeId = String(form.get("employee_id") || "")
  const type = String(form.get("document_type") || "")
  const file = form.get("file")
  if (!employeeId || !type) return NextResponse.json({ error: "Employee and document type are required" }, { status: 400 })
  let fileName: string | null = null
  let filePath: string | null = null
  if (file instanceof File && file.size > 0) {
    if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: "File must be 10MB or smaller" }, { status: 400 })
    const blob = await put(`hr-documents/${employeeId}/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`, file, { access: "public", addRandomSuffix: false })
    fileName = file.name
    filePath = blob.url
  }
  await query("INSERT INTO hr_employee_documents (employee_id, document_type, file_name, file_path, status, remarks) VALUES (?, ?, ?, ?, ?, ?)", [employeeId, type, fileName, filePath, String(form.get("status") || "Pending"), String(form.get("remarks") || "") || null])
  return NextResponse.json({ ok: true }, { status: 201 })
}
