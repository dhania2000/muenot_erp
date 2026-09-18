import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listStorageAudit } from "@/lib/storage/connection-store"

export const runtime = "nodejs"

export async function GET() {
  const s = await getSession()
  if (!s || s.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const entries = await listStorageAudit(50)
  return NextResponse.json({ entries })
}
