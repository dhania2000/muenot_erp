import { describe, expect, it } from "vitest"
import {
  HostingModeNotReadyError,
  assertSafeHostingModeCreate,
  assertSafeHostingModeUpdate,
} from "@/lib/tenant-db/activation"

describe("hosting-mode activation safety gate", () => {
  it("preserves shared-mode tenant creation and no-op updates", () => {
    expect(() => assertSafeHostingModeCreate("shared_database")).not.toThrow()
    expect(() => assertSafeHostingModeUpdate("shared_database", "shared_database")).not.toThrow()
  })

  it.each(["separate_schema", "dedicated_database"] as const)(
    "rejects creating an active tenant in %s before repositories are migrated",
    (model) => expect(() => assertSafeHostingModeCreate(model)).toThrow(HostingModeNotReadyError),
  )

  it("blocks a transition in either direction without a verified data migration", () => {
    expect(() => assertSafeHostingModeUpdate("shared_database", "dedicated_database")).toThrow(HostingModeNotReadyError)
    expect(() => assertSafeHostingModeUpdate("dedicated_database", "shared_database")).toThrow(HostingModeNotReadyError)
  })
})
