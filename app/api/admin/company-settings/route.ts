import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import {
  MASKED_SECRET,
  getEffectiveTenantSettings,
  getTenantSettingDefinition,
  getTenantSettingsAudit,
  getTenantSettingsPublic,
  listTenantSettingDefinitions,
  setTenantSettings,
} from "@/lib/tenant-settings"
import { invalidateSettingsCache } from "@/lib/settings/server"

const secretKeys = new Set(
  listTenantSettingDefinitions().filter((definition) => definition.secret).map((definition) => definition.key),
)

function forbidden(result: { status: number; reason: string }) {
  return NextResponse.json({ error: result.reason }, { status: result.status })
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return forbidden(guard)
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  try {
    const values = await getEffectiveTenantSettings(tenantId)
    const publicTenant = await getTenantSettingsPublic(tenantId)
    const audit = await getTenantSettingsAudit(50, tenantId)
    const allSecretKeys = new Set([...secretKeys, ...publicTenant.secretKeys])
    for (const key of allSecretKeys) {
      if (values[key]) values[key] = MASKED_SECRET
    }
    return NextResponse.json({
      values,
      meta: { scope: "tenant", tenantId, overriddenKeys: publicTenant.overriddenKeys, inherited: true, audit },
    })
  } catch (error) {
    console.error("[company-settings] read failed", error)
    return NextResponse.json({ error: "Unable to load tenant settings" }, { status: 500 })
  }
}

export async function POST(req: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return forbidden(guard)
  const tenantId = effectiveTenantId(guard.ctx)
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const body = await req.json().catch(() => null)
  if (!body || typeof body.values !== "object" || body.values === null || Array.isArray(body.values)) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 })
  }

  const values = { ...(body.values as Record<string, unknown>) }
  // A masked value means “leave the existing secret untouched”.
  for (const [key, value] of Object.entries(values)) {
    if (getTenantSettingDefinition(key)?.secret && value === MASKED_SECRET) delete values[key]
  }

  try {
    const result = await setTenantSettings(values, guard.session.userId, tenantId)
    invalidateSettingsCache(tenantId)
    return NextResponse.json({ ok: true, tenantId, saved: result.saved, cleared: result.cleared })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to save tenant settings"
    if (/Unknown setting|must be|has an invalid|too long|SETTINGS_ENCRYPTION_KEY/.test(message)) {
      return NextResponse.json({ error: message }, { status: 400 })
    }
    console.error("[company-settings] write failed", error)
    return NextResponse.json({ error: "Unable to save tenant settings" }, { status: 500 })
  }
}
