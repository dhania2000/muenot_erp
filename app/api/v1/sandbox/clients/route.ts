import { withApiV1 } from "@/lib/api-platform/handler"
import { jsonOk } from "@/lib/api-platform/response"
import { validationError } from "@/lib/api-platform/errors"
import { parseListQuery } from "@/lib/api-platform/query"
import { projectResource, projectResources } from "@/lib/api-platform/versioning"
import { getOrCreateSandbox, createSandboxClient, listSandboxClients } from "@/lib/api-platform/sandbox"
import { isValidEmail, normalizeEmail } from "@/lib/clients-db"

/**
 * Disposable client resource inside the isolated sandbox. Mirrors the shape of
 * the real `/api/v1/clients` endpoint (same validation, same version
 * projection, same idempotency guarantees) but reads and writes ONLY the
 * tenant's sandbox storage — never the production `clients` table. TEST keys
 * only, tenant scope from the key.
 */

export const GET = withApiV1(
  { scopes: "sandbox:read", requireEnvironment: "test" },
  async (ctx) => {
    const session = await getOrCreateSandbox(ctx.auth.tenantId)
    const { pagination } = parseListQuery(ctx.url, {
      sortable: ["created_at"],
      filterable: [],
      defaultSort: "-created_at",
    })
    const { rows, total } = await listSandboxClients(
      ctx.auth.tenantId,
      session.sandboxId,
      pagination.limit,
      pagination.offset,
    )
    return jsonOk(projectResources(ctx.apiVersion, "client", rows, "client_code"), {
      requestId: ctx.requestId,
      meta: {
        page: pagination.page,
        per_page: pagination.perPage,
        total,
        total_pages: Math.max(1, Math.ceil(total / pagination.perPage)),
        sandbox_id: session.sandboxId,
      },
    })
  },
)

export const POST = withApiV1(
  { scopes: "sandbox:write", requireEnvironment: "test", idempotency: "required" },
  async (ctx) => {
    const session = await getOrCreateSandbox(ctx.auth.tenantId)
    const body = await ctx.json<Record<string, any>>()

    const errors: Record<string, string> = {}
    if (!String(body.client_name ?? "").trim()) errors.client_name = "client_name is required"
    if (!String(body.email ?? "").trim()) errors.email = "email is required"
    else if (!isValidEmail(body.email)) errors.email = "email is invalid"
    if (Object.keys(errors).length > 0) throw validationError(errors)

    const companyName = String(body.company_name ?? "").trim() || null
    const record = await createSandboxClient(ctx.auth.tenantId, session.sandboxId, {
      client_name: String(body.client_name).trim(),
      email: normalizeEmail(body.email),
      company_name: companyName,
      client_type: companyName ? "Company" : "Individual",
    })

    return jsonOk(projectResource(ctx.apiVersion, "client", record, "client_code"), {
      requestId: ctx.requestId,
      status: 201,
    })
  },
)
