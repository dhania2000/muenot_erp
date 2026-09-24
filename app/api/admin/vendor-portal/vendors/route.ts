import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listVendorDirectory } from "@/lib/vendor-portal/store"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** List vendors a staff user can grant portal access to. */
export async function GET(request: Request) {
  if (!(await requireAdmin())) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const search = new URL(request.url).searchParams.get("search") ?? ""
  const vendors = await listVendorDirectory(search)
  return NextResponse.json({ vendors })
}
