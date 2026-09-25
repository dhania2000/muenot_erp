import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import {
  listSecurityAlerts,
  getSecurityAlertSummary,
  updateAlertStatus,
  type SecurityAlertStatus,
  type SecurityAlertType,
} from "@/lib/security-alerts-store"

const STATUSES: SecurityAlertStatus[] = ["open", "acknowledged", "resolved"]
const TYPES: SecurityAlertType[] = [
  "failed_login_burst",
  "new_admin",
  "role_escalation",
  "api_key_created",
  "breached_password",
  "critical_compromise",
]

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

export async function GET(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const statusParam = url.searchParams.get("status")
  const typeParam = url.searchParams.get("type")
  const status = statusParam && STATUSES.includes(statusParam as SecurityAlertStatus)
    ? (statusParam as SecurityAlertStatus)
    : undefined
  const type = typeParam && TYPES.includes(typeParam as SecurityAlertType)
    ? (typeParam as SecurityAlertType)
    : undefined

  const [alerts, summary] = await Promise.all([
    listSecurityAlerts(ctx.tenantId, { status, type }),
    getSecurityAlertSummary(ctx.tenantId),
  ])
  return NextResponse.json({ alerts, summary })
}

/** Triage: acknowledge or resolve an alert. Tenant-scoped by the store. */
export async function POST(request: Request) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    alertId?: unknown
    status?: unknown
  } | null

  const alertId = Number(body?.alertId)
  const status = body?.status
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return NextResponse.json({ error: "A valid alertId is required." }, { status: 400 })
  }
  if (status !== "acknowledged" && status !== "resolved") {
    return NextResponse.json({ error: "status must be 'acknowledged' or 'resolved'." }, { status: 400 })
  }

  const ok = await updateAlertStatus(ctx.tenantId, alertId, status, ctx.session.userId)
  if (!ok) {
    return NextResponse.json({ error: "Alert not found or already resolved." }, { status: 404 })
  }
  return NextResponse.json({ ok: true })
}
