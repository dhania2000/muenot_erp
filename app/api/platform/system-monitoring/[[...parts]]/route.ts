import { NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { addAlert, auditMonitor, dashboard, getIncident, getLog, health, listAlerts, listIncidents, listLogs, positiveId, rangeHours, setAlertEnabled, settings, updateIncident, updateSettings } from "@/lib/system-monitoring-store"
import { redactString } from "@/lib/system-monitoring-core"
import { monitorLogger } from "@/lib/system-monitoring"

export const dynamic = "force-dynamic"
type Context = { params: Promise<{ parts?: string[] }> }
const denied = (guard: { status: number; reason: string }, request: Request) => {
  monitorLogger.warning({ service: "security", component: "system_monitoring", operation: "authorization", errorCode: "MONITORING_ACCESS_DENIED", message: "Unauthorized monitoring access rejected", route: new URL(request.url).pathname, method: request.method, httpStatus: guard.status, requestId: request.headers.get("x-request-id") || undefined })
  return NextResponse.json({ error: guard.reason }, { status: guard.status })
}
const failed = () => NextResponse.json({ error: "Monitoring operation failed" }, { status: 500 })

export async function GET(request: Request, context: Context) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return denied(guard, request)
  const [resource, idText] = (await context.params).parts || []
  const params = new URL(request.url).searchParams
  try {
    if (resource === "dashboard") return NextResponse.json(await dashboard(rangeHours(params.get("hours"))))
    if (resource === "logs") {
      if (idText) { const id = positiveId(idText); if (!id) return NextResponse.json({ error: "Invalid ID" }, { status: 400 }); const row = await getLog(id); return row ? NextResponse.json(row) : NextResponse.json({ error: "Not found" }, { status: 404 }) }
      return NextResponse.json(await listLogs(params))
    }
    if (resource === "incidents") {
      if (idText) { const id = positiveId(idText); if (!id) return NextResponse.json({ error: "Invalid ID" }, { status: 400 }); const row = await getIncident(id); return row ? NextResponse.json(row) : NextResponse.json({ error: "Not found" }, { status: 404 }) }
      return NextResponse.json(await listIncidents(params))
    }
    if (resource === "health") return NextResponse.json(await health())
    if (resource === "alerts") return NextResponse.json(await listAlerts())
    if (resource === "settings") return NextResponse.json(await settings())
    if (resource === "export") {
      const filters = new URLSearchParams(params)
      filters.set("limit", "100")
      const rows = (await listLogs(filters)).items
      const columns = ["id", "created_at", "environment", "severity", "service", "operation", "error_code", "message", "tenant_id", "request_id", "correlation_id"]
      const csvCell = (value: unknown) => {
        const safe = redactString(String(value ?? ""))
        const formulaSafe = /^[=+\-@]/.test(safe) ? `'${safe}` : safe
        return `"${formulaSafe.replace(/"/g, '""')}"`
      }
      const csv = [columns.join(","), ...rows.map((row: any) => columns.map((key) => csvCell(row[key])).join(","))].join("\r\n")
      await auditMonitor(guard.session.userId, "export_logs", "system_logs", `${rows.length} rows`)
      return new Response(csv, { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": "attachment; filename=system-logs.csv", "Cache-Control": "no-store" } })
    }
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  } catch (error) {
    if (error instanceof Error && /^Invalid /.test(error.message)) return NextResponse.json({ error: error.message }, { status: 400 })
    return failed()
  }
}

export async function POST(request: Request, context: Context) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return denied(guard, request)
  const [resource, idText, operation] = (await context.params).parts || []
  let input: Record<string, unknown>
  try { input = await request.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  try {
    if (resource === "incidents" && operation === "action") {
      const id = positiveId(idText || null)
      if (!id) return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
      const action = String(input.action || "")
      const updated = await updateIncident(id, guard.session.userId, action, typeof input.note === "string" ? input.note : undefined, input.value)
      return updated ? NextResponse.json({ ok: true }) : NextResponse.json({ error: "Not found" }, { status: 404 })
    }
    if (resource === "settings") { await updateSettings(input); await auditMonitor(guard.session.userId, "update_settings", "system_monitor_settings"); return NextResponse.json({ ok: true }) }
    if (resource === "alerts" && idText) {
      const id = positiveId(idText)
      if (!id || typeof input.enabled !== "boolean") return NextResponse.json({ error: "Invalid alert update" }, { status: 400 })
      const updated = await setAlertEnabled(id, input.enabled)
      if (!updated) return NextResponse.json({ error: "Not found" }, { status: 404 })
      await auditMonitor(guard.session.userId, "set_alert_enabled", "system_alert_rules", String(id))
      return NextResponse.json({ ok: true })
    }
    if (resource === "alerts") { await addAlert(input); await auditMonitor(guard.session.userId, "add_alert", "system_alert_rules"); return NextResponse.json({ ok: true }) }
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  } catch (error) {
    if (error instanceof Error && /^Invalid |^No valid |^Note is too long/.test(error.message)) return NextResponse.json({ error: error.message }, { status: 400 })
    return failed()
  }
}
