import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"
import { ensureTaskSchema } from "@/lib/tasks/schema"
import { TASK_STATUSES, TASK_PRIORITIES, TASK_TYPES, RECURRENCE_OPTIONS } from "@/lib/tasks/model"

/**
 * Lookup data for the task UI: assignable users and teams (org units) for the
 * acting tenant, plus the enum vocabularies. Scoped to the tenant so a picker
 * can never surface another organization's people.
 */
export async function GET(_req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureTaskSchema()
  const tenantId = currentTenantId()

  const users = await query<any[]>(
    `SELECT id, name, email FROM users WHERE tenant_id = ? AND status <> 'inactive' ORDER BY name ASC`,
    [tenantId],
  ).catch(async () =>
    query<any[]>(`SELECT id, name, email FROM users WHERE tenant_id = ? ORDER BY name ASC`, [tenantId]),
  )

  // Teams come from the org-unit hierarchy when present; degrade gracefully.
  const teams = await query<any[]>(
    `SELECT id, name FROM org_units WHERE tenant_id = ? ORDER BY name ASC LIMIT 200`,
    [tenantId],
  ).catch(() => [])

  return NextResponse.json({
    users,
    teams,
    statuses: TASK_STATUSES,
    priorities: TASK_PRIORITIES,
    types: TASK_TYPES,
    recurrences: RECURRENCE_OPTIONS,
  })
}
