import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { currentTenantIdOrNull } from "@/lib/tenant-scope"
import { getTenantStorage } from "@/lib/storage"
import { getProviderDefinition } from "@/lib/storage/providers"
import { logStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

/**
 * Storage health checkup — runs the full diagnostic battery against the
 * workspace's ACTIVE storage (a connected bucket, or the managed platform
 * storage when none is active) so an admin can verify uploads will work
 * without opening the connection editor.
 */
export async function GET() {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenantId = currentTenantIdOrNull()
  if (!tenantId) return NextResponse.json({ error: "No tenant in context" }, { status: 400 })

  const { provider, connection } = await getTenantStorage()
  const target = connection
    ? `${connection.name} (${getProviderDefinition(connection.provider)?.label ?? connection.provider})`
    : "Managed platform storage (default)"

  try {
    const report = await provider.diagnose()
    const passed = report.checks.filter((c) => c.status === "pass").length
    const failed = report.checks.filter((c) => c.status === "fail")
    const summary = report.ok
      ? `All checks passed (${passed}/${report.checks.length})`
      : `${failed.length} check(s) failed: ${failed.map((c) => c.label).join(", ")}`

    await logStorageAudit(report.ok ? "health_check_passed" : "health_check_failed", {
      connectionId: connection?.id ?? null,
      detail: `${target}: ${summary}`.slice(0, 500),
      userId: session.userId,
    })

    return NextResponse.json({ ok: report.ok, message: summary, target, report })
  } catch (err: any) {
    const message = err?.message || "Health check failed"
    return NextResponse.json({ ok: false, error: String(message).slice(0, 300), target }, { status: 200 })
  }
}
