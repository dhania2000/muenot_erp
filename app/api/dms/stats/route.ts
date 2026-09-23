import { NextResponse } from "next/server"
import { requireDms, isResponse } from "@/lib/dms/request"
import { getDmsStats } from "@/lib/dms"

export const runtime = "nodejs"

export async function GET() {
  const ctx = await requireDms()
  if (isResponse(ctx)) return ctx
  return NextResponse.json({ stats: await getDmsStats() })
}
