import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { ensurePermissionSchema, getUserMatrix, setUserMatrix } from "@/lib/permission-store"
import { defaultMatrix, PERMISSION_MODULES, type PermissionMatrix } from "@/lib/permission-model"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

type EmployeeLink = {
  id: number
  employee_name: string
  user_id: number | null
  u_id: number | null
  u_name: string | null
  u_email: string | null
  u_role: "admin" | "employee" | null
}

async function loadEmployee(id: string) {
  await ensurePermissionSchema()
  const rows = await query<EmployeeLink[]>(
    `SELECT e.id, e.employee_name, e.user_id,
            u.id AS u_id, u.name AS u_name, u.email AS u_email, u.role AS u_role
     FROM hr_employees e
     LEFT JOIN users u ON u.id = e.user_id
     WHERE e.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const emp = await loadEmployee(id)
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  const linkedUser = emp.u_id
    ? { id: emp.u_id, name: emp.u_name, email: emp.u_email, role: emp.u_role }
    : null

  // Start from a fully-populated "none" matrix, then overlay saved values.
  const matrix = defaultMatrix("none")
  if (emp.user_id) {
    const saved = await getUserMatrix(emp.user_id)
    if (saved) for (const key of Object.keys(saved)) matrix[key] = { ...matrix[key], ...saved[key] }
  }

  return NextResponse.json({
    employee: { id: emp.id, name: emp.employee_name },
    linkedUser,
    isAdminAccount: emp.u_role === "admin",
    matrix,
  })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const emp = await loadEmployee(id)
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  if (!emp.user_id) {
    return NextResponse.json(
      { error: "This employee has no login account yet. Create one before assigning permissions." },
      { status: 400 },
    )
  }
  if (emp.u_role === "admin") {
    return NextResponse.json({ error: "Admin accounts already have full access." }, { status: 400 })
  }

  const body = (await request.json()) as { matrix?: PermissionMatrix }
  if (!body.matrix || typeof body.matrix !== "object") {
    return NextResponse.json({ error: "matrix is required" }, { status: 400 })
  }

  // Only persist known modules.
  const clean: PermissionMatrix = {}
  for (const mod of PERMISSION_MODULES) {
    const p = body.matrix[mod.key]
    if (p) clean[mod.key] = p
  }

  await setUserMatrix(emp.user_id, clean, session.userId)
  return NextResponse.json({ ok: true })
}
