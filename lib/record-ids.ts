import { pool } from "@/lib/db"

const safePrefixes = new Set(["EMP", "INV", "FIN", "GST", "TDS", "JE", "GL", "VCH", "RPT", "PROJ", "TKT", "CLI", "PROD", "LEAD", "COMP", "MEET", "QUOTE", "CONT", "ONB", "FORE", "REG", "LR", "DOC", "SHIFT", "EXP", "FTE", "FRL", "BTX", "ACC", "LADJ", "LQE", "COA", "CV", "VEN", "PB", "REQ", "CAM", "CAND", "SCR", "INT", "ASM", "SEL", "SRC", "SET", "LTR", "JOB", "JAP", "ISC", "OFL", "JSK", "LT", "ROT", "RTV", "RSQ", "RTE", "HRE", "TCH", "TDR", "TCR", "TRM", "BGV", "RFC", "PJT"])

export async function nextRecordId(
  prefix: string,
  opts: { digits?: number; allowCustom?: boolean } = {},
) {
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "")
  // Prefixes coming from configurable company settings may not be in the
  // built-in whitelist, so callers can opt in with allowCustom.
  if (!opts.allowCustom && !safePrefixes.has(normalized)) throw new Error("Unsupported ID prefix")
  if (!normalized) throw new Error("Empty ID prefix")

  // SPEC 92 — Phase 3: route through the centralized numbering engine when the
  // acting tenant has an ACTIVE custom rule for this entity. Returns null (and
  // falls through to the legacy sequence below) when there is no tenant context
  // or no configured rule, so existing id streams are never disturbed.
  try {
    const { tryAllocateForEntity } = await import("@/lib/numbering/engine")
    const centralized = await tryAllocateForEntity(normalized)
    if (centralized) return centralized
  } catch {
    // Never let the engine break a record id — fall back to the legacy path.
  }

  const digits = Math.max(1, Math.min(10, opts.digits ?? 4))
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query("INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1", [normalized])
    const [rows] = await connection.query<any[]>("SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE", [normalized])
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `${normalized}-${String(number).padStart(digits, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
