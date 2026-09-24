import { NextResponse } from "next/server"
import { requireCustomDomainAdmin } from "@/lib/custom-domain-access"
import { setDomainActive, DomainValidationError } from "@/lib/custom-domain-store"

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireCustomDomainAdmin()
  if (!access.ok) return access.response

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid domain id." }, { status: 400 })

  const body = (await request.json().catch(() => null)) as { active?: boolean } | null
  const active = body?.active !== false // default to activate

  try {
    const domain = await setDomainActive(id, active)
    if (!domain) return NextResponse.json({ error: "Domain not found." }, { status: 404 })
    return NextResponse.json({ domain })
  } catch (err) {
    if (err instanceof DomainValidationError) return NextResponse.json({ error: err.message }, { status: 409 })
    throw err
  }
}
