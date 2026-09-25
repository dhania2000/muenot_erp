import { withApiV1 } from "@/lib/api-platform/handler"
import { jsonOk } from "@/lib/api-platform/response"
import { getOrCreateSandbox, resetSandbox, disposeSandbox } from "@/lib/api-platform/sandbox"

/**
 * Isolated tenant API sandbox lifecycle.
 * ---------------------------------------------------------------------------
 * All sandbox endpoints require a TEST-environment key (`requireEnvironment:
 * "test"`) so live keys can never touch sandbox data, and the sandbox can never
 * touch live tables (its storage is entirely separate — see lib/.../sandbox.ts).
 * The tenant scope is always derived from the key (`ctx.auth.tenantId`).
 *
 *   GET    /api/v1/sandbox  → describe (auto-provisions + seeds on first use)
 *   POST   /api/v1/sandbox  → reset to a fresh, seeded, isolated sandbox
 *   DELETE /api/v1/sandbox  → dispose the sandbox and all its test data
 */

export const GET = withApiV1(
  { scopes: "sandbox:read", requireEnvironment: "test" },
  async (ctx) => {
    const session = await getOrCreateSandbox(ctx.auth.tenantId)
    return jsonOk(serialize(session), { requestId: ctx.requestId })
  },
)

export const POST = withApiV1(
  { scopes: "sandbox:write", requireEnvironment: "test", idempotency: true },
  async (ctx) => {
    const session = await resetSandbox(ctx.auth.tenantId)
    return jsonOk(serialize(session), { requestId: ctx.requestId, status: 201 })
  },
)

export const DELETE = withApiV1(
  { scopes: "sandbox:write", requireEnvironment: "test" },
  async (ctx) => {
    await disposeSandbox(ctx.auth.tenantId)
    return jsonOk({ disposed: true }, { requestId: ctx.requestId })
  },
)

function serialize(session: {
  sandboxId: string
  createdAt: string
  resetAt: string
  seededCount: number
}) {
  return {
    sandbox_id: session.sandboxId,
    created_at: session.createdAt,
    reset_at: session.resetAt,
    seeded_count: session.seededCount,
    environment: "test",
    disposable: true,
  }
}
