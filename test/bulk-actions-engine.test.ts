import { describe, expect, it } from "vitest"
import {
  BulkActionError,
  executeBulkAction,
  normalizeIds,
  parseActionValue,
  resolveAction,
  summarizeReport,
} from "@/lib/bulk-actions/engine"
import type { BulkActorContext, BulkResourceDef } from "@/lib/bulk-actions/types"

/**
 * engine unit tests. The engine is deliberately persistence-free, so
 * these exercise its batching, permission, partial-failure, export, and
 * cancellation behavior against an in-memory resource.
 */

type Widget = {
  id: number
  name: string
  status: string
  ownerId: number | null
  locked?: boolean
}

const ctx: BulkActorContext = {
  tenantId: 1,
  session: {
    userId: 7,
    email: "actor@example.com",
    name: "Actor",
    role: "employee",
    tenantId: 1,
  },
}

/**
 * Build an in-memory widgets resource. `visibleIds` limits what `load` returns
 * (models record-level scope); every applied mutation is recorded in `applied`.
 */
function makeResource(
  widgets: Widget[],
  opts: { visibleIds?: number[]; applied?: number[] } = {},
): BulkResourceDef<Widget> {
  const byId = new Map(widgets.map((w) => [w.id, w]))
  const applied = opts.applied ?? []
  return {
    key: "test.widgets",
    label: "Widgets",
    singular: "widget",
    plural: "widgets",
    feature: "test.manage_widgets",
    async load(ids) {
      const allowed = opts.visibleIds ? new Set(opts.visibleIds) : null
      return ids
        .map((id) => byId.get(id))
        .filter((w): w is Widget => !!w && (!allowed || allowed.has(w.id)))
    },
    idOf: (w) => w.id,
    labelOf: (w) => w.name,
    actions: {
      set_status: {
        kind: "set_status",
        label: "Change status",
        requiresValue: true,
        parseValue(raw) {
          const status = (raw as any)?.status
          if (typeof status !== "string" || !status) throw new Error("status is required")
          return { status }
        },
        permit: (w) => (w.locked ? "Widget is locked" : true),
        async apply(w, _ctx, value: { status: string }) {
          w.status = value.status
          applied.push(w.id)
        },
      },
      delete: {
        kind: "delete",
        label: "Delete",
        destructive: true,
        async apply(w) {
          if (w.name === "boom") throw new Error("cannot delete boom")
          applied.push(w.id)
        },
      },
      export: {
        kind: "export",
        label: "Export CSV",
        permit: () => true,
        async apply() {},
        toExportRow: (w) => ({ id: w.id, name: w.name, status: w.status }),
      },
    },
  }
}

describe("normalizeIds", () => {
  it("dedupes, drops invalid ids, and preserves order", () => {
    expect(normalizeIds([3, 1, 3, "2", 0, -4, 2, null, 4.5])).toEqual([3, 1, 2])
  })
  it("returns an empty array for non-array input", () => {
    expect(normalizeIds("nope")).toEqual([])
    expect(normalizeIds(undefined)).toEqual([])
  })
})

describe("resolveAction / parseActionValue", () => {
  it("throws a 422 BulkActionError for an unsupported action", () => {
    const resource = makeResource([])
    expect(() => resolveAction(resource, "approve")).toThrowError(BulkActionError)
    try {
      resolveAction(resource, "approve")
    } catch (e) {
      expect((e as BulkActionError).status).toBe(422)
    }
  })
  it("wraps parseValue failures in a 422 BulkActionError", () => {
    const resource = makeResource([])
    const def = resolveAction(resource, "set_status")
    try {
      parseActionValue(def, { status: "" })
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(BulkActionError)
      expect((e as BulkActionError).status).toBe(422)
      expect((e as BulkActionError).message).toBe("status is required")
    }
  })
})

describe("executeBulkAction", () => {
  it("applies an action and reports full success", async () => {
    const widgets: Widget[] = [
      { id: 1, name: "a", status: "new", ownerId: null },
      { id: 2, name: "b", status: "new", ownerId: null },
    ]
    const applied: number[] = []
    const resource = makeResource(widgets, { applied })
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2], value: { status: "done" } },
      ctx,
    )
    expect(report.total).toBe(2)
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(0)
    expect(report.skipped).toBe(0)
    expect(applied.sort()).toEqual([1, 2])
    expect(widgets.every((w) => w.status === "done")).toBe(true)
  })

  it("skips ids the actor cannot see and reports them", async () => {
    const widgets: Widget[] = [
      { id: 1, name: "a", status: "new", ownerId: null },
      { id: 2, name: "b", status: "new", ownerId: null },
    ]
    const resource = makeResource(widgets, { visibleIds: [1] })
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2, 99], value: { status: "done" } },
      ctx,
    )
    expect(report.succeeded).toBe(1)
    expect(report.skipped).toBe(2)
    const skipped = report.results.filter((r) => r.outcome === "skipped")
    expect(skipped.map((r) => r.id).sort()).toEqual([2, 99])
    expect(skipped.every((r) => r.reason === "Not found or access denied")).toBe(true)
  })

  it("skips records that fail the permit check with the returned reason", async () => {
    const widgets: Widget[] = [
      { id: 1, name: "a", status: "new", ownerId: null },
      { id: 2, name: "locked", status: "new", ownerId: null, locked: true },
    ]
    const resource = makeResource(widgets)
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2], value: { status: "done" } },
      ctx,
    )
    expect(report.succeeded).toBe(1)
    expect(report.skipped).toBe(1)
    const skip = report.results.find((r) => r.id === 2)
    expect(skip?.outcome).toBe("skipped")
    expect(skip?.reason).toBe("Widget is locked")
    expect(widgets[1].status).toBe("new")
  })

  it("marks records whose apply throws as failed without aborting the batch", async () => {
    const widgets: Widget[] = [
      { id: 1, name: "ok", status: "new", ownerId: null },
      { id: 2, name: "boom", status: "new", ownerId: null },
      { id: 3, name: "ok2", status: "new", ownerId: null },
    ]
    const resource = makeResource(widgets)
    const report = await executeBulkAction(resource, { action: "delete", ids: [1, 2, 3] }, ctx)
    expect(report.succeeded).toBe(2)
    expect(report.failed).toBe(1)
    const fail = report.results.find((r) => r.id === 2)
    expect(fail?.outcome).toBe("failed")
    expect(fail?.reason).toBe("cannot delete boom")
  })

  it("produces exactly one result per submitted id", async () => {
    const widgets: Widget[] = [{ id: 1, name: "a", status: "new", ownerId: null }]
    const resource = makeResource(widgets)
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2, 3], value: { status: "x" } },
      ctx,
    )
    expect(report.results).toHaveLength(3)
  })

  it("builds a CSV export artifact for export actions", async () => {
    const widgets: Widget[] = [
      { id: 1, name: "alpha", status: "new", ownerId: null },
      { id: 2, name: 'has,comma "q"', status: "done", ownerId: null },
    ]
    const resource = makeResource(widgets)
    const report = await executeBulkAction(resource, { action: "export", ids: [1, 2] }, ctx)
    expect(report.succeeded).toBe(2)
    expect(report.export).toBeTruthy()
    expect(report.export!.mimeType).toBe("text/csv")
    expect(report.export!.filename).toBe("test-widgets-export.csv")
    const lines = report.export!.content.split("\n")
    expect(lines[0]).toBe("id,name,status")
    expect(lines[1]).toBe("1,alpha,new")
    // Cells containing commas/quotes are escaped per RFC 4180.
    expect(lines[2]).toBe('2,"has,comma ""q""",done')
  })

  it("emits monotonic progress ending at the total", async () => {
    const widgets: Widget[] = Array.from({ length: 5 }, (_, i) => ({
      id: i + 1,
      name: `w${i + 1}`,
      status: "new",
      ownerId: null,
    }))
    const resource = makeResource(widgets)
    const progress: Array<[number, number]> = []
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2, 3, 4, 5], value: { status: "done" } },
      ctx,
      { onProgress: (processed, total) => void progress.push([processed, total]) },
    )
    expect(report.succeeded).toBe(5)
    expect(progress).toHaveLength(5)
    expect(progress.every(([, total]) => total === 5)).toBe(true)
    expect(progress[progress.length - 1][0]).toBe(5)
    // processed counts never decrease.
    for (let i = 1; i < progress.length; i++) {
      expect(progress[i][0]).toBeGreaterThanOrEqual(progress[i - 1][0])
    }
  })

  it("skips remaining records once the abort signal is set", async () => {
    const widgets: Widget[] = Array.from({ length: 3 }, (_, i) => ({
      id: i + 1,
      name: `w${i + 1}`,
      status: "new",
      ownerId: null,
    }))
    const resource = makeResource(widgets)
    const controller = new AbortController()
    controller.abort()
    const report = await executeBulkAction(
      resource,
      { action: "set_status", ids: [1, 2, 3], value: { status: "done" } },
      ctx,
      { signal: controller.signal },
    )
    expect(report.succeeded).toBe(0)
    expect(report.skipped).toBe(3)
    expect(report.results.every((r) => r.reason === "Cancelled before processing")).toBe(true)
  })
})

describe("summarizeReport", () => {
  it("includes failed/skipped only when non-zero", () => {
    expect(
      summarizeReport({
        resource: "x",
        action: "set_status",
        total: 3,
        succeeded: 3,
        failed: 0,
        skipped: 0,
        results: [],
      }),
    ).toBe("3 succeeded")
    expect(
      summarizeReport({
        resource: "x",
        action: "set_status",
        total: 5,
        succeeded: 2,
        failed: 1,
        skipped: 2,
        results: [],
      }),
    ).toBe("2 succeeded, 1 failed, 2 skipped")
  })
})
