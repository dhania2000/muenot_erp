import "server-only"
/**
 * Versioned OpenAPI 3.1 document generated from the real `/api/v1` contracts.
 * ---------------------------------------------------------------------------
 * This is generated from a single in-code source of truth (`ENDPOINTS`) rather
 * than hand-maintained, so the published docs cannot drift from the routes that
 * actually run. When a new `/api/v1` route is added, describe it here and it is
 * reflected in `/api/v1/openapi.json` and the developer-center API reference.
 *
 * Auth is described two ways because both are real: an `oauth2` client-
 * credentials flow (see app/api/v1/oauth/token) and a `bearerApiKey` scheme
 * (raw API keys). The scope catalogue is sourced from the same list the auth
 * layer enforces, so documented scopes always match enforced scopes.
 */
import { API_VERSION } from "@/lib/api-platform/response"
import { AVAILABLE_SCOPES } from "@/lib/api-keys-store"
import { ERROR_STATUS, type ApiErrorCode } from "@/lib/api-platform/errors"

type EndpointContract = {
  method: "get" | "post" | "put" | "patch" | "delete"
  path: string
  operationId: string
  summary: string
  description?: string
  scopes?: string[]
  idempotent?: boolean
  paginated?: boolean
  parameters?: Array<{
    name: string
    in: "query" | "path"
    required?: boolean
    schema: Record<string, unknown>
    description?: string
  }>
  requestBody?: { required?: boolean; schema: Record<string, unknown>; example?: unknown }
  responses: Array<{ status: number; description: string; schema?: Record<string, unknown> }>
  errorCodes?: ApiErrorCode[]
  security?: "none" | "standard"
}

const COMMON_ERRORS: ApiErrorCode[] = [
  "unauthorized",
  "forbidden",
  "validation_failed",
  "unsupported_version",
  "rate_limited",
  "internal_error",
]

/** Single source of truth for the public API surface. */
export const ENDPOINTS: EndpointContract[] = [
  {
    method: "post",
    path: "/api/v1/oauth/token",
    operationId: "issueToken",
    summary: "Issue an access token (client credentials grant)",
    description:
      "Exchange an OAuth app's client_id and client_secret for a short-lived Bearer access token. Optionally request a subset of the app's granted scopes; omitting `scope` grants the app's full consented scope set.",
    security: "none",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["grant_type", "client_id", "client_secret"],
        properties: {
          grant_type: { type: "string", enum: ["client_credentials"] },
          client_id: { type: "string" },
          client_secret: { type: "string" },
          scope: { type: "string", description: "Space-separated subset of the app's granted scopes." },
        },
      },
      example: {
        grant_type: "client_credentials",
        client_id: "mnoauth_xxxxxxxxxxxx",
        client_secret: "mnosec_xxxxxxxx",
        scope: "clients:read",
      },
    },
    responses: [
      {
        status: 200,
        description: "Access token issued",
        schema: {
          type: "object",
          properties: {
            access_token: { type: "string" },
            token_type: { type: "string", enum: ["Bearer"] },
            expires_in: { type: "integer", description: "Lifetime in seconds." },
            scope: { type: "string" },
          },
        },
      },
      {
        status: 400,
        description: "OAuth error (invalid_request, unsupported_grant_type, invalid_scope)",
        schema: {
          type: "object",
          properties: { error: { type: "string" }, error_description: { type: "string" } },
        },
      },
      {
        status: 401,
        description: "invalid_client — unknown client or wrong secret",
        schema: {
          type: "object",
          properties: { error: { type: "string" }, error_description: { type: "string" } },
        },
      },
    ],
  },
  {
    method: "get",
    path: "/api/v1/clients",
    operationId: "listClients",
    summary: "List clients",
    scopes: ["clients:read"],
    paginated: true,
    security: "standard",
    parameters: [
      { name: "page", in: "query", schema: { type: "integer", minimum: 1, default: 1 } },
      { name: "per_page", in: "query", schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
      { name: "sort", in: "query", schema: { type: "string" }, description: "e.g. -created_at, client_name" },
      { name: "status", in: "query", schema: { type: "string" } },
      { name: "client_type", in: "query", schema: { type: "string", enum: ["Individual", "Company"] } },
      { name: "category", in: "query", schema: { type: "string" } },
    ],
    responses: [
      {
        status: 200,
        description: "A page of clients",
        schema: {
          type: "object",
          properties: {
            data: { type: "array", items: { $ref: "#/components/schemas/Client" } },
            meta: { $ref: "#/components/schemas/PageMeta" },
            request_id: { type: "string" },
          },
        },
      },
    ],
    errorCodes: COMMON_ERRORS,
  },
  {
    method: "post",
    path: "/api/v1/clients",
    operationId: "createClient",
    summary: "Create a client",
    scopes: ["clients:write"],
    idempotent: true,
    security: "standard",
    requestBody: {
      required: true,
      schema: {
        type: "object",
        required: ["client_name", "email"],
        properties: {
          client_name: { type: "string" },
          email: { type: "string", format: "email" },
          mobile: { type: "string" },
          company_name: { type: "string" },
          gst_number: { type: "string" },
          pan: { type: "string" },
          client_type: { type: "string", enum: ["Individual", "Company"] },
        },
      },
      example: { client_name: "Acme Pvt Ltd", email: "ops@acme.example", company_name: "Acme Pvt Ltd" },
    },
    responses: [
      {
        status: 201,
        description: "Client created",
        schema: {
          type: "object",
          properties: {
            data: { type: "object", properties: { client_code: { type: "string" } } },
            request_id: { type: "string" },
          },
        },
      },
    ],
    errorCodes: [...COMMON_ERRORS, "idempotency_conflict", "conflict"],
  },
]

function errorResponses(codes: ApiErrorCode[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const code of codes ?? []) {
    const status = String(ERROR_STATUS[code])
    // If two codes share a status, keep the first — the description lists both.
    if (out[status]) continue
    out[status] = {
      description: code,
      content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
    }
  }
  return out
}

export function generateOpenApiDocument(origin?: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const ep of ENDPOINTS) {
    const op: Record<string, unknown> = {
      operationId: ep.operationId,
      summary: ep.summary,
      ...(ep.description ? { description: ep.description } : {}),
      ...(ep.scopes ? { "x-scopes": ep.scopes } : {}),
      ...(ep.idempotent ? { "x-idempotent": true } : {}),
    }
    if (ep.parameters?.length) op.parameters = ep.parameters
    if (ep.requestBody) {
      op.requestBody = {
        required: ep.requestBody.required ?? false,
        content: {
          "application/json": {
            schema: ep.requestBody.schema,
            ...(ep.requestBody.example !== undefined ? { example: ep.requestBody.example } : {}),
          },
        },
      }
    }

    const responses: Record<string, unknown> = {}
    for (const r of ep.responses) {
      responses[String(r.status)] = {
        description: r.description,
        ...(r.schema ? { content: { "application/json": { schema: r.schema } } } : {}),
      }
    }
    Object.assign(responses, errorResponses(ep.errorCodes))
    op.responses = responses

    if (ep.security === "standard") {
      op.security = [{ oauth2: ep.scopes ?? [] }, { bearerApiKey: [] }]
    } else {
      op.security = []
    }

    paths[ep.path] = { ...(paths[ep.path] ?? {}), [ep.method]: op }
  }

  const scopeMap: Record<string, string> = {}
  for (const s of AVAILABLE_SCOPES) scopeMap[s.value] = s.label

  return {
    openapi: "3.1.0",
    info: {
      title: "Muenot ERP API",
      version: API_VERSION,
      description:
        "Public REST API for Muenot ERP. Authenticate with an OAuth client-credentials access token or a raw API key (both use the Bearer scheme). All access is tenant-scoped and scope-restricted.",
    },
    servers: [{ url: origin || "/", description: "Current deployment" }],
    security: [{ oauth2: [] }, { bearerApiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            clientCredentials: {
              tokenUrl: "/api/v1/oauth/token",
              scopes: scopeMap,
            },
          },
        },
        bearerApiKey: {
          type: "http",
          scheme: "bearer",
          description: "Raw API key issued in the developer center, sent as `Authorization: Bearer <key>`.",
        },
      },
      schemas: {
        Error: {
          type: "object",
          properties: {
            error: {
              type: "object",
              properties: {
                code: { type: "string" },
                message: { type: "string" },
                details: { type: "object", additionalProperties: true },
                request_id: { type: "string" },
              },
              required: ["code", "message", "request_id"],
            },
          },
        },
        PageMeta: {
          type: "object",
          properties: {
            page: { type: "integer" },
            per_page: { type: "integer" },
            total: { type: "integer" },
            total_pages: { type: "integer" },
            sort: { type: "string" },
          },
        },
        Client: {
          type: "object",
          properties: {
            client_code: { type: "string" },
            client_name: { type: "string" },
            display_name: { type: "string" },
            email: { type: "string" },
            mobile: { type: "string" },
            company_name: { type: "string" },
            status: { type: "string" },
            client_type: { type: "string" },
            created_at: { type: "string", format: "date-time" },
          },
        },
      },
    },
  }
}
