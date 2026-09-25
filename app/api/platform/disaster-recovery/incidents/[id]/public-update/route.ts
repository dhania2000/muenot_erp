import { NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { validatePublicUpdate } from "@/lib/status/model"
import { publishIncidentUpdate } from "@/lib/status/service"
import { normalizeIdempotencyKey } from "@/lib/support-sla/model"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec28 (#126) — Publish a customer-facing update on an existing DR incident. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const id = Number((await params).id)
  if (!Number.isSafeInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid incident id" }, { status: 400 })
  const body = await req.json().catch(() => null)
  const parsed = validatePublicUpdate(body?.message)
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
  try {
    const { replayed } = await publishIncidentUpdate(
      id,
      parsed.message,
      { userId: guard.session.userId },
      normalizeIdempotencyKey(req.headers.get("idempotency-key")),
    )
    return NextResponse.json({ ok: true, replayed }, { status: replayed ? 200 : 201 })
  } catch (error) {
    const status = (error as { status?: number })?.status
    if (status === 404) return NextResponse.json({ error: "Incident not found" }, { status: 404 })
    console.error("[status] public update failed", error)
    return NextResponse.json({ error: "Unable to publish update" }, { status: 500 })
  }
}
