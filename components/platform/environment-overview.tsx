import { Lock, Server, Building2, Terminal, Database, HardDrive } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CATEGORY_LABELS, type ConfigCategory } from "@/lib/config/registry"
import type { ConfigSource, ResolvedConfigEntry } from "@/lib/config/resolve"

/**
 * SPEC 37 — Phase 3. The safe surface: a read-only, categorized view of the
 * EFFECTIVE configuration. Every value shown here has already been through the
 * secret-safe projection (lib/config/resolve.ts), so a secret renders as a lock
 * + mask and never its plaintext. Editing stays in the dedicated, audited
 * surfaces (Configuration, Feature flags) linked from the header — this page
 * only reports what is in effect and WHERE it comes from.
 */

const SOURCE_LABEL: Record<ConfigSource, string> = {
  env: "Environment",
  tenant: "Tenant setting",
  platform: "Platform store",
  default: "Default",
  unset: "Not set",
}

function sourceBadgeClass(source: ConfigSource): string {
  switch (source) {
    case "env":
      return "border-transparent bg-blue-500/15 text-blue-600 dark:text-blue-400"
    case "platform":
      return "border-transparent bg-violet-500/15 text-violet-600 dark:text-violet-400"
    case "tenant":
      return "border-transparent bg-amber-500/15 text-amber-600 dark:text-amber-400"
    case "default":
      return "border-transparent bg-muted text-muted-foreground"
    case "unset":
      return "border-transparent bg-destructive/10 text-destructive"
  }
}

const CATEGORY_ICON: Partial<Record<ConfigCategory, React.ComponentType<{ className?: string }>>> = {
  application: Server,
  storage: HardDrive,
  security: Lock,
  jobs: Terminal,
  api: Database,
}

export function EnvironmentOverview({
  groups,
}: {
  groups: { category: ConfigCategory; entries: ResolvedConfigEntry[] }[]
}) {
  return (
    <div className="flex flex-col gap-6">
      {groups.map(({ category, entries }) => {
        const Icon = CATEGORY_ICON[category] ?? Server
        const secrets = entries.filter((e) => e.secret).length
        return (
          <Card key={category}>
            <CardHeader className="flex flex-row items-center justify-between gap-3 border-b">
              <CardTitle className="flex items-center gap-2 text-base">
                <Icon className="size-4 text-muted-foreground" />
                {CATEGORY_LABELS[category]}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {entries.length} {entries.length === 1 ? "key" : "keys"}
                {secrets > 0 ? ` · ${secrets} secret${secrets === 1 ? "" : "s"}` : ""}
              </span>
            </CardHeader>
            <CardContent className="flex flex-col divide-y divide-border p-0">
              {entries.map((entry) => (
                <ConfigRow key={entry.key} entry={entry} />
              ))}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

function ConfigRow({ entry }: { entry: ResolvedConfigEntry }) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-sm font-medium">{entry.key}</code>
          <Badge
            variant="outline"
            className="gap-1 text-[10px] uppercase tracking-wide"
            title={entry.scope === "platform" ? "Platform-scoped configuration" : "Tenant-scoped configuration"}
          >
            {entry.scope === "platform" ? <Server className="size-3" /> : <Building2 className="size-3" />}
            {entry.scope}
          </Badge>
          {entry.secret ? (
            <Badge variant="secondary" className="gap-1 text-[10px] uppercase tracking-wide">
              <Lock className="size-3" />
              Secret
            </Badge>
          ) : null}
        </div>
        <span className="text-xs text-muted-foreground">{entry.description}</span>
        {entry.envVar ? (
          <span className="text-[11px] text-muted-foreground/80">
            env: <code>{entry.envVar}</code>
          </span>
        ) : null}
      </div>

      <div className="flex shrink-0 items-center gap-3 sm:w-[24rem] sm:justify-end">
        <span
          className={`truncate font-mono text-sm ${entry.hasValue ? "" : "italic text-muted-foreground"}`}
          title={entry.secret ? "Secret value is hidden" : entry.masked}
        >
          {entry.masked}
        </span>
        <Badge variant="outline" className={`shrink-0 text-[10px] ${sourceBadgeClass(entry.source)}`}>
          {SOURCE_LABEL[entry.source]}
        </Badge>
      </div>
    </div>
  )
}
