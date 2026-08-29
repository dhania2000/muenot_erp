import { formatNumber } from "@/lib/format"

export function BarList({
  title,
  items,
}: {
  title: string
  items: { label: string; value: number }[]
}) {
  const max = Math.max(1, ...items.map((i) => Number(i.value) || 0))
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <h3 className="mb-3 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? (
        <p className="py-4 text-center text-xs text-muted-foreground">No data</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {items.map((i) => (
            <li key={i.label} className="flex items-center gap-3">
              <span className="w-32 shrink-0 truncate text-xs text-muted-foreground" title={i.label}>
                {i.label}
              </span>
              <div className="relative h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="absolute inset-y-0 left-0 rounded-full bg-primary"
                  style={{ width: `${((Number(i.value) || 0) / max) * 100}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right font-mono text-xs tabular-nums">
                {formatNumber(i.value)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
