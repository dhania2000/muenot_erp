import "server-only"
import { getGoogleAccount } from "@/lib/google-accounts"
import { isGoogleOAuthConfigured, listCalendarEventsForUser } from "@/lib/google-calendar"
import { istDateOnly } from "./datetime"
import { readErpSources, type SourceWindow } from "./sources"
import type { UnifiedCalendarEvent } from "./types"

/**
 * Central aggregation (spec Phases 2, 14-16, 21, 84-86).
 *
 * Produces the unified, de-duplicated event feed for the signed-in user by
 * combining:
 *   1. The user's own ERP source records (sales/operations/recruitment).
 *   2. The user's Google Calendar events in the same window.
 *
 * Google events that a source record already links to (matched on
 * external_event_id) are dropped from the Google side so a synced ERP meeting
 * appears exactly once — never as a duplicate row.
 */

export type AggregateResult = {
  oauthConfigured: boolean
  connected: boolean
  email: string | null
  events: UnifiedCalendarEvent[]
  /** Present when the Google fetch failed but ERP events still loaded. */
  error?: "sync_failed"
}

export type AggregateOptions = {
  userId: number
  email: string | null
  tenantId?: number | null
  timeMin: string
  timeMax: string
}

export async function aggregateCalendar(opts: AggregateOptions): Promise<AggregateResult> {
  const win: SourceWindow = {
    userId: opts.userId,
    email: opts.email,
    tenantId: opts.tenantId ?? null,
    fromDate: istDateOnly(opts.timeMin),
    toDate: istDateOnly(opts.timeMax),
  }

  // ERP sources never depend on Google being reachable (Phases 54/89).
  const erpEvents = await readErpSources(win)

  const oauthConfigured = isGoogleOAuthConfigured()
  const account = await getGoogleAccount(opts.userId).catch(() => null)

  if (!oauthConfigured || !account) {
    return {
      oauthConfigured,
      connected: Boolean(account),
      email: account?.google_email ?? null,
      events: sortEvents(erpEvents),
    }
  }

  // Ids already represented by an ERP record — used to suppress duplicates.
  const linkedIds = new Set(
    erpEvents.map((e) => e.externalEventId).filter((v): v is string => Boolean(v)),
  )

  let googleEvents: UnifiedCalendarEvent[] = []
  let error: "sync_failed" | undefined
  try {
    const raw = await listCalendarEventsForUser(account.refresh_token, {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
    })
    googleEvents = raw
      .filter((e) => !linkedIds.has(e.id))
      .map((e) => ({
        id: `google:${e.id}`,
        title: e.title,
        start: e.start,
        end: e.end,
        allDay: e.allDay,
        location: e.location,
        description: e.description,
        hangoutLink: e.hangoutLink,
        htmlLink: e.htmlLink,
        status: e.status,
        sourceModule: "google",
        sourceRecordId: e.id,
        category: "Personal",
        organizer: null,
        externalEventId: e.id,
        googleSyncStatus: "Synced",
        href: e.htmlLink,
      }))
  } catch (err: any) {
    console.error("[v0] central calendar Google fetch failed:", err?.message || err)
    error = "sync_failed"
  }

  return {
    oauthConfigured: true,
    connected: true,
    email: account.google_email,
    events: sortEvents([...erpEvents, ...googleEvents]),
    ...(error ? { error } : {}),
  }
}

function sortEvents(events: UnifiedCalendarEvent[]): UnifiedCalendarEvent[] {
  return [...events].sort((a, b) => new Date(a.start).getTime() - new Date(b.start).getTime())
}
