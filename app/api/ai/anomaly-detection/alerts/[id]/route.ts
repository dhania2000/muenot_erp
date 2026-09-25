import { NextResponse } from "next/server"
import { requireAnomaly, isResponse } from "@/lib/ai/anomaly-detection/request"
import { getAlert, listAlertAudit } from "@/lib/ai/anomaly-detection/store"

export const dynamic = "force-dynamic"

/** GET — a single alert with its full evidence and append-only review trail. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnomaly()
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const alertId = Number(id)
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  const alert = await getAlert(alertId)
  if (!alert) return NextResponse.json({ error: "Alert not found" }, { status: 404 })

  const audit = await listAlertAudit(alertId)
  return NextResponse.json({ alert, audit })
}
