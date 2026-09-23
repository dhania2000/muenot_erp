import { NextResponse } from "next/server"
import { getReadiness } from "@/lib/health"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * SPEC 77 — Readiness probe.
 *
 * Answers "should the load balancer send this node traffic right now?" Returns
 * 503 when a critical dependency (the database) is unreachable so the node is
 * drained from rotation, and 200 once it can serve requests. Exposes only
 * booleans, latencies, and short status strings — never secrets.
 */
export async function GET() {
  const report = await getReadiness()
  return NextResponse.json(report, {
    status: report.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  })
}
