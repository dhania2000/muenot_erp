import "server-only"
import { query } from "@/lib/db"

/**
 * Product audit trail. Every lifecycle event (created, updated, price change,
 * stock adjusted, activated, deactivated, discontinued, imported, exported)
 * lands here with actor, timestamp, old/new value and an optional reason so no
 * change to a product or its stock is unexplained.
 */
export type ProductAuditEntry = {
  productPk?: number | null
  productId?: string | null
  action: string
  field?: string | null
  oldValue?: string | number | null
  newValue?: string | number | null
  reason?: string | null
  userId?: number | null
  userName?: string | null
}

export async function logProductAudit(entry: ProductAuditEntry): Promise<void> {
  try {
    await query(
      `INSERT INTO product_audit
         (product_pk, product_id, action, field, old_value, new_value, reason, user_id, user_name)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        entry.productPk ?? null,
        entry.productId ?? null,
        entry.action,
        entry.field ?? null,
        entry.oldValue == null ? null : String(entry.oldValue),
        entry.newValue == null ? null : String(entry.newValue),
        entry.reason ?? null,
        entry.userId ?? null,
        entry.userName ?? null,
      ],
    )
  } catch (error) {
    // Audit must never abort the primary operation.
    console.log("[v0] product audit failed:", (error as Error).message)
  }
}

export async function listProductAudit(productPk: number): Promise<Record<string, any>[]> {
  return (await query<any[]>(
    `SELECT * FROM product_audit WHERE product_pk = ? ORDER BY created_at DESC, id DESC LIMIT 500`,
    [productPk],
  )) as any[]
}
