import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  getCompany360,
  updateCompany,
  archiveCompany,
  restoreCompany,
  mergeCompanies,
  CompanyNotFoundError,
} from "@/lib/sales/company-master"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.view_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const data = await getCompany360(Number(id))
  if (!data) return NextResponse.json({ error: "Company not found" }, { status: 404 })
  return NextResponse.json(data)
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json()

  try {
    if (body.action === "restore") {
      await restoreCompany(Number(id), session.userId)
    } else if (body.action === "merge") {
      if (!body.target_id) return NextResponse.json({ error: "target_id is required" }, { status: 400 })
      await mergeCompanies(Number(id), Number(body.target_id), session.userId)
    } else {
      await updateCompany(Number(id), body, session.userId)
    }
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error("[company-update] failed", error)
    return NextResponse.json({ error: "Unable to update company." }, { status: 500 })
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  try {
    // Soft archive rather than a destructive delete so linked history is kept.
    await archiveCompany(Number(id), session.userId)
    return NextResponse.json({ success: true })
  } catch (error) {
    if (error instanceof CompanyNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    console.error("[company-delete] failed", error)
    return NextResponse.json({ error: "Unable to archive company." }, { status: 500 })
  }
}
