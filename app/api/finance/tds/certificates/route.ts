import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  previewCertificates,
  generateCertificates,
  listCertificates,
  type CertificateForm,
  type TdsQuarter,
} from "@/lib/finance-tds-compliance"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}
function formOf(value: unknown): CertificateForm {
  return String(value) === "16" ? "16" : "16A"
}
function quarterOf(value: unknown): TdsQuarter | undefined {
  const s = String(value)
  return s === "Q1" || s === "Q2" || s === "Q3" || s === "Q4" ? s : undefined
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const params = req.nextUrl.searchParams
  const direction = dirOf(params.get("direction"))
  const fy = params.get("fy") || undefined
  const preview = params.get("preview")
  try {
    if (preview && fy) {
      const data = await previewCertificates({
        formType: formOf(params.get("form")),
        direction,
        quarter: quarterOf(params.get("quarter")),
        financialYear: fy,
      })
      return NextResponse.json({ preview: data })
    }
    return NextResponse.json({ certificates: await listCertificates(direction, fy) })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "issue_certificate")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  try {
    const result = await generateCertificates({
      formType: formOf(body.form),
      direction: dirOf(body.direction),
      quarter: quarterOf(body.quarter),
      financialYear: String(body.fy || ""),
      actorId: session.userId,
    })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}
