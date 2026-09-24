import { NextResponse } from "next/server"
import { requireCustomDomainAdmin } from "@/lib/custom-domain-access"
import { createDomain, listDomains, DomainConflictError, DomainValidationError } from "@/lib/custom-domain-store"
import { DOMAIN_CNAME_TARGET, TLS_ARCHITECTURE } from "@/lib/custom-domain"

export async function GET() {
  const access = await requireCustomDomainAdmin()
  if (!access.ok) return access.response
  const domains = await listDomains()
  return NextResponse.json({ domains, cnameTarget: DOMAIN_CNAME_TARGET, tls: TLS_ARCHITECTURE })
}

export async function POST(request: Request) {
  const access = await requireCustomDomainAdmin()
  if (!access.ok) return access.response

  const body = (await request.json().catch(() => null)) as { hostname?: string } | null
  const hostname = body?.hostname
  if (typeof hostname !== "string" || !hostname.trim()) {
    return NextResponse.json({ error: "A domain name is required." }, { status: 400 })
  }

  try {
    const domain = await createDomain(hostname, access.actor.userId)
    return NextResponse.json({ domain }, { status: 201 })
  } catch (err) {
    if (err instanceof DomainValidationError) return NextResponse.json({ error: err.message }, { status: 400 })
    if (err instanceof DomainConflictError) return NextResponse.json({ error: err.message }, { status: 409 })
    throw err
  }
}
