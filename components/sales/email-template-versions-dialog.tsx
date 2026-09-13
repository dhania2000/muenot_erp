"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { formatDate } from "@/lib/utils"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Loader2Icon, RotateCcw, ChevronDown } from "lucide-react"
import type { EmailTemplateRow } from "@/components/sales/email-templates-client"

type VersionRow = {
  id: number
  version: number
  name: string
  subject: string
  body: string
  category: string | null
  description: string | null
  status: string | null
  change_note: string | null
  created_at: string
  edited_by_name: string | null
}

export function TemplateVersionsDialog({
  template,
  canManage,
  onOpenChange,
  onRestored,
}: {
  template: EmailTemplateRow | null
  canManage: boolean
  onOpenChange: (open: boolean) => void
  onRestored: () => void
}) {
  const open = template != null
  const { data, isLoading, mutate } = useSWR<{ versions: VersionRow[] }>(
    template ? `/api/sales/email-templates/${template.id}/versions` : null,
    fetcher,
  )
  const [expanded, setExpanded] = useState<number | null>(null)
  const [restoring, setRestoring] = useState<number | null>(null)

  const versions = data?.versions ?? []

  async function restore(versionId: number) {
    if (!template) return
    setRestoring(versionId)
    try {
      const res = await fetch(`/api/sales/email-templates/${template.id}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ versionId }),
      })
      if (res.ok) {
        await mutate()
        onRestored()
      }
    } finally {
      setRestoring(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-2xl flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            {template ? (
              <>
                Every edit to <span className="font-medium text-foreground">{template.name}</span> is snapshotted.
                Restore any prior version to bring it back as the latest.
              </>
            ) : null}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
              <Loader2Icon className="size-4 animate-spin" />
              Loading history...
            </div>
          )}
          {!isLoading && versions.length === 0 && (
            <p className="py-10 text-center text-sm text-muted-foreground">No version history yet.</p>
          )}
          <ol className="flex flex-col gap-2">
            {versions.map((v, i) => {
              const isCurrent = i === 0
              const isOpen = expanded === v.id
              return (
                <li key={v.id} className="rounded-lg border bg-card">
                  <div className="flex items-start justify-between gap-3 p-3">
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      onClick={() => setExpanded(isOpen ? null : v.id)}
                    >
                      <ChevronDown
                        className={`mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                      />
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium tabular-nums">v{v.version}</span>
                          {isCurrent && (
                            <Badge variant="outline" className="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
                              Current
                            </Badge>
                          )}
                          {v.status && <Badge variant="outline">{v.status}</Badge>}
                        </div>
                        <p className="mt-0.5 truncate text-sm text-muted-foreground">
                          {v.change_note || "Edited"}
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {formatDate(v.created_at)}
                          {v.edited_by_name ? ` · ${v.edited_by_name}` : ""}
                        </p>
                      </div>
                    </button>
                    {canManage && !isCurrent && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => restore(v.id)}
                        disabled={restoring != null}
                      >
                        {restoring === v.id ? (
                          <Loader2Icon className="size-4 animate-spin" data-icon="inline-start" />
                        ) : (
                          <RotateCcw className="size-4" data-icon="inline-start" />
                        )}
                        Restore
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="border-t px-3 py-3 text-sm">
                      <p className="text-xs font-medium text-muted-foreground">Subject</p>
                      <p className="mb-2">{v.subject}</p>
                      <p className="text-xs font-medium text-muted-foreground">Body</p>
                      <div
                        className="prose prose-sm mt-1 max-w-none rounded-md border bg-muted/30 p-2 dark:prose-invert"
                        // eslint-disable-next-line react/no-danger -- rendering a stored template snapshot for preview
                        dangerouslySetInnerHTML={{ __html: v.body }}
                      />
                    </div>
                  )}
                </li>
              )
            })}
          </ol>
        </div>
      </DialogContent>
    </Dialog>
  )
}
