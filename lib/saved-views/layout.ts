import { DEFAULT_COLUMN_WIDTH } from "./types"
import type { ColumnPref } from "./types"

export type LaidOutColumn = ColumnPref & { width?: number; left?: number }

/**
 * Visible columns with pinned ones first, plus the sticky left offset of each
 * pinned column. Pure so the sticky-offset math is unit-tested directly.
 */
export function layoutColumns(columns: ColumnPref[]): LaidOutColumn[] {
  const visible = columns.filter((c) => !c.hidden)
  const ordered = [...visible.filter((c) => c.pinned), ...visible.filter((c) => !c.pinned)]
  let offset = 0
  return ordered.map((c) => {
    const width = c.width ?? (c.pinned ? DEFAULT_COLUMN_WIDTH : undefined)
    const left = c.pinned ? offset : undefined
    if (c.pinned) offset += width ?? DEFAULT_COLUMN_WIDTH
    return { ...c, width, left }
  })
}
