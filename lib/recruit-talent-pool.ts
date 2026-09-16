import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import {
  listTalentPool,
  setCandidateTalentPool,
  TALENT_POOL_STATUSES,
} from "@/lib/recruit-unification-db"

/**
 * Phase 31: Talent Pool is a CURATED SUBSET of the Candidate Master, stored as
 * flags on the canonical person (recruitment_candidates.in_talent_pool +
 * talent_pool_*), NOT a duplicate candidate table. These handlers replace the
 * generic CRUD factory for the "talent-pool" module so every read/write goes
 * through the single Candidate Master:
 *   - GET    lists flagged candidates (shaped as the module's columns/KPIs)
 *   - POST   moves an existing candidate into the pool (sets the flags)
 *   - PATCH  updates pool status / owner / notes on the candidate
 *   - DELETE removes the candidate from the pool (clears the flag)
 */
export function createTalentPoolHandlers() {
  async function GET(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

    const search = req.nextUrl.searchParams.get("search") || undefined
    const status = req.nextUrl.searchParams.get("status") || undefined
    let rows = await listTalentPool(search)
    if (status) rows = rows.filter((r) => r.pool_status === status)

    const summary = {
      total_rows: rows.length,
      total_available: rows.filter((r) => r.pool_status === "Available").length,
      total_future: rows.filter((r) => r.pool_status === "Future Opportunity").length,
      total_passive: rows.filter((r) => r.pool_status === "Passive").length,
    }
    const statuses = Array.from(
      new Set(rows.map((r) => r.pool_status).filter(Boolean)),
    ).sort() as string[]

    return NextResponse.json({ rows, summary, filterOptions: { statuses } })
  }

  async function POST(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json()

    const candidateId = await setCandidateTalentPool({
      candidate_id: body.candidate_id,
      candidate_name: body.candidate_name,
      email: body.email,
      mobile: body.mobile,
      pool_status: body.pool_status,
      preferred_role: body.preferred_role,
      owner: body.owner,
      next_contact_date: body.next_contact_date,
      notes: body.remarks,
      added_date: body.added_date,
      in_pool: true,
    })
    if (!candidateId) {
      return NextResponse.json(
        { error: "Provide a candidate id, or a name with an email/mobile, to add to the talent pool." },
        { status: 400 },
      )
    }
    return NextResponse.json({ ok: true, id: candidateId }, { status: 201 })
  }

  async function PATCH(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const body = await req.json()
    const candidateId = String(body.candidate_id || body.pool_id || body.id || "").trim()
    if (!candidateId) return NextResponse.json({ error: "candidate_id is required" }, { status: 400 })

    const status =
      body.pool_status && (TALENT_POOL_STATUSES as readonly string[]).includes(body.pool_status)
        ? body.pool_status
        : null
    await query(
      `UPDATE recruitment_candidates SET
         talent_pool_status = COALESCE(?, talent_pool_status),
         talent_pool_role = COALESCE(?, talent_pool_role),
         talent_pool_owner = COALESCE(?, talent_pool_owner),
         talent_pool_next_contact = COALESCE(?, talent_pool_next_contact),
         talent_pool_notes = COALESCE(?, talent_pool_notes)
       WHERE candidate_id = ? AND in_talent_pool = 1`,
      [
        status,
        body.preferred_role || null,
        body.owner || null,
        body.next_contact_date || null,
        body.remarks ?? null,
        candidateId,
      ],
    )
    return NextResponse.json({ ok: true })
  }

  async function DELETE(req: NextRequest) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    const candidateId = String(
      req.nextUrl.searchParams.get("candidate_id") || req.nextUrl.searchParams.get("id") || "",
    ).trim()
    if (!candidateId) return NextResponse.json({ error: "candidate_id is required" }, { status: 400 })
    await query(
      "UPDATE recruitment_candidates SET in_talent_pool = 0, talent_pool_status = NULL WHERE candidate_id = ?",
      [candidateId],
    )
    return NextResponse.json({ ok: true })
  }

  return { GET, POST, PATCH, DELETE }
}
