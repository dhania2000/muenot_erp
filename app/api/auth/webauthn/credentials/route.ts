import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listCredentials } from "@/lib/webauthn-store"

/** List the signed-in user's own passkeys (tenant-scoped, no secrets exposed). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const tenantId = session.tenantId
  if (tenantId == null) return NextResponse.json({ error: "No tenant in context" }, { status: 403 })

  const credentials = await listCredentials(tenantId, session.userId)
  return NextResponse.json({
    credentials: credentials.map((c) => ({
      id: c.id,
      label: c.label,
      transports: c.transports,
      backedUp: c.backedUp,
      createdAt: c.createdAt,
      lastUsedAt: c.lastUsedAt,
    })),
  })
}
