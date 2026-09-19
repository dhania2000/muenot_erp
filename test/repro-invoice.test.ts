import { test } from "vitest"
import { runForTenant } from "@/lib/tenant-scope"
import { createInvoice } from "@/lib/billing/billing-engine"
import { query } from "@/lib/db"

test("repro create invoice", async () => {
  const tenants = (await query("SELECT id FROM tenants LIMIT 1")) as any[]
  const tenantId = Number(tenants[0]?.id)
  const users = (await query("SELECT id FROM users WHERE tenant_id = ? LIMIT 1", [tenantId])) as any[]
  const userId = Number(users[0]?.id)
  console.log("[v0] tenant", tenantId, "user", userId)
  await runForTenant({ tenantId }, async () => {
    try {
      const inv = await createInvoice(
        {
          invoice_type: "one_time",
          customer_name: "Repro",
          currency: "USD",
          lines: [{ description: "Item", quantity: 1, unit_amount: 1, taxable: true }],
          coupon_code: "SAVE20",
          tax_rate: 0,
          adjustment: 0,
          apply_credit: true,
          due_date: "2026-10-10",
          finalize: true,
        } as any,
        { userId } as any,
      )
      console.log("[v0] created", inv.invoice_no)
    } catch (err) {
      console.log("[v0] ERROR NAME:", (err as Error).name)
      console.log("[v0] ERROR MSG:", (err as Error).message)
      console.log("[v0] ERROR STACK:", (err as Error).stack)
      throw err
    }
  })
}, 30000)
