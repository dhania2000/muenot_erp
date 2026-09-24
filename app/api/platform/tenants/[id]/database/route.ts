import { type NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { getTenantById, updateTenant } from "@/lib/tenant-service"
import { recordPlatformAudit } from "@/lib/platform-roles"
import { validateRoutingSettings, toDeploymentModel, type RoutingSettingsInput } from "@/lib/tenant-db/model"
import {
  DATA_REGIONS,
  allowedRegionsFor,
  validateRegionPlacement,
  toDataRegion,
  type RegionPlacement,
} from "@/lib/tenant-db/regions"
import {
  ensureRegistryRow,
  getRegionSettings,
  getTenantDbRecord,
  listTenantDbAudit,
  saveRegionSettings,
  saveRoutingSettings,
  type TenantRegionSettings,
} from "@/lib/tenant-db/store"

/**
 * Tenant database routing + data-region console (platform super-admin only).
 * ---------------------------------------------------------------------------
 * GET  — the tenant's current routing registry row, its region residency
 *        settings, the region catalog and the regions its residency anchor
 *        permits, plus a recent slice of the tenant-db audit ledger.
 * PUT  — persist routing settings (deployment model / schema / connection ref /
 *        db region) and/or region residency settings. Both are validated
 *        server-side against the tenant's residency anchor BEFORE any write, so
 *        a residency-violating or malformed configuration is rejected (400) and
 *        never persisted. Routing changes reset provisioning state (handled by
 *        the store) so a re-provision is required before the new target serves.
 *
 * Routing is operated on the PLATFORM axis for a specific target tenant; the
 * tenant id comes from the URL and every action is written to the platform
 * audit log. Connection CREDENTIALS are never accepted here — only a reference
 * to a deployment-managed secret.
 */

function parseTenantId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const tenantId = parseTenantId(id)
  if (tenantId == null) return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })

  const tenant = await getTenantById(tenantId)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 })

  const regions = await getRegionSettings(tenantId)
  // Seed a registry row from the tenant directory so the console always has a
  // concrete routing state to show (idempotent).
  const record = await ensureRegistryRow(tenantId, {
    deploymentModel: tenant.deployment_model,
    schema: tenant.db_schema,
    connectionRef: tenant.db_connection_ref,
    region: regions?.dbRegion ?? null,
  })
  const audit = await listTenantDbAudit(tenantId, 25)

  return NextResponse.json({
    tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, deploymentModel: tenant.deployment_model },
    record,
    regions,
    catalog: DATA_REGIONS,
    allowedRegions: allowedRegionsFor(regions?.dataRegion),
    audit,
  })
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { id } = await params
  const tenantId = parseTenantId(id)
  if (tenantId == null) return NextResponse.json({ error: "Invalid tenant id" }, { status: 400 })

  const tenant = await getTenantById(tenantId)
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const hasRouting = body?.routing !== undefined && body.routing !== null
  const hasRegions = body?.regions !== undefined && body.regions !== null
  if (!hasRouting && !hasRegions) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  const existing = await getRegionSettings(tenantId)
  // The residency anchor that all placement + routing validation is measured
  // against: the newly-submitted data region when present, else the stored one.
  const effectiveDataRegion = hasRegions
    ? (toDataRegion(body.regions?.dataRegion) ?? null)
    : (existing?.dataRegion ?? null)

  // ---- Validate everything BEFORE persisting anything (fail closed) --------
  if (hasRegions) {
    if (body.regions?.dataRegion && toDataRegion(body.regions.dataRegion) == null) {
      return NextResponse.json(
        { error: "Invalid data region", violations: [{ facet: "data_region", message: "Unknown data region." }] },
        { status: 400 },
      )
    }
    const placement: RegionPlacement = {
      dbRegion: body.regions?.dbRegion ?? null,
      storageRegion: body.regions?.storageRegion ?? null,
      backupRegion: body.regions?.backupRegion ?? null,
    }
    const violations = validateRegionPlacement(effectiveDataRegion, placement)
    if (violations.length > 0) {
      return NextResponse.json({ error: "Region residency violation", violations }, { status: 400 })
    }
  }

  if (hasRouting) {
    const routing: RoutingSettingsInput = {
      deploymentModel: body.routing?.deploymentModel,
      schema: body.routing?.schema,
      connectionRef: body.routing?.connectionRef,
      dbRegion: body.routing?.dbRegion,
    }
    const errors = validateRoutingSettings(routing, effectiveDataRegion)
    if (errors.length > 0) {
      return NextResponse.json({ error: "Invalid routing settings", errors }, { status: 400 })
    }
  }

  // ---- Persist -------------------------------------------------------------
  if (hasRegions) {
    const settings: TenantRegionSettings = {
      dataRegion: toDataRegion(body.regions?.dataRegion),
      dbRegion: toDataRegion(body.regions?.dbRegion),
      storageRegion: toDataRegion(body.regions?.storageRegion),
      backupRegion: toDataRegion(body.regions?.backupRegion),
    }
    await saveRegionSettings(tenantId, settings)
  }

  let record = await getTenantDbRecord(tenantId)
  if (hasRouting) {
    const model = toDeploymentModel(body.routing?.deploymentModel)
    record = await saveRoutingSettings(tenantId, {
      deploymentModel: model ?? undefined,
      schema: body.routing?.schema !== undefined ? (body.routing.schema || null) : undefined,
      connectionRef:
        body.routing?.connectionRef !== undefined ? (body.routing.connectionRef || null) : undefined,
      region:
        body.routing?.dbRegion !== undefined
          ? toDataRegion(body.routing.dbRegion)
          : hasRegions
            ? toDataRegion(body.regions?.dbRegion)
            : undefined,
    })
    // Keep the tenant directory's deployment_model in sync with the registry so
    // the roster + other consumers agree with the routing decision.
    if (model && model !== tenant.deployment_model) {
      await updateTenant(tenantId, { deployment_model: model })
    }
  }

  await recordPlatformAudit({
    actorUserId: guard.ctx.userId,
    actorEmail: guard.session.email,
    action: "tenant_db_settings_update",
    targetTenantId: tenantId,
    detail: {
      routing: hasRouting ? body.routing : undefined,
      regions: hasRegions ? body.regions : undefined,
    },
  })

  const regions = await getRegionSettings(tenantId)
  return NextResponse.json({
    record: record ?? (await getTenantDbRecord(tenantId)),
    regions,
    allowedRegions: allowedRegionsFor(regions?.dataRegion),
  })
}
