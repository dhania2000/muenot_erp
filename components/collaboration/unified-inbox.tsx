"use client"

import Link from "next/link"
import useSWR from "swr"
import { CheckSquare, ShieldCheck } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"

type Item = {
  kind: "task" | "approval"
  id: number
  title: string
  moduleKey: string
  status: string
  dueAt: string | null
  link: string
}
type Inbox = { items: Item[]; counts: { tasks: number; approvals: number; hiddenApprovals: number } }

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to load inbox")
  return res.json()
}

export function UnifiedInbox() {
  const { data, error, isLoading } = useSWR<Inbox>("/api/collaboration/inbox", fetcher)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2 text-sm text-muted-foreground">
        <span>{data?.counts.tasks ?? 0} open tasks</span>
        <span aria-hidden="true">·</span>
        <span>{data?.counts.approvals ?? 0} pending approvals</span>
      </div>
      {error ? <p className="text-sm text-destructive">{error.message}</p> : null}
      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {data && data.items.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">You&apos;re all caught up.</CardContent>
        </Card>
      ) : null}
      <ul className="flex flex-col divide-y rounded-md border">
        {data?.items.map((item) => {
          const Icon = item.kind === "approval" ? ShieldCheck : CheckSquare
          const overdue = item.dueAt != null && Date.parse(item.dueAt) < Date.now()
          return (
            <li key={`${item.kind}-${item.moduleKey}-${item.id}`}>
              <Link href={item.link} className="flex items-center gap-3 px-4 py-3 hover:bg-accent">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {item.moduleKey} · {item.status.replace(/_/g, " ")}
                  </p>
                </div>
                {item.dueAt ? (
                  <Badge variant={overdue ? "destructive" : "secondary"}>
                    {overdue ? "Overdue" : "Due"} {new Date(item.dueAt).toLocaleDateString()}
                  </Badge>
                ) : null}
                <Badge variant="outline" className="capitalize">{item.kind}</Badge>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
