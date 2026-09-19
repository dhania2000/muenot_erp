"use client"

import Link from "next/link"
import {
  BadgeCheck,
  Building2,
  Contact,
  Database,
  FileSignature,
  FileText,
  Globe,
  KeyRound,
  Network,
  PiggyBank,
  Phone,
  Server,
  Truck,
  type LucideIcon,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { MANAGEMENT_ENTITIES } from "@/lib/management-entities"

const ICONS: Record<string, LucideIcon> = {
  KeyRound,
  PiggyBank,
  Truck,
  Contact,
  FileSignature,
  FileText,
  Phone,
  BadgeCheck,
  Building2,
  Network,
  Globe,
  Server,
  Database,
}

export function ManagementLanding() {
  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Management</h1>
        <p className="text-sm text-muted-foreground">
          Manage licenses, budgets, suppliers, contracts, infrastructure and more.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {MANAGEMENT_ENTITIES.map((entity) => {
          const Icon = ICONS[entity.icon] ?? FileText
          return (
            <Link key={entity.key} href={`/modules/management/${entity.key}`} className="group">
              <Card className="h-full transition-colors group-hover:border-primary/50 group-hover:bg-accent/40">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex size-11 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="size-5" />
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <h2 className="font-medium leading-none">{entity.title}</h2>
                    <p className="text-sm text-muted-foreground text-pretty">{entity.description}</p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
