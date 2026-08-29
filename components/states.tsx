import { Database, Inbox } from "lucide-react"

export function DbNotConnected({ error }: { error?: string }) {
  return (
    <div className="m-6 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-warning/40 bg-warning/5 px-6 py-14 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-warning/15 text-warning-foreground">
        <Database className="size-5" />
      </div>
      <h3 className="text-base font-semibold">Database not connected</h3>
      <p className="max-w-md text-pretty text-sm text-muted-foreground">
        Set <code className="font-mono text-foreground">DATABASE_URL</code> to your MySQL instance, then run{" "}
        <code className="font-mono text-foreground">node scripts/setup-db.mjs</code> and{" "}
        <code className="font-mono text-foreground">node scripts/import-data.mjs</code> to create the schema and load
        your CRM data.
      </p>
      {error ? <p className="mt-1 max-w-md break-words font-mono text-xs text-muted-foreground/70">{error}</p> : null}
    </div>
  )
}

export function EmptyState({ message = "No records found." }: { message?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center text-muted-foreground">
      <Inbox className="size-6 opacity-60" />
      <p className="text-sm">{message}</p>
    </div>
  )
}
