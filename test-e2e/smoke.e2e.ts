import { execFileSync } from "node:child_process"
import { beforeAll, describe, expect, it } from "vitest"

/**
 * Smoke tests against a live server + real MySQL. Requires:
 *   E2E_BASE_URL   e.g. http://127.0.0.1:3100
 *   E2E_PASSWORD   password the seed assigns to fixture users
 *   DB_*           same database the server uses (for seeding)
 * The server must run with STRIPE_SECRET_KEY set and STRIPE_API_BASE pointing
 * at scripts/ci/mock-stripe.mjs.
 */
const BASE = process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100"
const PASSWORD = process.env.E2E_PASSWORD ?? ""

type Fixtures = {
  tenantA: number
  tenantB: number
  adminA: { email: string }
  memberA: { email: string }
  adminB: { email: string }
  invoiceA: number
  invoiceB: number
}
let fx: Fixtures

async function login(email: string, password = PASSWORD) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email, password }),
    redirect: "manual",
  })
  const cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .find((c) => c.startsWith("ems_session="))
  return { res, cookie }
}

async function as(cookie: string, path: string, init: RequestInit = {}) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", origin: BASE, cookie, ...(init.headers ?? {}) },
    redirect: "manual",
  })
}

const sessions: Record<string, string> = {}

beforeAll(async () => {
  expect(PASSWORD, "E2E_PASSWORD must be set").not.toBe("")
  fx = JSON.parse(execFileSync("node", ["scripts/ci/seed-e2e.mjs"], { encoding: "utf8" }).trim().split("\n").pop()!)
  for (const key of ["adminA", "memberA", "adminB"] as const) {
    const { res, cookie } = await login(fx[key].email)
    expect(res.status, `login ${key}`).toBe(200)
    expect(cookie, `session cookie for ${key}`).toBeTruthy()
    sessions[key] = cookie!
  }
})

describe("login", () => {
  it("rejects a wrong password without issuing a session", async () => {
    const { res, cookie } = await login(fx.adminA.email, "definitely-wrong")
    expect(res.status).toBe(401)
    expect(cookie).toBeUndefined()
  })

  it("issues a session that resolves the user's own tenant", async () => {
    const res = await as(sessions.adminA, "/api/auth/session")
    expect(res.status).toBe(200)
    const { user } = await res.json()
    expect(user).toBeTruthy()
    expect(Number(user.tenantId)).toBe(fx.tenantA)
  })

  it("blocks anonymous access to tenant data", async () => {
    const res = await fetch(`${BASE}/api/billing/invoices`, { redirect: "manual" })
    expect([401, 403]).toContain(res.status)
  })
})

describe("tenant boundary", () => {
  it("lists only the caller's invoices", async () => {
    const a = await (await as(sessions.adminA, "/api/billing/invoices")).json()
    const b = await (await as(sessions.adminB, "/api/billing/invoices")).json()
    const idsA = a.invoices.map((i: { id: number }) => i.id)
    const idsB = b.invoices.map((i: { id: number }) => i.id)
    expect(idsA).toContain(fx.invoiceA)
    expect(idsA).not.toContain(fx.invoiceB)
    expect(idsB).toContain(fx.invoiceB)
    expect(idsB).not.toContain(fx.invoiceA)
  })

  it("returns 404 for another tenant's invoice id at checkout", async () => {
    const res = await as(sessions.adminA, `/api/billing/invoices/${fx.invoiceB}/checkout`, {
      method: "POST",
      body: JSON.stringify({ provider: "stripe", tenantId: fx.tenantB }),
    })
    expect(res.status).toBe(404)
  })

  it("denies billing to a non-admin member of the same tenant", async () => {
    const res = await as(sessions.memberA, `/api/billing/invoices/${fx.invoiceA}/checkout`, {
      method: "POST",
      body: JSON.stringify({ provider: "stripe" }),
    })
    expect(res.status).toBe(403)
  })
})

describe("checkout", () => {
  it("opens one checkout and replays it idempotently", async () => {
    const open = () =>
      as(sessions.adminA, `/api/billing/invoices/${fx.invoiceA}/checkout`, {
        method: "POST",
        body: JSON.stringify({ provider: "stripe" }),
      })
    const first = await open()
    expect(first.status).toBe(201)
    const a = await first.json()
    expect(a).toMatchObject({ provider: "stripe", amount: 125, currency: "USD", replayed: false })
    expect(a.clientParams).toBeTruthy()

    const second = await open()
    expect(second.status).toBe(200)
    const b = await second.json()
    expect(b.replayed).toBe(true)
    expect(b.paymentNo).toBe(a.paymentNo)
  })

  it("rejects an unconfigured provider", async () => {
    const res = await as(sessions.adminA, `/api/billing/invoices/${fx.invoiceA}/checkout`, {
      method: "POST",
      body: JSON.stringify({ provider: "razorpay" }),
    })
    expect(res.status).toBe(400)
  })
})
