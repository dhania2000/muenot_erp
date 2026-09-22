import { mobileJson, withMobileAuth, isMobileResponse, boundedPage } from "@/lib/mobile-api"
import { listProducts, createProduct, ProductError } from "@/lib/shopkeeper-products"

export const runtime = "nodejs"

/**
 * Tenant-owned Shopkeeper products. The tenant comes from the verified mobile
 * token via withMobileAuth → runForTenant; a tenant_id in the query or body is
 * never consulted for authorization.
 */

export async function GET(request: Request) {
  const result = await withMobileAuth(
    request,
    async () => {
      const url = new URL(request.url)
      const page = await listProducts({
        search: url.searchParams.get("search") ?? undefined,
        category: url.searchParams.get("category") ?? undefined,
        status: url.searchParams.get("status") ?? undefined,
        limit: boundedPage(url.searchParams.get("limit"), 50, 200),
        offset: Number(url.searchParams.get("offset")) || 0,
      })
      return mobileJson(page)
    },
    "products",
  )
  return isMobileResponse(result) ? result : result
}

export async function POST(request: Request) {
  const result = await withMobileAuth(
    request,
    async (principal) => {
      const body = await request.json().catch(() => ({}))
      try {
        const product = await createProduct(body, principal.userId)
        return mobileJson({ product }, { status: 201 })
      } catch (error) {
        if (error instanceof ProductError) {
          return mobileJson({ error: error.message, fields: error.fields, code: "invalid_product" }, { status: error.status })
        }
        console.error("[mobile] POST /products failed:", error)
        return mobileJson({ error: "The product could not be created.", code: "server_error" }, { status: 500 })
      }
    },
    "products",
  )
  return isMobileResponse(result) ? result : result
}
