import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { ensureEmailTables } from "@/lib/email"

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.send_emails")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  await ensureEmailTables()

  const rows = await query<any[]>(
    `SELECT e.id, e.lead_id, e.template_id, e.to_email, e.to_name, e.subject, e.body,
            e.status, e.open_count, e.first_opened_at, e.last_opened_at, e.error_message,
            e.sent_at, e.thread_id, u.name AS sent_by_name, l.contact_person AS lead_contact
     FROM sales_emails e
     LEFT JOIN users u ON u.id = e.sent_by
     LEFT JOIN sales_leads l ON l.id = e.lead_id
     WHERE e.id = ? LIMIT 1`,
    [id],
  )
  const email = rows[0]
  if (!email) return NextResponse.json({ error: "Email not found" }, { status: 404 })

  // Per-open activity log for this email (one row per pixel hit).
  const events = await query(
    `SELECT id, event_type, user_agent, ip_address, created_at
     FROM sales_email_events
     WHERE email_id = ?
     ORDER BY created_at DESC`,
    [id],
  )

  // The full conversation: every email sharing this thread_id, oldest first.
  const thread = email.thread_id
    ? await query(
        `SELECT id, subject, status, open_count, sent_at, to_email, last_opened_at
         FROM sales_emails
         WHERE thread_id = ?
         ORDER BY sent_at ASC, id ASC`,
        [email.thread_id],
      )
    : []

  return NextResponse.json({ email, events, thread })
}
