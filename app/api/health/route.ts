import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * Liveness probe.
 *
 * Answers "is this process up and able to serve HTTP?" with no dependency
 * checks, so a transient database outage does not cause the orchestrator to
 * kill and restart healthy nodes (that is the readiness probe's job). Always
 * 200 while the process can respond.
 */
export async function GET() {
  return NextResponse.json(
    { status: "ok", uptime: Math.round(process.uptime()), timestamp: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  )
}
