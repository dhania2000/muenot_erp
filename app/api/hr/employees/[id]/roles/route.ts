import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getUserRoleIds, listRoles, setUserRoles } from "@/lib/role-store"
import { evaluateProposedRoles, hasBlockingViolation, logSodAudit } from "@/lib/sod"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

type EmployeeLink = {
  id: number
  employee_name: string
  user_id: number | null
  u_role: "admin" | "employee" | null
}

async function loadEmployee(id: string) {
  const rows = await query<EmployeeLink[]>(
    `SELECT e.id, e.employee_name, e.user_id, u.role AS u_role
       FROM hr_employees e
       LEFT JOIN users u ON u.id = e.user_id
      WHERE e.id = ? LIMIT 1`,
    [id],
  )
  return rows[0] ?? null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const emp = await loadEmployee((await params).id)
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })

  const roles = await listRoles(ctx.tenantId)
  const assignedRoleIds = emp.user_id ? await getUserRoleIds(ctx.tenantId, emp.user_id) : []

  return NextResponse.json({
    employee: { id: emp.id, name: emp.employee_name },
    hasLogin: Boolean(emp.user_id),
    isAdminAccount: emp.u_role === "admin",
    roles,
    assignedRoleIds,
  })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const emp = await loadEmployee((await params).id)
  if (!emp) return NextResponse.json({ error: "Employee not found" }, { status: 404 })
  if (!emp.user_id) {
    return NextResponse.json(
      { error: "This employee has no login account yet. Create one before assigning roles." },
      { status: 400 },
    )
  }
  if (emp.u_role === "admin") {
    return NextResponse.json({ error: "Admin accounts already have full access." }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as
    | { roleIds?: unknown; overrideSod?: unknown }
    | null
  if (!body || !Array.isArray(body.roleIds)) {
    return NextResponse.json({ error: "roleIds must be an array" }, { status: 400 })
  }
  const roleIds = body.roleIds.map((r) => Number(r)).filter((n) => Number.isInteger(n) && n > 0)

  // evaluate the duties this assignment WOULD grant before persisting.
  const override = body.overrideSod === true
  const report = await evaluateProposedRoles(emp.user_id, roleIds)
  const blocking = hasBlockingViolation(report.violations)
  if (blocking && !override) {
    await logSodAudit({
      action: "assignment_blocked",
      actorId: ctx.session.userId,
      targetUserId: emp.user_id,
      targetUserName: emp.employee_name,
      summary: `Role assignment blocked — ${report.violations.length} segregation-of-duties conflict(s)`,
      detail: { roleIds, violations: report.violations },
    })
    return NextResponse.json(
      {
        error: "This assignment violates segregation-of-duties policy.",
        sodBlocked: true,
        sodViolations: report.violations,
      },
      { status: 409 },
    )
  }

  await setUserRoles(ctx.tenantId, emp.user_id, roleIds, ctx.session.userId)

  if (report.violations.length > 0) {
    await logSodAudit({
      action: blocking ? "assignment_overridden" : "assignment_blocked",
      actorId: ctx.session.userId,
      targetUserId: emp.user_id,
      targetUserName: emp.employee_name,
      summary: blocking
        ? `Role assignment applied with SoD OVERRIDE — ${report.violations.length} conflict(s) accepted`
        : `Role assignment applied with ${report.violations.length} SoD warning(s)`,
      detail: { roleIds, violations: report.violations, overridden: blocking },
    })
  }

  return NextResponse.json({ ok: true, sodViolations: report.violations })
}
