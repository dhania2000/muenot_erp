import { describe, expect, it } from "vitest"
import { likePattern, orderByClause, pageMeta, parseTableQuery, TableQueryError } from "@/lib/table-query"
import { CLIENT_TABLE_QUERY } from "@/lib/clients-table-query"
import { layoutColumns } from "@/lib/saved-views/layout"
import { DEFAULT_COLUMN_WIDTH } from "@/lib/saved-views/types"

const parse = (qs: string) => parseTableQuery(new URLSearchParams(qs), CLIENT_TABLE_QUERY)

describe("server pagination query parser", () => {
  it("applies defaults", () => {
    expect(parse("")).toEqual({ page: 1, pageSize: 25, offset: 0, search: "", sort: null, filters: {} })
  })

  it("computes offsets and whitelisted sort", () => {
    const q = parse("page=3&pageSize=50&sort=company&dir=desc")
    expect(q.offset).toBe(100)
    expect(orderByClause(q, CLIENT_TABLE_QUERY, "c.created_at DESC", "c.id DESC")).toBe(
      "ORDER BY c.company_name DESC, c.id DESC",
    )
  })

  it.each(["page=0", "page=abc", "pageSize=101", "pageSize=0", "sort=password", "sort=c.id;DROP", "status=Deleted"])(
    "rejects %s",
    (qs) => {
      expect(() => parse(qs)).toThrow(TableQueryError)
    },
  )

  it("defaults unknown directions to asc rather than injecting them", () => {
    expect(parse("sort=client&dir=;DROP").sort).toEqual({ key: "client", dir: "asc" })
  })

  it("caps search length and escapes LIKE wildcards", () => {
    expect(parse(`q=${"a".repeat(500)}`).search).toHaveLength(120)
    expect(likePattern("50%_off\\")).toBe("%50\\%\\_off\\\\%")
  })

  it("reports at least one page for empty results", () => {
    expect(pageMeta(parse("pageSize=10"), 0)).toMatchObject({ pageCount: 1, total: 0 })
    expect(pageMeta(parse("pageSize=10"), 101).pageCount).toBe(11)
  })
})

describe("column layout (chooser / pin / resize)", () => {
  it("drops hidden columns and moves pinned ones first with cumulative offsets", () => {
    const out = layoutColumns([
      { key: "a", hidden: false },
      { key: "b", hidden: false, pinned: true, width: 120 },
      { key: "c", hidden: true, pinned: true },
      { key: "d", hidden: false, pinned: true },
    ])
    expect(out.map((c) => [c.key, c.left])).toEqual([
      ["b", 0],
      ["d", 120],
      ["a", undefined],
    ])
    expect(out[1].width).toBe(DEFAULT_COLUMN_WIDTH)
  })

  it("leaves unpinned columns without a forced width", () => {
    expect(layoutColumns([{ key: "a", hidden: false }])[0].width).toBeUndefined()
  })
})
