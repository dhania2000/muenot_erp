import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
import { getOrder, updateOrder, OrderError } from "@/lib/shopkeeper-orders"

export const runtime = "nodejs"

/** Single order with its items. Tenant-scoped; a foreign id returns 404. */

type Context = { params: Promise<{ id: string }> }

function parseId(raw: string): number | null {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

export async function GET(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid order id.", code: "invalid_id" }, { status: 400 })
      const order = await getOrder(id)
      if (!order) return mobileJson({ error: "Order not found.", code: "not_found" }, { status: 404 })
      return mobileJson({ order })
    },
    "orders",
  )
  return isMobileResponse(result) ? result : result
}

export async function PATCH(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid order id.", code: "invalid_id" }, { status: 400 })
      const body = await request.json().catch(() => ({}))
      try {
        return mobileJson({ order: await updateOrder(id, body) })
      } catch (error) {
        if (error instanceof OrderError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_order" }, { status: error.status })
        }
        console.error("[mobile] PATCH /orders/[id] failed:", error)
        return mobileJson({ error: "The order could not be updated.", code: "server_error" }, { status: 500 })
      }
    },
    "orders",
  )
  return isMobileResponse(result) ? result : result
}
