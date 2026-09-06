import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listCandidates } from "@/lib/recruit-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const candidates = await listCandidates()
  return NextResponse.json({ candidates })
}
