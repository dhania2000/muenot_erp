"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  LayoutDashboard, Building2, CreditCard, Gauge, Activity, ShieldAlert, Flag, Plug, Settings2, Users, Rocket, Package, SlidersHorizontal, KeyRound, MessageCircle, Archive, LifeBuoy, Database, Zap, Clock3, Cpu, ListChecks, BellRing, Store, Smartphone,
} from "lucide-react"
import { cn } from "@/lib/utils"

type NavItem = { href: string; label: string; icon: React.ComponentType<{ className?: string }>; group: string }
const NAV: NavItem[] = [
  { href: "/platform", label: "Overview", icon: LayoutDashboard, group: "Operate" },
  { href: "/platform/shopkeepers", label: "Shopkeepers", icon: Store, group: "Operate" },
  { href: "/platform/mobile-app/releases", label: "Mobile App · Releases", icon: Smartphone, group: "Operate" },
  { href: "/platform/tenants", label: "Tenants & lifecycle", icon: Building2, group: "Operate" },
  { href: "/platform/whatsapp", label: "WhatsApp tenants", icon: MessageCircle, group: "Operate" },
  { href: "/platform/onboarding", label: "Organization onboarding", icon: Rocket, group: "Operate" },
  { href: "/platform/plans", label: "Plans & entitlements", icon: Package, group: "Operate" },
  { href: "/platform/subscriptions", label: "Subscriptions & billing", icon: CreditCard, group: "Operate" },
  { href: "/platform/usage", label: "Usage & storage", icon: Gauge, group: "Operate" },
  { href: "/platform/health", label: "Health & jobs", icon: Activity, group: "Observe" },
  { href: "/platform/cron-jobs", label: "Scheduled jobs", icon: Clock3, group: "Observe" },
  { href: "/platform/scheduler", label: "Central scheduler", icon: Cpu, group: "Observe" },
  { href: "/platform/background-jobs", label: "Background jobs & retries", icon: ListChecks, group: "Observe" },
  { href: "/platform/job-monitoring", label: "Job monitoring & alerts", icon: BellRing, group: "Observe" },
  { href: "/platform/security", label: "Security & audit", icon: ShieldAlert, group: "Observe" },
  { href: "/platform/operations/backups", label: "Backups", icon: Archive, group: "Observe" },
  { href: "/platform/operations/disaster-recovery", label: "Disaster recovery", icon: LifeBuoy, group: "Observe" },
  { href: "/platform/operations/availability", label: "Availability", icon: Activity, group: "Observe" },
  { href: "/platform/operations/capacity", label: "Capacity planning", icon: Gauge, group: "Observe" },
  { href: "/platform/operations/database", label: "Database monitoring", icon: Database, group: "Observe" },
  { href: "/platform/operations/cache", label: "Cache monitoring", icon: Zap, group: "Observe" },
  { href: "/platform/secrets", label: "Secrets", icon: KeyRound, group: "Configure" },
  { href: "/platform/feature-flags", label: "Feature flags", icon: Flag, group: "Configure" },
  { href: "/platform/integrations", label: "Integrations", icon: Plug, group: "Configure" },
  { href: "/platform/config", label: "Configuration", icon: Settings2, group: "Configure" },
  { href: "/platform/environment", label: "Environment & config", icon: SlidersHorizontal, group: "Configure" },
  { href: "/platform/access", label: "Access & support", icon: Users, group: "Configure" },
]
const GROUPS = ["Operate", "Observe", "Configure"] as const
export function PlatformNav() { const pathname = usePathname(); return <nav className="flex flex-col gap-6" aria-label="Platform console">{GROUPS.map((group) => <div key={group} className="flex flex-col gap-1"><span className="px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">{group}</span>{NAV.filter((n) => n.group === group).map((item) => { const active = item.href === "/platform" ? pathname === "/platform" : pathname.startsWith(item.href); const Icon = item.icon; return <Link key={item.href} href={item.href} aria-current={active ? "page" : undefined} className={cn("flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors", active ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><Icon className="size-4 shrink-0" />{item.label}</Link> })}</div>)}</nav> }
