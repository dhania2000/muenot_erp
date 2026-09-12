import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema, listRotations } from "@/lib/hr-shift-rotations"

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return new Response("Unauthorized", { status: 401 })
  await ensureShiftRotationSchema()
  const allowed =
    session.role === "admin" ||
    (await userHasFeature(session.userId, session.role, "hr.view_shift_rotations")) ||
    (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))
  if (!allowed) return new Response("Forbidden", { status: 403 })

  const sp = new URL(request.url).searchParams
  const rotations = await listRotations({
    q: (sp.get("q") || "").trim() || undefined,
    status: sp.get("status") || undefined,
    cycleType: sp.get("cycle_type") || undefined,
    state: sp.get("state") || undefined,
  })

  const header = [
    "Rotation ID", "Name", "Cycle", "Status", "Effective From", "Effective Until",
    "Active Members", "Total Members", "Version", "Created By", "Created At",
  ]
  const lines = [header.map(csvCell).join(",")]
  for (const r of rotations) {
    lines.push(
      [
        r.rotation_id,
        r.rotation_name,
        `${r.cycle_length} ${r.cycle_type}`,
        r.status,
        String(r.effective_from).slice(0, 10),
        r.effective_until ? String(r.effective_until).slice(0, 10) : "",
        r.active_members,
        r.total_members,
        `v${r.current_version_no}`,
        r.created_by_name || "",
        r.created_at ? String(r.created_at).slice(0, 19).replace("T", " ") : "",
      ].map(csvCell).join(","),
    )
  }

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="shift-rotations-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  })
}
