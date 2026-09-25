import { NextRequest, NextResponse } from "next/server"
import { requirePlatformStaff, requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { getTenantById, listTenants } from "@/lib/tenant-service"
import { toBackupScope } from "@/lib/backup/model"
import {
  type BackupActor,
  createAndRunBackup,
  getOffsiteStatus,
  listBackupRuns,
  listPolicies,
  listRestoreTests,
  upsertPolicy,
} from "@/lib/backup/store"
import { summarizeRecoveryPosture } from "@/lib/backup/offsite-model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function parseTenantId(value: string | null): number | null {
  if (!value || value === "all" || value === "baseline") return null
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(req: NextRequest) {
  const guard = await requirePlatformStaff()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = parseTenantId(req.nextUrl.searchParams.get("tenantId"))
  try {
    const [policies, runs, restoreTests, tenants] = await Promise.all([
      listPolicies(tenantId),
      listBackupRuns(tenantId, 100),
      listRestoreTests(tenantId, 50),
      listTenants(),
    ])
    return NextResponse.json({
      tenantId,
      policies,
      runs,
      restoreTests,
      tenants: tenants.map((t) => ({ id: t.id, name: t.name, slug: t.slug, status: t.status })),
    })
  } catch (error) {
    console.error("[backups] read failed", error)
    return NextResponse.json({ error: "Unable to load backups" }, { status: 500 })
  }
}

/** Run a backup now for a specific tenant + scope. */
export async function POST(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const scope = toBackupScope(body?.scope)
  const tenantId = Number(body?.tenantId)
  if (!scope) return NextResponse.json({ error: "A valid backup scope is required" }, { status: 400 })
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    return NextResponse.json({ error: "A valid target tenant is required" }, { status: 400 })
  }
  const tenant = await getTenantById(tenantId).catch(() => null)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 })

  const actor: BackupActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const run = await createAndRunBackup({ scope, tenantId, triggerSource: "manual", verifyAfter: true }, actor)
    return NextResponse.json({ ok: true, run })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Backup failed" },
      { status: 400 },
    )
  }
}

/** Create / update a backup policy for a (tenant, scope). tenantId null = baseline. */
export async function PATCH(req: NextRequest) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const body = await req.json().catch(() => null)
  const scope = toBackupScope(body?.scope)
  if (!scope) return NextResponse.json({ error: "A valid backup scope is required" }, { status: 400 })
  if (!body?.config || typeof body.config !== "object") {
    return NextResponse.json({ error: "A policy configuration is required" }, { status: 400 })
  }
  const tenantId = parseTenantId(body?.tenantId == null ? null : String(body.tenantId))
  if (tenantId != null) {
    const tenant = await getTenantById(tenantId).catch(() => null)
    if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 })
  }

  const actor: BackupActor = { userId: guard.session.userId, name: guard.session.name, email: guard.session.email }
  try {
    const policy = await upsertPolicy(tenantId, scope, body.config, actor)
    return NextResponse.json({ ok: true, policy })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to update policy" },
      { status: 400 },
    )
  }
}
