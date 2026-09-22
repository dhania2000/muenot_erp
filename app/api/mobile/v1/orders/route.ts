import { mobileJson, withMobileAuth, isMobileResponse, boundedPage } from "@/lib/mobile-api"
import { listOrders, createOrder, OrderError } from "@/lib/shopkeeper-orders"

export const runtime = "nodejs"

/**
 * Tenant-owned Shopkeeper orders. Accepts an optional conversationId so an
 * order can be raised straight from a WhatsApp chat; that conversation is
 * resolved against the caller's own tenant.
 */

export async function GET(request: Request) {
  const result = await withMobileAuth(
    request,
    async () => {
      const url = new URL(request.url)
      const contactId = Number(url.searchParams.get("contactId"))
      const page = await listOrders({
        status: url.searchParams.get("status") ?? undefined,
        paymentStatus: url.searchParams.get("paymentStatus") ?? undefined,
        contactId: Number.isInteger(contactId) && contactId > 0 ? contactId : undefined,
        search: url.searchParams.get("search") ?? undefined,
        limit: boundedPage(url.searchParams.get("limit"), 50, 200),
        offset: Number(url.searchParams.get("offset")) || 0,
      })
      return mobileJson(page)
    },
    "orders",
  )
  return isMobileResponse(result) ? result : result
}

export async function POST(request: Request) {
  const result = await withMobileAuth(
    request,
    async (principal) => {
      const body = await request.json().catch(() => ({}))
      try {
        const order = await createOrder(body, principal.userId)
        return mobileJson({ order }, { status: 201 })
      } catch (error) {
        if (error instanceof OrderError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_order" }, { status: error.status })
        }
        console.error("[mobile] POST /orders failed:", error)
        return mobileJson({ error: "The order could not be created.", code: "server_error" }, { status: 500 })
      }
    },
    "orders",
  )
  return isMobileResponse(result) ? result : result
}
