import { NextResponse } from "next/server"
import { generateOpenApiDocument } from "@/lib/api-platform/openapi"
import { API_VERSION } from "@/lib/api-platform/response"

/**
 * Public, unauthenticated OpenAPI 3.1 document generated from the live route
 * contracts. Kept open so tooling (Swagger UI, codegen) can consume it, and so
 * the developer-center API reference can render the same source of truth.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const origin = new URL(request.url).origin
  const doc = generateOpenApiDocument(origin)
  return NextResponse.json(doc, {
    headers: {
      "X-API-Version": API_VERSION,
      "Cache-Control": "public, max-age=300",
    },
  })
}
