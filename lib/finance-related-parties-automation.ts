import "server-only"
import { identifyRelatedPartyTransactions } from "@/lib/finance-related-parties"
import {
  claimReminderKey,
  emitReminder,
  financeRecipients,
  todayIso,
} from "@/lib/finance-automation-shared"

/**
 * Phase 11 — Related Party automatic transaction identification.
 *
 * Related Parties is a disclosure master, so this sweep posts nothing. It runs
 * the existing scanner (lib/finance-related-parties.identifyRelatedPartyTransactions)
 * that matches every Finance transaction back to an Active related party, then
 * flags the ones that are NEWLY identified since the last run and raises a single
 * deduped in-app summary so the disclosure register (AS 18 / Ind AS 24) stays
 * current.
 *
 * Duplicate prevention: each identified transaction claims a permanent per-txn
 * dedup key (`rp-txn:<source>:<reference>`), so it is counted as "new" exactly
 * once ever; the summary notification itself is keyed to the run day, so a
 * repeat run on the same day never re-notifies.
 */

const FEATURE = "related-parties"
const LINK = "/modules/finance/related-parties"

export type RelatedPartyScanResult = {
  ran_at: string
  as_of: string
  scanned: number
  newly_identified: number
  notifications: number
}

export async function runRelatedPartyScan(): Promise<RelatedPartyScanResult> {
  const asOf = todayIso()
  const result = await identifyRelatedPartyTransactions()
  const rows = result.rows

  // Silently claim a permanent key per transaction; a fresh claim marks it as
  // newly identified. This is the duplicate guard — an already-seen transaction
  // never counts twice.
  const newlyIdentified: typeof rows = []
  for (const r of rows) {
    const key = `rp-txn:${r.source}:${r.reference}`
    const fresh = await claimReminderKey(key)
    if (fresh) newlyIdentified.push(r)
  }

  let notifications = 0
  if (newlyIdentified.length > 0) {
    const parties = Array.from(new Set(newlyIdentified.map((r) => r.related_party))).slice(0, 5)
    const total = newlyIdentified.reduce((s, r) => s + Number(r.amount || 0), 0)
    const amount = Math.round((total + Number.EPSILON) * 100) / 100
    const partyList = parties.join(", ")
    const more = newlyIdentified.length > parties.length ? " and others" : ""
    const recipients = await financeRecipients(FEATURE)

    notifications = await emitReminder(
      {
        key: `rp-summary:${asOf}`,
        type: "finance-related-party",
        title: `${newlyIdentified.length} new related-party transaction${
          newlyIdentified.length === 1 ? "" : "s"
        } identified`,
        body: `Involving ${partyList}${more} — total ${amount.toLocaleString("en-IN", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}. Review the related-party disclosure register.`,
        link: LINK,
        entityType: "related_parties",
        entityId: asOf,
      },
      recipients,
    )
  }

  return {
    ran_at: new Date().toISOString(),
    as_of: asOf,
    scanned: rows.length,
    newly_identified: newlyIdentified.length,
    notifications,
  }
}
