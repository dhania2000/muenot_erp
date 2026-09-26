import Link from "next/link"
import { ChevronRight } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type Crumb = { label: string; href?: string }

/** Accessible breadcrumb trail: `nav` landmark, ordered list, current page marked. */
export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  if (!items.length) return null
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {items.map((item, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${item.label}-${i}`} className="flex items-center gap-1">
              {item.href && !last ? (
                <Link
                  href={item.href}
                  className="rounded-sm hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {item.label}
                </Link>
              ) : (
                <span aria-current={last ? "page" : undefined} className={cn(last && "text-foreground")}>
                  {item.label}
                </span>
              )}
              {!last && <ChevronRight className="size-3" aria-hidden="true" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Standard module page header: breadcrumbs, a single `h1`, description and an
 * actions slot that wraps below the title on narrow screens.
 */
export function PageHeader({
  title,
  description,
  icon: Icon,
  breadcrumbs = [],
  actions,
}: {
  title: string
  description?: string
  icon?: LucideIcon
  breadcrumbs?: Crumb[]
  actions?: React.ReactNode
}) {
  return (
    <header className="flex flex-col gap-3">
      <Breadcrumbs items={breadcrumbs} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            {Icon && <Icon className="size-7 shrink-0 text-primary" aria-hidden="true" />}
            <h1 className="text-balance text-2xl font-semibold tracking-tight">{title}</h1>
          </div>
          {description && <p className="mt-1 text-pretty text-sm text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  )
}
