import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
import {
  getShopkeeperContact,
  updateShopkeeperContact,
  archiveShopkeeperContact,
  ContactError,
} from "@/lib/shopkeeper-contacts"

export const runtime = "nodejs"

/**
 * Single customer. DELETE archives rather than removing, because orders and
 * WhatsApp conversations reference this row.
 */

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
      if (id === null) return mobileJson({ error: "Invalid customer id.", code: "invalid_id" }, { status: 400 })
      const contact = await getShopkeeperContact(id)
      if (!contact) return mobileJson({ error: "Customer not found.", code: "not_found" }, { status: 404 })
      return mobileJson({ contact })
    },
    "contacts",
  )
  return isMobileResponse(result) ? result : result
}

export async function PATCH(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid customer id.", code: "invalid_id" }, { status: 400 })
      const body = await request.json().catch(() => ({}))
      try {
        return mobileJson({ contact: await updateShopkeeperContact(id, body) })
      } catch (error) {
        if (error instanceof ContactError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_contact" }, { status: error.status })
        }
        console.error("[mobile] PATCH /contacts/[id] failed:", error)
        return mobileJson({ error: "The customer could not be updated.", code: "server_error" }, { status: 500 })
      }
    },
    "contacts",
  )
  return isMobileResponse(result) ? result : result
}

export async function DELETE(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid customer id.", code: "invalid_id" }, { status: 400 })
      const archived = await archiveShopkeeperContact(id)
      if (!archived) return mobileJson({ error: "Customer not found.", code: "not_found" }, { status: 404 })
      return mobileJson({ archived: true, id })
    },
    "contacts",
  )
  return isMobileResponse(result) ? result : result
}
