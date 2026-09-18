import { query } from "./db"
import { getCurrentActor, type Actor } from "./actor-context"
import { PERMISSION_MODULES, type PermissionModule } from "./permission-model"
import { ensurePermissionSchema } from "./permission-store"
import { currentTenantIdOrNull } from "./tenant-scope"
import { recordUsageSafe } from "./billing/usage-metering"

// ---------------------------------------------------------------------------
// Global activity notifications
// ---------------------------------------------------------------------------
// Every add / update / delete on a permission-mapped module table is captured
// automatically at the DB layer (see `lib/db.ts`) and fanned out as a
// notification to exactly the users who are ALLOWED TO SEE that module — i.e.
// each employee only receives notifications for the modules / sub-modules they
// have (view) permission on. The user who performed the action is excluded.
//
// Explicit events that are not plain table writes (login, import, export /
// download) call `recordActivity()` directly.

let schemaEnsured = false

export async function ensureNotificationsSchema() {
  if (schemaEnsured) return
  await query(
    `CREATE TABLE IF NOT EXISTS notifications (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      user_id INT UNSIGNED NOT NULL,
      actor_id INT UNSIGNED NULL,
      actor_name VARCHAR(150) NULL,
      module_key VARCHAR(80) NULL,
      group_slug VARCHAR(40) NULL,
      action VARCHAR(20) NOT NULL,
      title VARCHAR(255) NOT NULL,
      body VARCHAR(500) NULL,
      link VARCHAR(255) NULL,
      entity_table VARCHAR(80) NULL,
      entity_id VARCHAR(40) NULL,
      is_read TINYINT(1) NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_notif_user (user_id, is_read),
      KEY idx_notif_created (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  )
  schemaEnsured = true
}

// --- table -> module(s) index -------------------------------------------------
const MODULES_BY_TABLE = new Map<string, PermissionModule[]>()
for (const m of PERMISSION_MODULES) {
  const t = m.scope?.table
  if (!t) continue
  const arr = MODULES_BY_TABLE.get(t) ?? []
  arr.push(m)
  MODULES_BY_TABLE.set(t, arr)
}

/** The most representative module for a table (avoid the group `*.dashboard`). */
function primaryModuleForTable(table: string): PermissionModule | null {
  const mods = MODULES_BY_TABLE.get(table)
  if (!mods?.length) return null
  return mods.find((m) => !m.key.endsWith(".dashboard")) ?? mods[0]
}

export type ActivityAction = "create" | "update" | "delete" | "login" | "import" | "export"

const VERB: Record<ActivityAction, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  login: "signed in",
  import: "imported",
  export: "exported",
}

type Recipient = { id: number; name: string | null }

/**
 * Resolve the users who may SEE any of the given modules (and are therefore
 * eligible for a notification). A user with NO configured permission matrix at
 * all keeps implicit full access (admins / legacy accounts), matching how
 * `getScope` falls back to "all". The acting user is always excluded.
 */
async function resolveRecipients(moduleKeys: string[], actorId: number | null): Promise<Recipient[]> {
  if (moduleKeys.length === 0) return []
  await ensurePermissionSchema()
  const placeholders = moduleKeys.map(() => "?").join(", ")
  const rows = await query<Recipient[]>(
    `SELECT u.id, u.name
       FROM users u
      WHERE u.status = 'active'
        AND u.id <> ?
        AND (
          NOT EXISTS (SELECT 1 FROM user_module_permissions x WHERE x.user_id = u.id)
          OR EXISTS (
            SELECT 1 FROM user_module_permissions p
             WHERE p.user_id = u.id
               AND p.module_key IN (${placeholders})
               AND p.can_view <> 'none'
          )
        )`,
    [actorId ?? 0, ...moduleKeys],
  )
  return rows
}

async function fanOut(params: {
  recipients: Recipient[]
  actor: Actor
  moduleKey: string | null
  groupSlug: string | null
  action: ActivityAction
  title: string
  body: string | null
  link: string | null
  entityTable: string | null
  entityId: string | null
}) {
  const { recipients, actor, moduleKey, groupSlug, action, title, body, link, entityTable, entityId } = params
  if (recipients.length === 0) return
  await ensureNotificationsSchema()

  const values: unknown[] = []
  const tuples: string[] = []
  for (const r of recipients) {
    tuples.push("(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    values.push(
      r.id,
      actor?.userId ?? null,
      actor?.name ?? null,
      moduleKey,
      groupSlug,
      action,
      title.slice(0, 255),
      body ? body.slice(0, 500) : null,
      link,
      entityTable,
      entityId,
    )
  }

  await query(
    `INSERT INTO notifications
       (user_id, actor_id, actor_name, module_key, group_slug, action, title, body, link, entity_table, entity_id)
     VALUES ${tuples.join(", ")}`,
    values,
  )

  // SPEC 19 — meter notification volume per tenant. Fire-and-forget: metering
  // must never affect the notification delivery it is measuring. Only recorded
  // when a tenant is in context (skips system/pre-auth paths).
  if (currentTenantIdOrNull() != null) {
    recordUsageSafe({
      meterKey: "notifications",
      quantity: recipients.length,
      source: "notifications",
      refId: entityId,
    })
  }
}

/**
 * Fan out a notification for an automatically captured DB write. Called
 * fire-and-forget from the instrumented `query()` layer; never throws into the
 * caller. `table` is the affected table, `action` one of create/update/delete.
 */
export async function recordDbWrite(table: string, action: "create" | "update" | "delete", entityId: string | null) {
  try {
    const primary = primaryModuleForTable(table)
    if (!primary) return // table isn't a permission-mapped module — ignore

    const actor = getCurrentActor()
    const moduleKeys = (MODULES_BY_TABLE.get(table) ?? []).map((m) => m.key)
    const recipients = await resolveRecipients(moduleKeys, actor?.userId ?? null)
    if (recipients.length === 0) return

    const groupSlug = primary.group
    const who = actor?.name ?? "Someone"
    const title = `${who} ${VERB[action]} ${primary.label}`
    const body = entityId ? `Record #${entityId}` : null
    const link = `/modules/${groupSlug}`

    await fanOut({
      recipients,
      actor,
      moduleKey: primary.key,
      groupSlug,
      action,
      title,
      body,
      link,
      entityTable: table,
      entityId,
    })
  } catch (err) {
    console.error("[v0] notifications recordDbWrite failed:", err)
  }
}

/**
 * Record an explicit activity that is not a plain table write — e.g. a login,
 * a bulk import, or an export/download. When `moduleKey` is provided the
 * notification is scoped to users who can view that module; otherwise it is
 * treated as a general event (currently only login uses the no-module path,
 * which notifies admins / full-access users).
 */
export async function recordActivity(params: {
  action: ActivityAction
  moduleKey?: string | null
  title: string
  body?: string | null
  link?: string | null
  /** Override the actor (defaults to the current request actor). */
  actor?: Actor
}) {
  try {
    const actor = params.actor ?? getCurrentActor()
    let moduleKeys: string[] = []
    let groupSlug: string | null = null

    if (params.moduleKey) {
      const mod = PERMISSION_MODULES.find((m) => m.key === params.moduleKey)
      if (mod) {
        groupSlug = mod.group
        const table = mod.scope?.table
        moduleKeys = table ? (MODULES_BY_TABLE.get(table) ?? [mod]).map((m) => m.key) : [mod.key]
      } else {
        moduleKeys = [params.moduleKey]
      }
    }

    let recipients: Recipient[]
    if (moduleKeys.length > 0) {
      recipients = await resolveRecipients(moduleKeys, actor?.userId ?? null)
    } else {
      // General event (e.g. login): notify only full-access users (admins /
      // accounts with no configured matrix), excluding the actor.
      await ensurePermissionSchema()
      recipients = await query<Recipient[]>(
        `SELECT u.id, u.name FROM users u
          WHERE u.status = 'active' AND u.id <> ?
            AND NOT EXISTS (SELECT 1 FROM user_module_permissions x WHERE x.user_id = u.id)`,
        [actor?.userId ?? 0],
      )
    }

    await fanOut({
      recipients,
      actor,
      moduleKey: params.moduleKey ?? null,
      groupSlug,
      action: params.action,
      title: params.title,
      body: params.body ?? null,
      link: params.link ?? (groupSlug ? `/modules/${groupSlug}` : null),
      entityTable: null,
      entityId: null,
    })
  } catch (err) {
    console.error("[v0] notifications recordActivity failed:", err)
  }
}
