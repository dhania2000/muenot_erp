import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { parseSpreadsheetDate } from "@/lib/excel-import"
import { getImportConfig, type ImportColumn } from "@/lib/import-configs"

/**
 * Generic, config-driven bulk importer used by every list sub-module. The
 * client (see components/import-button.tsx) maps each spreadsheet row onto the
 * module's canonical column keys and POSTs `{ rows }` here; we coerce types,
 * apply defaults, mint ids, stamp the creating user and insert row by row so a
 * single bad row never fails the whole upload.
 */
function parseNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === "") return null
  const n = Number(String(value).replace(/[^0-9.-]/g, ""))
  return Number.isFinite(n) ? n : null
}

function coerce(col: ImportColumn, raw: unknown) {
  const text = raw === null || raw === undefined ? "" : String(raw).trim()
  if (text === "") return { empty: true as const, value: null }
  if (col.type === "number") return { empty: false as const, value: parseNumber(text) }
  if (col.type === "date") return { empty: false as const, value: parseSpreadsheetDate(text) }
  return { empty: false as const, value: text }
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params
  const config = getImportConfig(key)
  if (!config) return NextResponse.json({ error: "This module does not support importing" }, { status: 400 })

  const session = config.feature ? await requireFeature(config.feature) : await getSession()
  if (!session) {
    return NextResponse.json({ error: config.feature ? "Forbidden" : "Unauthorized" }, {
      status: config.feature ? 403 : 401,
    })
  }

  const body = await req.json().catch(() => ({}))
  const rows = Array.isArray(body?.rows) ? (body.rows as Record<string, unknown>[]) : []
  if (!rows.length) return NextResponse.json({ error: "No rows to import" }, { status: 400 })

  const createdByColumn = config.createdBy === undefined ? "created_by" : config.createdBy
  const today = new Date().toISOString().slice(0, 10)

  // For modules that derive the next code from their own table, seed the
  // counter once and increment locally as rows succeed.
  let counter = 0
  if (config.id?.strategy === "maxSubstring" && config.idColumn) {
    const seeded = await query<{ next: number }[]>(
      `SELECT COALESCE(MAX(CAST(SUBSTRING(${config.idColumn}, ${config.id.substringFrom}) AS UNSIGNED)), 0) + 1 AS next FROM ${config.table}`,
    )
    counter = Number(seeded[0]?.next || 1)
  }

  let imported = 0
  const errors: string[] = []

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]
    const record: Record<string, unknown> = { ...(config.defaults ?? {}) }
    let rowError: string | null = null

    for (const col of config.columns) {
      const { empty, value } = coerce(col, row[col.key])
      if (empty || value === null) {
        if (col.required) {
          rowError = `Row ${index + 2}: ${col.label} is required`
          break
        }
        if (col.default !== undefined) record[col.key] = col.default === "@today" ? today : col.default
        continue
      }
      record[col.key] = value
    }

    if (rowError) {
      errors.push(rowError)
      continue
    }

    try {
      if (config.id && config.idColumn) {
        if (config.id.strategy === "sequence") {
          record[config.idColumn] = await nextRecordId(config.id.prefix, { allowCustom: config.id.allowCustom })
        } else {
          record[config.idColumn] = `${config.id.prefix}${String(counter).padStart(config.id.digits, "0")}`
        }
      }
      if (createdByColumn) record[createdByColumn] = session.userId

      const cols = Object.keys(record)
      if (!cols.length) {
        errors.push(`Row ${index + 2}: no recognizable columns`)
        continue
      }
      await query(
        `INSERT INTO ${config.table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`,
        cols.map((c) => record[c]),
      )
      imported++
    } catch {
      errors.push(`Row ${index + 2}: could not be saved`)
    }
  }

  return NextResponse.json({ imported, failed: errors.length, errors: errors.slice(0, 20) })
}
