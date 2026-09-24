import { type NextRequest, NextResponse } from "next/server"
import { requireTenantAdmin } from "@/lib/platform-guard"
import { listConfigs, saveConfig, deleteConfig } from "@/lib/references/store"
import { REFERENCE_TYPES, DUPLICATE_POLICIES, DOCUMENT_TYPES } from "@/lib/references/model"

export const dynamic = "force-dynamic"

/**
 * SPEC 93 — Reference Number Management admin API.
 * GET  → the document catalogue, reference-type and duplicate-policy vocab, and
 *        the tenant's current effective configuration matrix.
 */
export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  try {
    const documents = await listConfigs()
    return NextResponse.json({
      documents,
      catalogue: DOCUMENT_TYPES.map((d) => ({ docType: d.docType, label: d.label, module: d.module })),
      referenceTypes: REFERENCE_TYPES,
      duplicatePolicies: DUPLICATE_POLICIES,
    })
  } catch (err) {
    console.error("[admin/reference-numbers] list failed:", err)
    return NextResponse.json({ error: "Failed to load reference configuration" }, { status: 500 })
  }
}

/** POST → create or update one (document, reference) configuration. */
export async function POST(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  try {
    const result = await saveConfig(
      {
        docType: String(body?.docType ?? ""),
        refType: String(body?.refType ?? ""),
        enabled: body?.enabled,
        required: body?.required,
        duplicate: body?.duplicate,
      },
      guard.session.userId ?? null,
    )
    if (!result.ok) return NextResponse.json({ error: result.errors.join(" ") }, { status: 400 })
    return NextResponse.json({ ok: true, config: result.config })
  } catch (err) {
    console.error("[admin/reference-numbers] save failed:", err)
    return NextResponse.json({ error: "Failed to save reference configuration" }, { status: 500 })
  }
}

/** DELETE → revert one (document, reference) config to its catalogue default. */
export async function DELETE(req: NextRequest) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })

  const { searchParams } = new URL(req.url)
  const docType = searchParams.get("docType") ?? ""
  const refType = searchParams.get("refType") ?? ""
  if (!docType || !refType) {
    return NextResponse.json({ error: "docType and refType are required" }, { status: 400 })
  }

  try {
    const removed = await deleteConfig(docType, refType)
    return NextResponse.json({ ok: true, removed })
  } catch (err) {
    console.error("[admin/reference-numbers] delete failed:", err)
    return NextResponse.json({ error: "Failed to revert reference configuration" }, { status: 500 })
  }
}
