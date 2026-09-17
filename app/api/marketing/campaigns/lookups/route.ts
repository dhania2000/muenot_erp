import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureCampaignSchema } from "@/lib/marketing/campaigns-db"
import { getAllTags } from "@/lib/marketing/contacts-db"
import { hasConnectedMailbox } from "@/lib/email"

export const runtime = "nodejs"

/**
 * Reference data for the campaign builder: segments (with live member counts),
 * contact tags, the shared email templates, active team members, and whether
 * the current user has their own mailbox connected.
 */
export async function GET() {
  await ensureCampaignSchema()
  const session = await requireFeature("marketing.campaigns.view")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [segments, tags, templates, users, mailboxConnected] = await Promise.all([
    query<any[]>(
      `SELECT s.id, s.name, s.type, s.color,
              (SELECT COUNT(*) FROM marketing_segment_members m WHERE m.segment_id = s.id) AS member_count
         FROM marketing_segments s WHERE s.archived_at IS NULL ORDER BY s.name ASC LIMIT 500`,
    ).catch(() => []),
    getAllTags().catch(() => []),
    query<any[]>(
      `SELECT id, name, subject, body FROM sales_email_templates WHERE status = 'Active' ORDER BY name ASC LIMIT 500`,
    ).catch(() => []),
    query<any[]>(`SELECT id, name, email FROM users WHERE status = 'active' ORDER BY name ASC LIMIT 500`).catch(() => []),
    hasConnectedMailbox(session.userId).catch(() => false),
  ])

  return NextResponse.json({ segments, tags, templates, users, mailboxConnected })
}
