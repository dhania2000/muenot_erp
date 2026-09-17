import { AsyncLocalStorage } from "node:async_hooks"

/**
 * Per-request "who is acting" context. Populated as a side-effect of the
 * existing `getSession()` call that virtually every authenticated route/page
 * already makes, so the notification layer (see `lib/notifications.ts`) can
 * attribute automatically captured DB writes to the acting user WITHOUT every
 * route having to pass the actor down manually.
 *
 * Node-only (imports node:async_hooks). Never import this from Edge runtime
 * code (middleware) — the middleware verifies the JWT directly instead.
 */
export type Actor = {
  userId: number
  name: string
  email?: string
  role?: "admin" | "employee"
} | null

const storage = new AsyncLocalStorage<{ actor: Actor }>()

/**
 * Record the acting user for the remainder of the current async execution.
 * Uses `enterWith` so callers don't need to wrap their handler in `.run()` —
 * calling this early (from `getSession`) makes the actor visible to every
 * subsequent `await` in the same request without changing existing code.
 */
export function setCurrentActor(actor: Actor) {
  const store = storage.getStore()
  if (store) {
    store.actor = actor
  } else {
    storage.enterWith({ actor })
  }
}

export function getCurrentActor(): Actor {
  return storage.getStore()?.actor ?? null
}
