import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { previewAudience } from "@/lib/whatsapp-audiences"

/** Returns the reachable count + a small sample for an audience filter. */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = (await request.json().catch(() => ({}))) as { filter?: unknown }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await previewAudience((body.filter ?? { match: "all", conditions: [] }) as any)
  return NextResponse.json(result)
}
