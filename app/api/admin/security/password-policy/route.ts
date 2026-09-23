import { NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { getPasswordPolicy } from "@/lib/password-policy"
import { setBool, setGlobalSetting } from "@/lib/settings/server"

// Password policy configuration, actually enforced. GET returns the
// live policy every auth code path checks (lib/password-policy.ts); PUT
// persists it into the same settings store, so this screen is no longer a
// disconnected mock.

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const policy = await getPasswordPolicy()
  return NextResponse.json({ policy })
}

export async function PUT(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))

  const minLength = clampInt(body.minLength, 6, 128, 8)
  const expiryDays = clampInt(body.expiryDays, 0, 3650, 90)
  const reuseHistory = clampInt(body.reuseHistory, 0, 24, 5)
  const maxLoginAttempts = clampInt(body.maxLoginAttempts, 1, 20, 5)
  const lockoutDurationMinutes = clampInt(body.lockoutDurationMinutes, 1, 1440, 15)
  const tempPasswordExpiryHours = clampInt(body.tempPasswordExpiryHours, 1, 168, 24)

  await Promise.all([
    setGlobalSetting("security.password_min_length", String(minLength)),
    setBool("security.password_require_case", Boolean(body.requireCase)),
    setBool("security.password_require_number", Boolean(body.requireNumber)),
    setBool("security.password_require_symbol", Boolean(body.requireSymbol)),
    setGlobalSetting("security.password_expiry_days", String(expiryDays)),
    setGlobalSetting("security.password_reuse_history", String(reuseHistory)),
    setGlobalSetting("security.max_login_attempts", String(maxLoginAttempts)),
    setGlobalSetting("security.lockout_duration_minutes", String(lockoutDurationMinutes)),
    setGlobalSetting("security.temp_password_expiry_hours", String(tempPasswordExpiryHours)),
  ])

  const policy = await getPasswordPolicy()
  return NextResponse.json({ policy })
}
