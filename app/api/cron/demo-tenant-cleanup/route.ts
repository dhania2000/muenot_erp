import { NextResponse } from "next/server"
import { cleanupExpiredDemoTenants } from "@/lib/demo-tenant-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec26 — expire overdue demo clones and purge expired ones. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret ? process.env.NODE_ENV === "production" : request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const summary = await cleanupExpiredDemoTenants(null)
    return NextResponse.json({ ok: summary.failed.length === 0, ...summary })
  } catch {
    return NextResponse.json({ error: "Demo tenant cleanup failed" }, { status: 500 })
  }
}
