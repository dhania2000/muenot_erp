import { mobileJson, withMobileAuth, isMobileResponse, boundedPage } from "@/lib/mobile-api"
import { listShopkeeperContacts, createShopkeeperContact, ContactError } from "@/lib/shopkeeper-contacts"

export const runtime = "nodejs"

/**
 * Shopkeeper customers, backed by the tenant's existing WhatsApp contacts so
 * conversation history stays attached to the same record.
 */

export async function GET(request: Request) {
  const result = await withMobileAuth(
    request,
    async () => {
      const url = new URL(request.url)
      const page = await listShopkeeperContacts({
        search: url.searchParams.get("search") ?? undefined,
        includeArchived: url.searchParams.get("includeArchived") === "1",
        limit: boundedPage(url.searchParams.get("limit"), 50, 200),
        offset: Number(url.searchParams.get("offset")) || 0,
      })
      return mobileJson(page)
    },
    "contacts",
  )
  return isMobileResponse(result) ? result : result
}

export async function POST(request: Request) {
  const result = await withMobileAuth(
    request,
    async () => {
      const body = await request.json().catch(() => ({}))
      try {
        return mobileJson({ contact: await createShopkeeperContact(body) }, { status: 201 })
      } catch (error) {
        if (error instanceof ContactError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_contact" }, { status: error.status })
        }
        console.error("[mobile] POST /contacts failed:", error)
        return mobileJson({ error: "The customer could not be created.", code: "server_error" }, { status: 500 })
      }
    },
    "contacts",
  )
  return isMobileResponse(result) ? result : result
}
