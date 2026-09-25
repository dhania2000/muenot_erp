import { NextResponse, type NextRequest } from "next/server"
import { requireAnomaly, isResponse } from "@/lib/ai/anomaly-detection/request"
import { listAlerts, countAlertsByStatus } from "@/lib/ai/anomaly-detection/store"
import {
  normalizeSeverity,
  normalizeStatus,
  ANOMALY_CATEGORIES,
  ALERT_STATUSES,
  SEVERITIES,
  type AnomalyCategory,
} from "@/lib/ai/anomaly-detection/model"

export const dynamic = "force-dynamic"

/** GET — the tenant's risk queue, filterable by status/severity/category/owner. */
export async function GET(req: NextRequest) {
  const ctx = await requireAnomaly()
  if (isResponse(ctx)) return ctx

  const url = new URL(req.url)
  const statusParam = url.searchParams.get("status")
  const severityParam = url.searchParams.get("severity")
  const categoryParam = url.searchParams.get("category")
  const ownerParam = url.searchParams.get("ownerId")
  const limitParam = url.searchParams.get("limit")
  const offsetParam = url.searchParams.get("offset")

  const category =
    categoryParam && (ANOMALY_CATEGORIES as readonly string[]).includes(categoryParam)
      ? (categoryParam as AnomalyCategory)
      : undefined

  const alerts = await listAlerts({
    status: statusParam && (ALERT_STATUSES as readonly string[]).includes(statusParam) ? normalizeStatus(statusParam) : undefined,
    severity: severityParam && (SEVERITIES as readonly string[]).includes(severityParam) ? normalizeSeverity(severityParam) : undefined,
    category,
    ownerId: ownerParam && /^\d+$/.test(ownerParam) ? Number(ownerParam) : undefined,
    limit: limitParam && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined,
    offset: offsetParam && /^\d+$/.test(offsetParam) ? Number(offsetParam) : undefined,
  })
  const counts = await countAlertsByStatus()

  return NextResponse.json({ alerts, counts })
}
