import { NextResponse } from "next/server"
import { requireCustomDomainAdmin } from "@/lib/custom-domain-access"
import { verifyDomain } from "@/lib/custom-domain-store"

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireCustomDomainAdmin()
  if (!access.ok) return access.response

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid domain id." }, { status: 400 })

  const domain = await verifyDomain(id)
  if (!domain) return NextResponse.json({ error: "Domain not found." }, { status: 404 })
  return NextResponse.json({ domain })
}
