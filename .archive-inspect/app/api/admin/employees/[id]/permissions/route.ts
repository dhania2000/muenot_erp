import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getUserFeatureSlugs, setUserPermissions } from "@/lib/permissions"
import { query } from "@/lib/db"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const slugs = await getUserFeatureSlugs(Number(id))
  return NextResponse.json({ featureSlugs: slugs })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const { featureIds } = await request.json()
  if (!Array.isArray(featureIds)) {
    return NextResponse.json({ error: "featureIds must be an array" }, { status: 400 })
  }

  const rows = await query<{ role: string }[]>("SELECT role FROM users WHERE id = ? LIMIT 1", [id])
  if (rows[0]?.role === "admin") {
    return NextResponse.json({ error: "Admins already have full access" }, { status: 400 })
  }

  await setUserPermissions(Number(id), featureIds, session.userId)
  return NextResponse.json({ ok: true })
}
