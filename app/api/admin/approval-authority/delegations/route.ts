import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listDelegations, createDelegation } from "@/lib/approval-authority"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  if (!getCurrentTenant()) return null
  return session
}

export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const delegations = await listDelegations()
  return NextResponse.json({ delegations })
}

export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = (await request.json().catch(() => null)) as {
    fromUserId?: number
    toUserId?: number
    reason?: string | null
    startsAt?: string | null
    endsAt?: string | null
  } | null
  if (!body?.fromUserId || !body?.toUserId)
    return NextResponse.json({ error: "fromUserId and toUserId are required" }, { status: 400 })
  if (body.fromUserId === body.toUserId)
    return NextResponse.json({ error: "Cannot delegate to the same user" }, { status: 400 })

  const id = await createDelegation(
    {
      fromUserId: body.fromUserId,
      toUserId: body.toUserId,
      reason: body.reason ?? null,
      startsAt: body.startsAt ?? null,
      endsAt: body.endsAt ?? null,
    },
    session.userId,
  )
  return NextResponse.json({ id }, { status: 201 })
}
