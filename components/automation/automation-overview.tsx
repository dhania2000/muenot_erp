"use client"
import { useEffect, useState } from "react"
import Link from "next/link"
import { Workflow, Radio, Bell, Mail, ArrowRight } from "lucide-react"
import { AutomationTabs } from "./automation-tabs"

type Overview = {
  workflows: { total: number; active: number; runs: number; pending: number; failed: number }
  events: { recent: number; failed: number }
  notifications: { total: number; unread: number }
  email: { total: number; failed: number; sendersConfigured: number; sendersTotal: number }
}

export function AutomationOverview() {
  const [data, setData] = useState<Overview | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    const controller = new AbortController()
    async function load() {
      try {
        const res = await fetch("/api/admin/automation/overview", { cache: "no-store", signal: controller.signal })
        const body = await res.json()
        if (!res.ok) throw new Error(body.error || "Unable to load overview")
        if (!controller.signal.aborted) {
          setData(body)
          setError("")
        }
      } catch (e) {
        if (!controller.signal.aborted && (e as Error).name !== "AbortError")
          setError(e instanceof Error ? e.message : "Unable to load overview")
      }
    }
    void load()
    const timer = setInterval(load, 20000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [])

  const cards = [
    {
      icon: <Workflow className="size-5" />,
      title: "Workflows",
      href: "/admin/workflows",
      metric: data ? `${data.workflows.active}/${data.workflows.total}` : "—",
      caption: "active workflows",
      lines: data
        ? [
            `${data.workflows.runs} total runs`,
            `${data.workflows.pending} pending`,
            `${data.workflows.failed} failed`,
          ]
        : [],
    },
    {
      icon: <Radio className="size-5" />,
      title: "Events",
      href: "/admin/automation/events",
      metric: data ? String(data.events.recent) : "—",
      caption: "recent event instances",
      lines: data ? [`${data.events.failed} failed events`] : [],
    },
    {
      icon: <Bell className="size-5" />,
      title: "Notifications",
      href: "/admin/automation/notifications",
      metric: data ? String(data.notifications.total) : "—",
      caption: "deliveries",
      lines: data ? [`${data.notifications.unread} unread`] : [],
    },
    {
      icon: <Mail className="size-5" />,
      title: "Email",
      href: "/admin/automation/email",
      metric: data ? String(data.email.total) : "—",
      caption: "messages tracked",
      lines: data
        ? [
            `${data.email.failed} failed`,
            `${data.email.sendersConfigured}/${data.email.sendersTotal} senders configured`,
          ]
        : [],
    },
  ]

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Automation Center</h1>
        <p className="text-sm text-muted-foreground">
          Monitor and manage the workflow engine, event stream, notification deliveries and outbound email from one
          place.
        </p>
      </div>
      <AutomationTabs />
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => (
          <Link
            key={card.title}
            href={card.href}
            className="group flex flex-col rounded-lg border p-4 transition-colors hover:border-primary hover:bg-accent/40"
          >
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {card.icon}
              </span>
              <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <p className="mt-3 text-sm font-medium">{card.title}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{card.metric}</p>
            <p className="text-xs text-muted-foreground">{card.caption}</p>
            <ul className="mt-3 space-y-0.5 text-xs text-muted-foreground">
              {card.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </Link>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Metrics reflect this tenant only and refresh every 20 seconds. Workflow runs come from the existing engine;
        email figures aggregate the per-module email tables without altering them.
      </p>
    </main>
  )
}
