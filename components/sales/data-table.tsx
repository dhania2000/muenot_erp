import { StatusBadge } from "@/components/status-badge"
import { EmptyState } from "@/components/states"
import { formatCurrency, formatDate, formatNumber } from "@/lib/format"
import { cn } from "@/lib/utils"

export type Column = {
  key: string
  header: string
  type?: "text" | "date" | "currency" | "number" | "status" | "mono" | "code"
  align?: "left" | "right"
  className?: string
}

export function DataTable({ columns, rows }: { columns: Column[]; rows: any[] }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
              {columns.map((c) => (
                <th
                  key={c.key}
                  className={cn("px-4 py-2.5 font-medium whitespace-nowrap", c.align === "right" && "text-right")}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={row.id ?? i} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cn(
                      "px-4 py-2.5 align-top",
                      c.align === "right" && "text-right",
                      (c.type === "mono" || c.type === "code" || c.type === "currency" || c.type === "number") &&
                        "font-mono tabular-nums",
                      c.type === "code" && "text-xs text-muted-foreground",
                      c.className,
                    )}
                  >
                    <Cell value={row[c.key]} type={c.type} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 ? <EmptyState /> : null}
    </div>
  )
}

function Cell({ value, type }: { value: any; type?: Column["type"] }) {
  if (type === "status") return <StatusBadge status={value} />
  if (value === null || value === undefined || value === "") return <span className="text-muted-foreground">—</span>
  switch (type) {
    case "date":
      return <>{formatDate(value)}</>
    case "currency":
      return <>{formatCurrency(value)}</>
    case "number":
      return <>{formatNumber(value)}</>
    default:
      return <>{String(value)}</>
  }
}
