import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { findDuplicates, resolveReference } from "@/lib/references/service"
import { effectiveConfig } from "@/lib/references/store"
import { isReferenceType, type ReferenceType } from "@/lib/references/model"

export const dynamic = "force-dynamic"

/**
 * SPEC 93 — reference duplicate check + cross-reference lookup.
 *
 * POST { mode: "duplicate", docType, refType, value, excludeDocumentId? }
 *   → the effective policy plus any existing documents that already carry the
 *     same value (the pre-save duplicate probe).
 *
 * POST { mode: "resolve", value, docType?, refType? }
 *   → every document that carries the value across reference types (the
 *     console's cross-reference lookup).
 */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const mode = String(body?.mode ?? "duplicate")
  const value = String(body?.value ?? "")

  try {
    if (mode === "resolve") {
      const refType = isReferenceType(String(body?.refType)) ? (body.refType as ReferenceType) : undefined
      const docType = body?.docType ? String(body.docType) : undefined
      const matches = await resolveReference(value, { docType, refType })
      return NextResponse.json({ matches })
    }

    // Default: duplicate probe for a specific (document, reference) pair.
    const refTypeRaw = String(body?.refType ?? "")
    if (!isReferenceType(refTypeRaw)) {
      return NextResponse.json({ error: "A valid refType is required" }, { status: 400 })
    }
    const refType = refTypeRaw as ReferenceType
    const docType = String(body?.docType ?? "")
    if (!docType) return NextResponse.json({ error: "docType is required" }, { status: 400 })

    const config = await effectiveConfig(docType, refType)
    const duplicates = await findDuplicates(docType, refType, value, {
      excludeDocumentId: body?.excludeDocumentId ? String(body.excludeDocumentId) : undefined,
    })
    return NextResponse.json({ policy: config.duplicate, duplicates })
  } catch (err) {
    console.error("[admin/reference-numbers/check] failed:", err)
    return NextResponse.json({ error: "Reference check failed" }, { status: 500 })
  }
}
