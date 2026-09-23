import { NextResponse } from "next/server"
import { cleanupBatch } from "@/lib/system-monitoring-store"

export const runtime = "nodejs"
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try { return NextResponse.json({ ok: true, removed: await cleanupBatch(1000) }) }
  catch { return NextResponse.json({ error: "Retention failed" }, { status: 500 }) }
}
