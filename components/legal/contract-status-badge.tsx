import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { templateStatusTone, contractStatusTone } from "@/lib/legal-contracts-shared"

const TONE_CLASS: Record<string, string> = {
  green: "border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  amber: "border-transparent bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "border-transparent bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300",
  red: "border-transparent bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  slate: "border-transparent bg-muted text-muted-foreground",
}

export function TemplateStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", TONE_CLASS[templateStatusTone(status)])}>
      {status}
    </Badge>
  )
}

export function ContractStatusBadge({ status }: { status: string }) {
  return (
    <Badge variant="outline" className={cn("font-medium", TONE_CLASS[contractStatusTone(status)])}>
      {status}
    </Badge>
  )
}
