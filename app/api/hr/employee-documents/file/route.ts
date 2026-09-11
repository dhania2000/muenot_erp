import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { getUserMatrix } from "@/lib/permission-store"

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const url = new URL(request.url)
  const pathname = url.searchParams.get("pathname")
  const asDownload = url.searchParams.get("download") === "1"
  if (!pathname) return NextResponse.json({ error: "Missing pathname" }, { status: 400 })

  const rows = await query<any[]>(
    "SELECT employee_id, file_name, file_mime, file_data FROM hr_employee_documents WHERE file_path=? LIMIT 1",
    [pathname],
  )
  if (!rows.length || !rows[0].file_data) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const doc = rows[0]

  // Regular employees may only stream files that belong to their own record,
  // unless they manage documents for everyone (matrix "all" or legacy grant).
  if (session.role !== "admin") {
    const matrix = await getUserMatrix(session.userId)
    const docPerm = matrix?.["hr.documents"]
    let managesAll = !!docPerm && (docPerm.view === "all" || docPerm.add === "all" || docPerm.update === "all")
    if (!managesAll && !matrix) {
      const manages = await query<any[]>(
        `SELECT 1 FROM user_permissions up JOIN features f ON f.id=up.feature_id WHERE up.user_id=? AND f.slug='hr.manage_employees' LIMIT 1`,
        [session.userId],
      )
      managesAll = manages.length > 0
    }
    if (!managesAll) {
      const me = await query<any[]>(
        "SELECT id FROM hr_employees WHERE official_email = ? OR personal_email = ? LIMIT 1",
        [session.email, session.email],
      )
      if (!me.length || Number(me[0].id) !== Number(doc.employee_id)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 })
      }
    }
  }

  const body = new Uint8Array(doc.file_data as Buffer)
  const safeName = String(doc.file_name || "document").replace(/"/g, "")
  return new NextResponse(body, {
    headers: {
      "Content-Type": doc.file_mime || "application/octet-stream",
      "Content-Disposition": `${asDownload ? "attachment" : "inline"}; filename="${safeName}"`,
      "Cache-Control": "private, no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  })
}
