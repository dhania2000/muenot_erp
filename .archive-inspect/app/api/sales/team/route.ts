import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

// Lightweight lookup used to populate "assigned to" pickers across the Sales
// module. Any authenticated user can read team member names.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const users = await query(
    `SELECT id, name FROM users WHERE status = 'active' ORDER BY name ASC`,
  )
  return NextResponse.json({ users })
}
