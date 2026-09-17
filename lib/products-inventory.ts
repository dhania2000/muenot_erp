import "server-only"
import { pool, query } from "@/lib/db"
import type { PoolConnection } from "mysql2/promise"

/**
 * Stock movement engine.
 *
 * Every quantity change flows through `applyStockMovement`, which is the ONLY
 * place `products.current_stock` is mutated. It runs inside a transaction and
 * takes a row-level lock (`SELECT ... FOR UPDATE`) so two concurrent movements
 * can never compute stock from the same stale value (Phase 70). Each movement
 * writes an immutable `inventory_ledger` row that ties the new quantity back to
 * its source document (Phase 71), and the ledger's unique key on
 * (reference_type, reference_id, product_pk, movement_type) makes document
 * postings idempotent — re-posting the same invoice never double-counts.
 */

export type MovementType =
  | "Opening"
  | "Purchase"
  | "Sale"
  | "Purchase Return"
  | "Sales Return"
  | "Adjustment"
  | "Transfer"

export type StockMovementInput = {
  productPk: number
  quantity: number // signed: positive = stock in, negative = stock out
  movementType: MovementType
  movementDate?: string | null
  reference?: string | null
  referenceType?: string | null
  referenceId?: string | null
  unitCost?: number | null
  notes?: string | null
  userId?: number | null
  allowNegative?: boolean
}

export class InsufficientStockError extends Error {
  constructor(
    message: string,
    public available: number,
    public requested: number,
  ) {
    super(message)
    this.name = "InsufficientStockError"
  }
}

async function isNegativeAllowed(): Promise<boolean> {
  const rows = (await query<any[]>(
    `SELECT setting_value FROM product_settings WHERE setting_key = 'negative_stock_allowed' LIMIT 1`,
  )) as any[]
  return String(rows?.[0]?.setting_value ?? "0") === "1"
}

/**
 * Apply a single stock movement atomically. When `conn` is supplied the caller
 * owns the transaction; otherwise a dedicated transaction is opened here.
 * Returns the ledger row id and the resulting quantity, or null when the
 * movement was a no-op (product not tracked, zero quantity, or already applied
 * for this idempotent source).
 */
export async function applyStockMovement(
  input: StockMovementInput,
  conn?: PoolConnection,
): Promise<{ afterQty: number; ledgerId: number } | null> {
  const owned = !conn
  const connection = conn ?? (await pool.getConnection())
  const negativeAllowed = input.allowNegative ?? (await isNegativeAllowed())
  try {
    if (owned) await connection.beginTransaction()

    const [rows] = await connection.query<any[]>(
      `SELECT id, current_stock, track_inventory, product_type, product_id
         FROM products WHERE id = ? FOR UPDATE`,
      [input.productPk],
    )
    const product = rows?.[0]
    if (!product) {
      if (owned) await connection.rollback()
      return null
    }
    // Services / non-stock products never carry inventory.
    if (Number(product.track_inventory) !== 1) {
      if (owned) await connection.commit()
      return null
    }

    const qty = Number(input.quantity)
    if (!Number.isFinite(qty) || qty === 0) {
      if (owned) await connection.commit()
      return null
    }

    const before = Number(product.current_stock)
    const after = Number((before + qty).toFixed(3))

    if (after < 0 && !negativeAllowed) {
      throw new InsufficientStockError(
        `Insufficient stock for ${product.product_id}: ${before} available, ${Math.abs(qty)} requested.`,
        before,
        Math.abs(qty),
      )
    }

    // Idempotent document postings: INSERT IGNORE against the unique source key.
    // A no-op insert (already posted) leaves stock untouched.
    const [ins] = await connection.query<any>(
      `INSERT IGNORE INTO inventory_ledger
         (product_pk, product_id, movement_date, movement_type, reference, reference_type,
          reference_id, quantity, before_qty, after_qty, unit_cost, notes, user_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        input.productPk,
        product.product_id,
        input.movementDate || new Date().toISOString().slice(0, 10),
        input.movementType,
        input.reference ?? null,
        input.referenceType ?? null,
        input.referenceId ?? null,
        qty,
        before,
        after,
        input.unitCost ?? 0,
        input.notes ?? null,
        input.userId ?? null,
      ],
    )
    if (Number(ins?.affectedRows ?? 0) === 0) {
      // Already posted for this source — do not move stock again.
      if (owned) await connection.commit()
      return null
    }

    await connection.query(`UPDATE products SET current_stock = ? WHERE id = ?`, [after, input.productPk])

    if (owned) await connection.commit()
    return { afterQty: after, ledgerId: Number(ins?.insertId ?? 0) }
  } catch (error) {
    if (owned) await connection.rollback().catch(() => {})
    throw error
  } finally {
    if (owned) connection.release()
  }
}

/**
 * Reverse (delete + restore) every ledger movement previously posted for a
 * source document, then optionally re-post fresh lines. Used when a Purchase
 * Bill / Sales Invoice is edited or cancelled so stock always reflects the
 * current document state. All within one transaction + row locks.
 */
export async function reverseDocumentStock(
  referenceType: string,
  referenceId: string,
  conn?: PoolConnection,
): Promise<void> {
  const owned = !conn
  const connection = conn ?? (await pool.getConnection())
  try {
    if (owned) await connection.beginTransaction()
    const [ledgers] = await connection.query<any[]>(
      `SELECT * FROM inventory_ledger WHERE reference_type = ? AND reference_id = ?`,
      [referenceType, referenceId],
    )
    for (const l of ledgers) {
      const [rows] = await connection.query<any[]>(
        `SELECT current_stock FROM products WHERE id = ? FOR UPDATE`,
        [l.product_pk],
      )
      if (!rows?.[0]) continue
      const before = Number(rows[0].current_stock)
      const after = Number((before - Number(l.quantity)).toFixed(3))
      await connection.query(`UPDATE products SET current_stock = ? WHERE id = ?`, [after, l.product_pk])
    }
    await connection.query(
      `DELETE FROM inventory_ledger WHERE reference_type = ? AND reference_id = ?`,
      [referenceType, referenceId],
    )
    if (owned) await connection.commit()
  } catch (error) {
    if (owned) await connection.rollback().catch(() => {})
    throw error
  } finally {
    if (owned) connection.release()
  }
}

export type DocumentStockLine = {
  productPk?: number | null
  product_pk?: number | null
  quantity?: any
  rate?: any
  unit_cost?: any
}

/**
 * Post stock for a whole transaction document (Purchase Bill, Sales Invoice,
 * or their returns). Lines without a linked product are ignored so mixed
 * product / free-text documents keep working. Direction is decided by
 * movementType. Idempotent + transactional; aggregates duplicate product lines.
 */
export async function syncDocumentStock(opts: {
  referenceType: string
  referenceId: string
  reference?: string | null
  movementType: MovementType
  movementDate?: string | null
  lines: DocumentStockLine[]
  userId?: number | null
}): Promise<{ moved: number }> {
  const sign =
    opts.movementType === "Purchase" || opts.movementType === "Sales Return" ? 1 : -1

  // Aggregate by product so a product appearing on two lines posts once.
  const byProduct = new Map<number, { qty: number; cost: number }>()
  for (const line of opts.lines) {
    const pk = Number(line.productPk ?? line.product_pk ?? 0)
    if (!pk) continue
    const qty = Number(line.quantity)
    if (!Number.isFinite(qty) || qty <= 0) continue
    const cost = Number(line.unit_cost ?? line.rate ?? 0) || 0
    const prev = byProduct.get(pk) || { qty: 0, cost }
    prev.qty += qty
    prev.cost = cost || prev.cost
    byProduct.set(pk, prev)
  }
  if (byProduct.size === 0) return { moved: 0 }

  const connection = await pool.getConnection()
  try {
    await connection.beginTransaction()
    // Re-post cleanly: drop any prior postings for this document first.
    await reverseDocumentStock(opts.referenceType, opts.referenceId, connection)
    let moved = 0
    for (const [pk, agg] of byProduct) {
      const res = await applyStockMovement(
        {
          productPk: pk,
          quantity: sign * agg.qty,
          movementType: opts.movementType,
          movementDate: opts.movementDate,
          reference: opts.reference ?? opts.referenceId,
          referenceType: opts.referenceType,
          referenceId: opts.referenceId,
          unitCost: agg.cost,
          userId: opts.userId,
        },
        connection,
      )
      if (res) moved += 1
    }
    await connection.commit()
    return { moved }
  } catch (error) {
    await connection.rollback().catch(() => {})
    throw error
  } finally {
    connection.release()
  }
}
