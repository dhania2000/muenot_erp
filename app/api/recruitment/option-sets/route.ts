import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { nextRecordIdForPrefix } from "@/lib/settings/numbering"
import { RECRUITMENT_OPTION_SETS } from "@/lib/recruitment-option-sets"

/**
 * Phase 51 — Settings-driven dropdown values.
 *
 * Returns the active options for every configurable Recruitment master list,
 * keyed by option-set key (see lib/recruitment-option-sets.ts). The generic
 * form dialog uses this to populate selects marked with `optionsCategory`.
 *
 * On first use per process it idempotently seeds each category's built-in
 * defaults into `recruitment_settings`, so the lists show up in the existing
 * Recruitment Settings UI and can be edited/extended/deactivated there. A
 * category with no active rows falls back to its built-in defaults.
 */

let seeded = false

async function seedDefaults() {
  if (seeded) return
  for (const { category, defaults } of Object.values(RECRUITMENT_OPTION_SETS)) {
    for (const opt of defaults) {
      const [exists] = (await query(
        `SELECT id FROM recruitment_settings WHERE setting_category = ? AND setting_name = ? LIMIT 1`,
        [category, opt],
      )) as any[]
      if (exists) continue
      const settingId = await nextRecordIdForPrefix("SET")
      await query(
        `INSERT INTO recruitment_settings
           (setting_id, setting_category, setting_name, setting_value, description, active)
         VALUES (?, ?, ?, ?, ?, 'YES')`,
        [settingId, category, opt, opt, `${category} option`],
      )
    }
  }
  seeded = true
}

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Best-effort seed — a seeding failure must never break the dropdowns.
  try {
    await seedDefaults()
  } catch (e) {
    console.error("[recruit-option-sets] seed failed", e)
  }

  const sets: Record<string, string[]> = {}
  for (const [key, { category, defaults }] of Object.entries(RECRUITMENT_OPTION_SETS)) {
    let opts: string[] = []
    try {
      const rows = (await query(
        `SELECT COALESCE(NULLIF(setting_value, ''), setting_name) AS opt
           FROM recruitment_settings
          WHERE setting_category = ?
            AND COALESCE(active, 'YES') <> 'NO'
            AND COALESCE(NULLIF(setting_value, ''), setting_name) IS NOT NULL
          ORDER BY id ASC`,
        [category],
      )) as any[]
      opts = rows.map((r) => String(r.opt)).filter(Boolean)
    } catch (e) {
      console.error(`[recruit-option-sets] read failed for ${category}`, e)
    }
    // Dedupe while preserving order; fall back to built-in defaults.
    sets[key] = opts.length ? Array.from(new Set(opts)) : defaults
  }

  return NextResponse.json({ sets })
}
