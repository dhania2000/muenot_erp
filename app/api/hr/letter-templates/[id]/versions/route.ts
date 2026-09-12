import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listVersions } from "@/lib/hr-letters-templates"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const versions = await listVersions(Number(id))
  return NextResponse.json({ versions })
}
