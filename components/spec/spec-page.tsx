import type { ComponentType } from "react"
import { Inbox } from "lucide-react"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription, EmptyContent } from "@/components/ui/empty"

export type SpecPageProps = {
  /** Spec reference number, e.g. "SPEC 86". Rendered as a subtle badge. */
  spec: string
  /** Page title. */
  title: string
  /** One-line description of what the module does. */
  description: string
  /** Lucide icon component shown in the header. */
  icon: ComponentType<{ className?: string }>
  /** Capability chips summarising what the module will support. */
  capabilities: string[]
  /** Optional empty-state title override. */
  emptyTitle?: string
  /** Optional empty-state description override. */
  emptyDescription?: string
}

/**
 * Shared frontend scaffold for the Part 2 specs (86–170). Renders a polished
 * module header with a capability summary and an empty state. No backend is
 * wired yet — every list starts empty until the corresponding service is built.
 */
export function SpecPage({
  spec,
  title,
  description,
  icon: Icon,
  capabilities,
  emptyTitle,
  emptyDescription,
}: SpecPageProps) {
  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
            <Icon className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{spec}</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">{description}</p>
          </div>
        </div>
      </header>

      {capabilities.length > 0 && (
        <section aria-label="Capabilities" className="flex flex-wrap gap-2">
          {capabilities.map((c) => (
            <span
              key={c}
              className="inline-flex items-center rounded-full border bg-card px-3 py-1 text-xs font-medium text-muted-foreground"
            >
              {c}
            </span>
          ))}
        </section>
      )}

      <div className="flex flex-1 rounded-xl border bg-card">
        <Empty className="border-0">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox />
            </EmptyMedia>
            <EmptyTitle>{emptyTitle ?? "Nothing here yet"}</EmptyTitle>
            <EmptyDescription>
              {emptyDescription ??
                "There are no records to display. Data will appear here once this module is connected to its backend service."}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent />
        </Empty>
      </div>
    </div>
  )
}
