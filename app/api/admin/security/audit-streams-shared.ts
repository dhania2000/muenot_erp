import { NextResponse } from "next/server"
import { StreamAccessError, type RetentionAnnotated } from "@/lib/audit-streams-model"

/**
 * Shared HTTP helpers for the separated audit-stream routes (Spec47). Both the
 * tenant-facing route (app/api/admin/security/audit-streams) and the platform
 * route (app/api/platform/security/audit-streams) project the SAME normalized
 * records, so CSV rendering and error mapping live here once.
 */

/** Columns emitted for a CSV export, in stable order. */
const CSV_COLUMNS: ReadonlyArray<keyof RetentionAnnotated> = [
  "occurredAt",
  "stream",
  "source",
  "sourceId",
  "tenantId",
  "actorUserId",
  "actorName",
  "actorEmail",
  "subject",
  "action",
  "outcome",
  "entityType",
  "entityId",
  "ipAddress",
  "userAgent",
  "integrity",
  "legalHold",
  "detail",
]

function csvCell(value: unknown): string {
  if (value == null) return ""
  const raw = typeof value === "object" ? JSON.stringify(value) : String(value)
  // Always quote and escape so embedded commas, quotes or newlines can't break
  // the row structure (CSV injection is further defused by the leading-quote rule).
  const escaped = raw.replace(/"/g, '""')
  const guarded = /^[=+\-@]/.test(escaped) ? `'${escaped}` : escaped
  return `"${guarded}"`
}

/** Render already-masked export records to CSV. Records arrive pre-masked from the store. */
export function exportToCsv(records: ReadonlyArray<RetentionAnnotated>): string {
  const header = CSV_COLUMNS.join(",")
  const lines = records.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(","))
  return [header, ...lines].join("\r\n")
}

/** Map a thrown error to a JSON response, honoring StreamAccessError status codes. */
export function streamErrorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof StreamAccessError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  console.error(`[audit-streams] ${fallback}`, error)
  return NextResponse.json({ error: fallback }, { status: 500 })
}
