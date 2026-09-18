import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { query } from "@/lib/db"
import { listRoles } from "@/lib/role-store"

/**
 * Form data for the rule builder: the modules that can raise approvals, plus
 * the users / roles / entities / departments an approver target can point at.
 * All tenant-scoped through the verified session.
 */
export async function GET() {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenant = getCurrentTenant()
  if (!tenant) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = tenant.tenantId

  const [users, roles, entities, departments] = await Promise.all([
    query<any[]>(`SELECT id, name, email FROM users WHERE tenant_id = ? ORDER BY name ASC`, [tenantId]).catch(() =>
      query<any[]>(`SELECT id, name, email FROM users ORDER BY name ASC`),
    ),
    listRoles(tenantId).catch(() => []),
    query<any[]>(
      `SELECT id, name FROM legal_entities WHERE tenant_id = ? ORDER BY name ASC`,
      [tenantId],
    ).catch(() => []),
    query<any[]>(
      `SELECT DISTINCT department_name AS name FROM hr_departments WHERE status = 'Active' ORDER BY department_name ASC`,
    ).catch(() => [] as any[]),
  ])

  return NextResponse.json({
    modules: APPROVAL_MODULES,
    users: users.map((u) => ({ id: Number(u.id), name: u.name, email: u.email })),
    roles: roles.map((r: any) => ({ id: Number(r.id), name: r.name })),
    entities: entities.map((e) => ({ id: Number(e.id), name: e.name })),
    departments: departments.map((d) => d.name).filter(Boolean),
    dynamicApprovers: DYNAMIC_APPROVERS,
  })
}

/** Business surfaces that raise approvals. Extend as modules are wired in. */
export const APPROVAL_MODULES = [
  { key: "*", label: "Any module (fallback)" },
  { key: "finance.expenses", label: "Finance — Expense claims" },
  { key: "finance.payments", label: "Finance — Payments" },
  { key: "finance.purchase_bills", label: "Finance — Purchase bills" },
  { key: "operations.approvals", label: "Operations — Approvals" },
  { key: "hr.leave", label: "HR — Leave requests" },
  { key: "hr.promotions", label: "HR — Promotions" },
  { key: "sales.quotations", label: "Sales — Quotations" },
  { key: "procurement.purchase_orders", label: "Procurement — Purchase orders" },
]

export const DYNAMIC_APPROVERS = [
  { value: "requester_manager", label: "Requester's manager" },
  { value: "department_head", label: "Department head" },
  { value: "entity_owner", label: "Legal entity owner" },
]
