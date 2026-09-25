import { NextResponse } from "next/server"
import { sweepSlaBreaches } from "@/lib/support-sla/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#127) — Persist response/resolution SLA breaches (each fires once). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret ? process.env.NODE_ENV === "production" : request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, newlyBreached: await sweepSlaBreaches() })
  } catch (error) {
    console.error("[support-sla] sweep failed", error)
    return NextResponse.json({ error: "SLA sweep failed" }, { status: 500 })
  }
}
