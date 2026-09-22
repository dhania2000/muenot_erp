import { mobileJson, withMobileAuth, isMobileResponse } from "@/lib/mobile-api"
import { getProduct, updateProduct, deleteProduct, ProductError } from "@/lib/shopkeeper-products"

export const runtime = "nodejs"

/**
 * Single product. Every lookup carries the tenant predicate, so another
 * tenant's id returns 404 rather than confirming the row exists.
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
      if (id === null) return mobileJson({ error: "Invalid product id.", code: "invalid_id" }, { status: 400 })
      const product = await getProduct(id)
      if (!product) return mobileJson({ error: "Product not found.", code: "not_found" }, { status: 404 })
      return mobileJson({ product })
    },
    "products",
  )
  return isMobileResponse(result) ? result : result
}

export async function PATCH(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid product id.", code: "invalid_id" }, { status: 400 })
      const body = await request.json().catch(() => ({}))
      try {
        return mobileJson({ product: await updateProduct(id, body) })
      } catch (error) {
        if (error instanceof ProductError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_product" }, { status: error.status })
        }
        console.error("[mobile] PATCH /products/[id] failed:", error)
        return mobileJson({ error: "The product could not be updated.", code: "server_error" }, { status: 500 })
      }
    },
    "products",
  )
  return isMobileResponse(result) ? result : result
}

export async function DELETE(request: Request, context: Context) {
  const { id: raw } = await context.params
  const result = await withMobileAuth(
    request,
    async () => {
      const id = parseId(raw)
      if (id === null) return mobileJson({ error: "Invalid product id.", code: "invalid_id" }, { status: 400 })
      const removed = await deleteProduct(id)
      if (!removed) return mobileJson({ error: "Product not found.", code: "not_found" }, { status: 404 })
      return mobileJson({ deleted: true, id })
    },
    "products",
  )
  return isMobileResponse(result) ? result : result
}
