import Link from "next/link"
import {
  KeyRound,
  ShieldCheck,
  Lock,
  MonitorSmartphone,
  Network,
  SlidersHorizontal,
  Timer,
  Siren,
  ClipboardCheck,
  Globe,
  Laptop,
  ArrowRight,
} from "lucide-react"
import { SecurityHeading } from "@/components/security/security-ui"
import { BackendStatus, type BackendLevel } from "@/components/security/backend-status"

const SECTIONS: {
  icon: React.ReactNode
  title: string
  href: string
  spec: string
  level: BackendLevel
  desc: string
}[] = [
  {
    icon: <KeyRound className="size-5" />,
    title: "Single sign-on (SSO)",
    href: "/admin/security/sso",
    spec: "",
    level: "live",
    desc: "Google, Entra ID, Okta, generic OIDC and SAML 2.0 provider management.",
  },
  {
    icon: <ShieldCheck className="size-5" />,
    title: "Multi-factor auth",
    href: "/admin/security/mfa",
    spec: "",
    level: "live",
    desc: "TOTP enrollment, recovery codes and the org-wide require-MFA policy are enforced.",
  },
  {
    icon: <Lock className="size-5" />,
    title: "Password policy",
    href: "/admin/security/password",
    spec: "",
    level: "live",
    desc: "Password hashing, reset, complexity, expiry, history and lockout are enforced.",
  },
  {
    icon: <MonitorSmartphone className="size-5" />,
    title: "Sessions",
    href: "/admin/security/sessions",
    spec: "",
    level: "live",
    desc: "Device and session listing with revocation across a member's active sessions.",
  },
  {
    icon: <Network className="size-5" />,
    title: "IP allowlist",
    href: "/admin/security/ip-allowlist",
    spec: "",
    level: "live",
    desc: "IPv4/IPv6/CIDR allow rules enforced at sign-in, with lockout protection.",
  },
  {
    icon: <SlidersHorizontal className="size-5" />,
    title: "Access policies",
    href: "/admin/security/access-policies",
    spec: "",
    level: "live",
    desc: "Device, IP, country and re-authentication policies enforced at sign-in.",
  },
  {
    icon: <Globe className="size-5" />,
    title: "Country policy",
    href: "/admin/security/geo-policy",
    spec: "",
    level: "live",
    desc: "Allow or block sign-in by country using trusted IP geolocation, fail-safe on unknown locations.",
  },
  {
    icon: <Laptop className="size-5" />,
    title: "Managed devices",
    href: "/admin/security/managed-devices",
    spec: "",
    level: "live",
    desc: "Require a verified device assertion at sign-in, with per-device enrollment and revocation.",
  },
  {
    icon: <Timer className="size-5" />,
    title: "Temporary access",
    href: "/admin/security/temporary-access",
    spec: "",
    level: "live",
    desc: "Time-boxed role grants with approval and automatic expiry.",
  },
  {
    icon: <Siren className="size-5" />,
    title: "Emergency access",
    href: "/admin/security/emergency-access",
    spec: "",
    level: "live",
    desc: "Controlled break-glass access with mandatory reason and audit.",
  },
  {
    icon: <ClipboardCheck className="size-5" />,
    title: "Access reviews",
    href: "/admin/security/access-reviews",
    spec: "",
    level: "live",
    desc: "Periodic certification campaigns across users, roles and permissions.",
  },
]

const LEVEL_DOT: Record<BackendLevel, string> = {
  live: "bg-emerald-500",
  partial: "bg-amber-500",
  planned: "bg-muted-foreground/40",
}

export default function SecurityOverviewPage() {
  return (
    <div className="space-y-6">
      <SecurityHeading title="Security & Access" spec="Specs 56–66">
        Manage tenant authentication, access control and governance from one place. Each area shows whether the
        platform enforces it today or presents the intended structure while the backend is not yet available — no
        settings are stored or applied unless the capability is marked as enforced.
      </SecurityHeading>

      <BackendStatus level="live">
        Every area below is enforced by the backend. Multi-factor authentication, password policy, single sign-on,
        sessions, IP allowlisting, access policies, temporary and emergency access, and access reviews all apply their
        settings at runtime — nothing on these screens is presentation-only.
      </BackendStatus>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {SECTIONS.map((s) => (
          <Link
            key={s.href}
            href={s.href}
            className="group flex flex-col rounded-lg border p-4 transition-colors hover:border-primary hover:bg-accent/40"
          >
            <div className="flex items-center justify-between">
              <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
                {s.icon}
              </span>
              <ArrowRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
            </div>
            <div className="mt-3 flex items-center gap-2">
              <span className={`size-2 rounded-full ${LEVEL_DOT[s.level]}`} aria-hidden />
              <p className="text-sm font-medium">{s.title}</p>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">{s.desc}</p>
            <p className="mt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">{s.spec}</p>
          </Link>
        ))}
      </div>
    </div>
  )
}
