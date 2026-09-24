import { NextResponse } from "next/server"
import { requireCustomDomainAdmin } from "@/lib/custom-domain-access"
import { deleteDomain } from "@/lib/custom-domain-store"

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireCustomDomainAdmin()
  if (!access.ok) return access.response

  const id = parseId((await params).id)
  if (id == null) return NextResponse.json({ error: "Invalid domain id." }, { status: 400 })

  const removed = await deleteDomain(id)
  if (!removed) return NextResponse.json({ error: "Domain not found." }, { status: 404 })
  return NextResponse.json({ ok: true })
}
