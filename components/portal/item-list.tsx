"use client"

import type { PortalItem } from "@/lib/portal/store"
import type { PortalItemResource } from "@/lib/portal/config"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Download, Inbox } from "lucide-react"

function formatAmount(amount: number | null, currency: string | null) {
  if (amount == null) return null
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency || "USD",
      maximumFractionDigits: 2,
    }).format(amount)
  } catch {
    return `${currency ?? ""} ${amount.toFixed(2)}`.trim()
  }
}

function formatDate(value: string | null) {
  if (!value) return null
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })
}

export function ItemList({
  resource,
  title,
  items,
  headerAction,
}: {
  resource: PortalItemResource
  title: string
  items: PortalItem[]
  headerAction?: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="text-sm text-muted-foreground">
            {items.length} {items.length === 1 ? "record" : "records"} shared with you.
          </p>
        </div>
        {headerAction}
      </div>

      {items.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <Inbox className="h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Nothing here yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((item) => {
            const amount = formatAmount(item.amount, item.currency)
            const issue = formatDate(item.issue_date)
            const due = formatDate(item.due_date)
            return (
              <Card key={item.id}>
                <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      {item.reference && (
                        <span className="font-mono text-xs text-muted-foreground">{item.reference}</span>
                      )}
                      <h2 className="font-medium">{item.title}</h2>
                      {item.status && (
                        <Badge variant="secondary" className="capitalize">
                          {item.status}
                        </Badge>
                      )}
                    </div>
                    {item.description && (
                      <p className="text-sm text-muted-foreground">{item.description}</p>
                    )}
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {issue && <span>Issued {issue}</span>}
                      {due && <span>Due {due}</span>}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
                    {amount && <span className="text-base font-semibold tabular-nums">{amount}</span>}
                    {resource === "documents" && item.file_url && (
                      <Button asChild variant="outline" size="sm" className="gap-2">
                        <a href={item.file_url} target="_blank" rel="noopener noreferrer">
                          <Download className="h-4 w-4" />
                          {item.file_name ?? "Download"}
                        </a>
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
