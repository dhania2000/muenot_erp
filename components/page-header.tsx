import { cn } from "@/lib/utils"

export function PageHeader({
  title,
  description,
  children,
  className,
}: {
  title: string
  description?: string
  children?: React.ReactNode
  className?: string
}) {
  return (
    <header
      className={cn(
        "sticky top-0 z-10 flex flex-wrap items-end justify-between gap-4 border-b border-border bg-background/85 px-6 py-4 backdrop-blur",
        className,
      )}
    >
      <div className="min-w-0">
        <h1 className="text-pretty text-xl font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-muted-foreground">{description}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  )
}
