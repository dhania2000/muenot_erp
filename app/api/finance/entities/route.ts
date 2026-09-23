import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canCreateInModule } from "@/lib/permission-enforce"
import { dataScopeWhere } from "@/lib/data-scope"
import { listEntities, createEntity, EntityValidationError } from "@/lib/legal-entities"

/**
 * Legal entity master.
 * GET  : list every legal entity for the tenant (with bank-account counts).
 * POST : create a new legal entity. First entity auto-becomes the default.
 * Session-gated; POST additionally honours the finance.entities Add scope.
 */
const PERMISSION_KEY = "finance.entities"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  // data-level scope: a Finance/regional user with an entity/branch
  // grant only sees their assigned legal entities. Unconfigured users / admins
  // get null (unrestricted), preserving existing behaviour.
  const scope = await dataScopeWhere(session, "finance.entities", "e")
  const entities = await listEntities(scope)
  return NextResponse.json({ entities })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add legal entities" }, { status: 403 })
  }

  const body = await req.json().catch(() => ({}))
  try {
    const entity = await createEntity(body, { userId: session.userId, name: session.name })
    return NextResponse.json({ entity })
  } catch (error) {
    if (error instanceof EntityValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}
