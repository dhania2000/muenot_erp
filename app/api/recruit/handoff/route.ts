import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listHandoffCandidates } from "@/lib/recruit-integrations-db"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { data, migrationPending } = await listHandoffCandidates()
  return NextResponse.json({ candidates: data, migrationPending })
}
