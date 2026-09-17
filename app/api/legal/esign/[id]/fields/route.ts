import { type NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { replaceFields, getEsignRequest, logEsignEvent } from "@/lib/legal-esign"
import type { FieldType } from "@/lib/legal-esign-shared"

export const runtime = "nodejs"

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("legal.manage_esign")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const req = await getEsignRequest(Number(id))
  if (!req) return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (["Completed", "Cancelled", "Rejected", "Expired"].includes(req.status)) {
    return NextResponse.json({ error: `Fields cannot be changed on a ${req.status} request` }, { status: 409 })
  }
  const body = await request.json().catch(() => ({}))
  const raw = Array.isArray(body.fields) ? body.fields : []
  const signerIds = new Set((req.signers || []).map((s) => s.id))
  const fields = raw
    .filter((f: any) => signerIds.has(Number(f.signerId)))
    .map((f: any) => ({
      signerId: Number(f.signerId),
      fieldType: (f.fieldType as FieldType) || "signature",
      page: Number(f.page) || 1,
      x: clamp01(Number(f.x)),
      y: clamp01(Number(f.y)),
      width: clampRange(Number(f.width), 0.03, 0.9, 0.22),
      height: clampRange(Number(f.height), 0.02, 0.5, 0.06),
      value: f.value ?? null,
    }))
  await replaceFields(Number(id), fields)
  await logEsignEvent({
    requestId: Number(id),
    type: "fields_updated",
    summary: `Signature field layout updated (${fields.length} field${fields.length === 1 ? "" : "s"})`,
    actorId: session.userId,
    actorName: session.name ?? null,
  })
  const updated = await getEsignRequest(Number(id))
  return NextResponse.json({ request: updated })
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}
function clampRange(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(min, Math.min(max, n))
}
