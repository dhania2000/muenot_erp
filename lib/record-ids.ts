import { pool } from "@/lib/db"

const safePrefixes = new Set(["EMP", "INV", "FIN", "GST", "TDS", "JE", "GL", "RPT", "PROJ", "TKT", "CLI", "PROD", "LEAD", "COMP", "MEET", "QUOTE", "CONT", "ONB", "FORE", "REG", "LR", "DOC", "SHIFT", "EXP", "FTE", "FRL", "BTX", "ACC", "COA", "CV", "PB", "REQ", "CAM", "CAND", "SCR", "INT", "ASM", "SEL", "SRC", "SET"])

export async function nextRecordId(prefix: string) {
  const normalized = prefix.toUpperCase().replace(/[^A-Z0-9]/g, "")
  if (!safePrefixes.has(normalized)) throw new Error("Unsupported ID prefix")
  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    await connection.query("INSERT INTO record_id_sequences (prefix, next_number) VALUES (?, 1) ON DUPLICATE KEY UPDATE next_number = next_number + 1", [normalized])
    const [rows] = await connection.query<any[]>("SELECT next_number FROM record_id_sequences WHERE prefix = ? FOR UPDATE", [normalized])
    const number = Number(rows[0]?.next_number || 1)
    await connection.commit()
    return `${normalized}-${String(number).padStart(4, "0")}`
  } catch (error) {
    await connection.rollback()
    throw error
  } finally {
    connection.release()
  }
}
