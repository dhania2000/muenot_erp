import { describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"

vi.mock("server-only", () => ({}))

import { checkPasswordBreached } from "@/lib/breached-password"

const RANGE_URL = "https://api.pwnedpasswords.com/range/"

function hashParts(password: string) {
  const sha1 = crypto.createHash("sha1").update(password, "utf8").digest("hex").toUpperCase()
  return { sha1, prefix: sha1.slice(0, 5), suffix: sha1.slice(5) }
}

/** Build a fetch stub that returns a HIBP-style range body and records the URL it saw. */
function rangeFetch(body: string, seen: { url?: string; headers?: HeadersInit }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    seen.url = url
    seen.headers = init?.headers
    return { ok: true, text: async () => body } as unknown as Response
  }) as unknown as typeof fetch
}

describe("breached-password (HIBP k-anonymity)", () => {
  it("never transmits the plaintext or full hash — only the 5-char prefix", async () => {
    const password = "hunter2-correct-horse"
    const { prefix, suffix, sha1 } = hashParts(password)
    const seen: { url?: string } = {}
    const fetchImpl = rangeFetch(`${suffix}:42\n`, seen)

    await checkPasswordBreached(password, { fetchImpl })

    expect(seen.url).toBe(`${RANGE_URL}${prefix}`)
    // The plaintext, the full SHA-1, and the 35-char suffix must never leave the process.
    expect(seen.url).not.toContain(password)
    expect(seen.url).not.toContain(sha1)
    expect(seen.url).not.toContain(suffix)
  })

  it("sends the Add-Padding header so response length cannot leak breach status", async () => {
    const { suffix } = hashParts("whatever")
    const seen: { headers?: Record<string, string> } = {}
    const fetchImpl = rangeFetch(`${suffix}:1\n`, seen as any)
    await checkPasswordBreached("whatever", { fetchImpl })
    expect((seen.headers as any)?.["Add-Padding"]).toBe("true")
  })

  it("reports a breach with its count when the suffix matches", async () => {
    const password = "password123"
    const { suffix } = hashParts(password)
    const seen = {}
    const fetchImpl = rangeFetch(`0000000000000000000000000000000000A:2\n${suffix}:1337\n`, seen)
    const result = await checkPasswordBreached(password, { fetchImpl })
    expect(result).toEqual({ checked: true, breached: true, count: 1337 })
  })

  it("reports not breached when the suffix is absent", async () => {
    const password = "a-very-unique-passphrase"
    const seen = {}
    const fetchImpl = rangeFetch(`0000000000000000000000000000000000A:2\n`, seen)
    const result = await checkPasswordBreached(password, { fetchImpl })
    expect(result).toEqual({ checked: true, breached: false, count: 0 })
  })

  it("treats a padding entry (count 0) as not breached even if the suffix matches", async () => {
    const password = "padded-entry"
    const { suffix } = hashParts(password)
    const seen = {}
    const fetchImpl = rangeFetch(`${suffix}:0\n`, seen)
    const result = await checkPasswordBreached(password, { fetchImpl })
    expect(result).toEqual({ checked: true, breached: false, count: 0 })
  })

  it("fails open (checked=false) when the provider is unreachable", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const result = await checkPasswordBreached("anything", { fetchImpl })
    expect(result).toEqual({ checked: false, breached: false, count: 0 })
  })

  it("fails open on a non-2xx provider response", async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, text: async () => "" }) as unknown as Response) as unknown as typeof fetch
    const result = await checkPasswordBreached("anything", { fetchImpl })
    expect(result).toEqual({ checked: false, breached: false, count: 0 })
  })

  it("fails open when the provider times out (abort)", async () => {
    const fetchImpl = vi.fn((_: string, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))
      })
    }) as unknown as typeof fetch
    const result = await checkPasswordBreached("slow", { fetchImpl, timeoutMs: 5 })
    expect(result.checked).toBe(false)
  })

  it("short-circuits an empty password without calling the provider", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch
    const result = await checkPasswordBreached("", { fetchImpl })
    expect(result).toEqual({ checked: true, breached: false, count: 0 })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})
