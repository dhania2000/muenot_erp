import { head } from "@vercel/blob"
import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const pathname = new URL(request.url).searchParams.get("pathname")
  if (!pathname) return NextResponse.json({ error: "Missing pathname" }, { status: 400 })
  const owned = await query<any[]>("SELECT employee_id FROM hr_employee_documents WHERE file_path=? LIMIT 1", [pathname])
  if (!owned.length) return NextResponse.json({ error: "Not found" }, { status: 404 })

  // Regular employees may only stream files that belong to their own record.
  if (session.role !== "admin") {
    const manages = await query<any[]>(
      `SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.manage_employees' LIMIT 1`,
      [session.userId],
    )
    if (!manages.length) {
      const me = await query<any[]>(
        "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
        [session.email, session.email],
      )
      if (!me.length || Number(me[0].id) !== Number(owned[0].employee_id)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }
    }
  }
  const metadata = await head(pathname).catch(() => null)
  if (!metadata) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const upstream = await fetch(metadata.url)
  if (!upstream.ok || !upstream.body) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": metadata.contentType || "application/octet-stream",
      "Content-Disposition": `inline; filename="${metadata.pathname.split("/").pop()}"`,
      "Cache-Control": "private, no-cache",
    },
  })
}
