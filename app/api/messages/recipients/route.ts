import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
export async function GET() {
  const session = await getSession()
  if (!session || !(await userHasFeature(session.userId, session.role, "messages.view"))) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const users = await query<any[]>("SELECT id,name,email,role FROM users WHERE status='active' AND id<>? ORDER BY name", [session.userId])
  return NextResponse.json({ users })
}
