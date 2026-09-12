"use client"

import useSWR from "swr"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import { TabState } from "./shared"
import type { WhatsAppTemplate } from "./types"

const STATUS_STYLE: Record<string, string> = {
  APPROVED: "border-transparent bg-[#25D366] text-white",
  PENDING: "border-transparent bg-amber-500 text-white",
  REJECTED: "border-transparent bg-destructive text-white",
  DISABLED: "border-transparent bg-muted-foreground text-white",
}

function bodyText(t: WhatsAppTemplate): string {
  const comps = (t.components ?? []) as { type?: string; text?: string }[]
  const body = comps.find((c) => (c.type ?? "").toUpperCase() === "BODY")
  return body?.text ?? ""
}

/** Read-only template catalog synced live from the connected WABA. */
export function TemplatesTab() {
  const { data, isLoading, error, mutate } = useSWR<{ templates: WhatsAppTemplate[]; error?: string }>(
    "/api/marketing/whatsapp/templates",
    fetcher,
  )

  const templates = data?.templates ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {templates.length} template{templates.length === 1 ? "" : "s"} synced from Meta. Only approved templates can be sent.
        </p>
        <Button variant="outline" size="sm" onClick={() => mutate()}>
          <RefreshCw className="size-4" /> Sync from Meta
        </Button>
      </div>

      {isLoading ? (
        <TabState loading>Loading templates…</TabState>
      ) : error || (data && "error" in data && data.error) ? (
        <TabState>Could not load templates. Check the connection in Settings.</TabState>
      ) : templates.length === 0 ? (
        <TabState>No templates found on this WABA yet.</TabState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={`${t.name}-${t.language}`}>
              <CardHeader className="gap-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold break-all">{t.name}</CardTitle>
                  <Badge className={cn("shrink-0 text-[10px] uppercase", STATUS_STYLE[(t.status || "").toUpperCase()] ?? STATUS_STYLE.DISABLED)}>
                    {t.status}
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  {(t.category ?? "—")} · {t.language}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground text-pretty">
                  {bodyText(t) || "No body preview."}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
