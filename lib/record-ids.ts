import { pool } from "@/lib/db"

const safePrefixes = new Set(["EMP", "INV", "FIN", "GST", "TDS", "JE", "GL", "RPT", "PROJ", "TKT", "CLI", "PROD", "LEAD", "COMP", "MEET", "QUOTE", "CONT", "ONB", "FORE", "REG", "LR", "DOC", "SHIFT", "EXP", "FTE", "FRL", "BTX", "ACC", "LADJ", "LQE", "COA", "CV", "PB", "REQ", "CAM", "CAND", "SCR", "INT", "ASM", "SEL", "SRC", "SET", "LTR", "JOB", "JAP", "ISC", "OFL", "JSK", "LT", "ROT", "RTV", "RSQ", "RTE", "HRE"])

export async function nextRecordId(
  prefix: string,
  opts: { digits?: number; allowCustom?: boolean } = {},
) {
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "")
  // Prefixes coming from configurable company settings may not be in the
  // built-in whitelist, so callers can opt in with allowCustom.
  if (!opts.allowCustom && !safePrefixes.has(normalized)) throw new Error("Unsupported ID prefix")
  if (!normalized) throw new Error("Empty ID prefix")
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
