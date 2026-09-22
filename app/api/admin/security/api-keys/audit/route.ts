import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listApiKeyEvents } from "@/lib/api-keys-store"

// SPEC 52 — Read the immutable API-key audit trail (created / revoked /
// deleted / authenticated / auth_failed), optionally filtered to one key.
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const tenant = getCurrentTenant()
  if (!tenant) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const keyIdRaw = url.searchParams.get("keyId")
  const keyId = keyIdRaw ? Number(keyIdRaw) : undefined
  const events = await listApiKeyEvents(tenant.tenantId, { keyId })
  return NextResponse.json({ events })
}
