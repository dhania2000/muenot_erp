import { NextResponse, type NextRequest } from "next/server"
import { requireAnomaly, isResponse, serviceError } from "@/lib/ai/anomaly-detection/request"
import { runAnomalyScan, isModelScoringEnabled, isServiceError } from "@/lib/ai/anomaly-detection/service"
import { listScans } from "@/lib/ai/anomaly-detection/store"
import { ANOMALY_CATEGORIES, type AnomalyCategory } from "@/lib/ai/anomaly-detection/model"

export const dynamic = "force-dynamic"

/** GET — recent scan runs plus whether model scoring is currently available. */
export async function GET() {
  const ctx = await requireAnomaly()
  if (isResponse(ctx)) return ctx
  const scans = await listScans(20)
  const modelScoringAvailable = await isModelScoringEnabled()
  return NextResponse.json({ scans, modelScoringAvailable })
}

/**
 * POST — run a fresh anomaly scan for the tenant. Explainable rules always run;
 * model scoring is layered only when the caller opts in AND the platform flag is
 * enabled. Idempotent: re-running collapses onto existing alerts by signature.
 */
export async function POST(req: NextRequest) {
  const ctx = await requireAnomaly({ requireManage: true })
  if (isResponse(ctx)) return ctx

  let body: any = {}
  try {
    const text = await req.text()
    body = text ? JSON.parse(text) : {}
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  let categories: AnomalyCategory[] | undefined
  if (Array.isArray(body?.categories)) {
    categories = body.categories.filter((c: any) => (ANOMALY_CATEGORIES as readonly string[]).includes(c))
    if (categories!.length === 0) categories = undefined
  }

  let windowDays: number | undefined
  if (body?.windowDays !== undefined) {
    const n = Number(body.windowDays)
    if (!Number.isFinite(n)) {
      return NextResponse.json({ error: "windowDays must be a number" }, { status: 400 })
    }
    windowDays = n
  }

  const result = await runAnomalyScan({
    actor: ctx.actor,
    windowDays,
    categories,
    useModelScoring: body?.useModelScoring === true,
  })
  if (isServiceError(result)) return serviceError(result)
  return NextResponse.json(result, { status: 201 })
}
