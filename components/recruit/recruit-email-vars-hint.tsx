"use client"

import { useState } from "react"
import { toast } from "sonner"
import { ChevronDown, Braces } from "lucide-react"
import { RECRUIT_EMAIL_VAR_GROUPS } from "@/lib/recruit-email-vars"
import { cn } from "@/lib/utils"

/**
 * Phase 93 — read-only reference of every merge field available in recruitment
 * emails, grouped by entity. Clicking a chip copies its `{{placeholder}}` to the
 * clipboard so it can be pasted into the subject or body.
 */
export function RecruitEmailVarsHint({ className }: { className?: string }) {
  const [open, setOpen] = useState(false)

  async function copy(key: string) {
    const token = `{{${key}}}`
    try {
      await navigator.clipboard.writeText(token)
      toast.success(`Copied ${token}`)
    } catch {
      toast.error("Unable to copy")
    }
  }

  return (
    <div className={cn("rounded-md border bg-muted/40", className)}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium"
      >
        <Braces className="size-4 text-muted-foreground" aria-hidden />
        Available placeholders
        <ChevronDown
          className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 border-t px-3 py-3">
          <p className="text-xs text-muted-foreground">
            Click a field to copy it. Placeholders fill in from the linked application, job, requisition,
            interview and offer when the email is sent.
          </p>
          {RECRUIT_EMAIL_VAR_GROUPS.map((group) => (
            <div key={group.entity} className="flex flex-col gap-1.5">
              <span className="text-xs font-semibold text-muted-foreground">{group.entity}</span>
              <div className="flex flex-wrap gap-1.5">
                {group.vars.map((v) => (
                  <button
                    key={v.key}
                    type="button"
                    onClick={() => copy(v.key)}
                    title={`Copy {{${v.key}}}`}
                    className="rounded border bg-background px-1.5 py-0.5 font-mono text-[11px] text-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {`{{${v.key}}}`}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
