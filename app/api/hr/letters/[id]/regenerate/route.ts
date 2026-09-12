import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { regenerateLetter } from "@/lib/hr-letters-generate"

// POST /api/hr/letters/:id/regenerate
// Produces a fresh version from the current template + source data and cancels
// the previous one (lineage preserved via supersedes/superseded_by).
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const result = await regenerateLetter(Number(id), session.userId)
  if (!result.ok) {
    return NextResponse.json({ error: result.error, missing: result.missing }, { status: result.code || 400 })
  }
  return NextResponse.json({ letter: result.letter }, { status: 201 })
}
