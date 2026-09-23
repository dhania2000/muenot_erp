import Link from "next/link"
import { LoginForm, type SocialProviders } from "@/components/login-form"
import { BrandMark } from "@/components/login/brand-mark"
import { LanguageWidget } from "@/components/providers/language-widget"
import { getPublicSettings } from "@/lib/settings/server"
import { listEnabledProvidersForLogin } from "@/lib/sso-store"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2 } from "lucide-react"

const SSO_ERROR_MESSAGES: Record<string, string> = {
  provider_disabled: "That single sign-on provider is not currently enabled.",
  state_mismatch: "Your sign-in link expired or was already used. Please try again.",
  token_exchange_failed: "We couldn't complete sign-in with your identity provider. Please try again.",
  no_account: "No account matches that identity provider login and auto-provisioning is disabled for it.",
  provider_error: "Your identity provider reported an error during sign-in.",
}

const modules = [
  { name: "HR", icon: Users2 },
  { name: "Sales", icon: TrendingUp },
  { name: "Finance", icon: Wallet },
  { name: "Recruitment", icon: UserPlus },
  { name: "Operations", icon: Settings2 },
]

function enabled(v: string | undefined) {
  if (!v) return false
  const t = v.trim().toLowerCase()
  return t === "enabled" || t === "true" || t === "1" || t === "yes"
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ sso_error?: string }>
}) {
  const settings = await getPublicSettings()
  const params = await searchParams
  const ssoProviders = await listEnabledProvidersForLogin().catch(() => [])
  const ssoError = params.sso_error ? SSO_ERROR_MESSAGES[params.sso_error] || "Sign-in with your identity provider failed." : null

  const brandName = settings["company.name"] || "Muenot"
  const logo = settings["company.login_logo"] || settings["company.logo"] || ""
  const loginBackground = settings["theme.login_background"] || ""
  const tagline = settings["company.website"]
    ? `${brandName} · ${settings["company.website"]}`
    : `${brandName} brings HR, Sales, Finance, Recruitment, and Operations together, with permissions your admin controls down to the feature level.`

  const social: SocialProviders = {
    google: enabled(settings["social.google_enabled"]),
    linkedin: enabled(settings["social.linkedin_enabled"]),
    facebook: enabled(settings["social.facebook_enabled"]),
  }

  return (
    <main className="relative flex min-h-svh flex-col lg:flex-row">
      <div className="absolute right-4 top-4 z-10">
        <LanguageWidget className="rounded-md border bg-background/95 shadow-sm backdrop-blur" />
      </div>
      <section
        className="relative hidden flex-1 flex-col justify-between overflow-hidden bg-sidebar p-10 text-sidebar-foreground lg:flex"
        style={
          loginBackground
            ? { backgroundImage: `url(${loginBackground})`, backgroundSize: "cover", backgroundPosition: "center" }
            : undefined
        }
      >
        {loginBackground && <div className="absolute inset-0 bg-sidebar/80" aria-hidden />}
        <div className="relative flex items-center">
          <BrandMark brandName={brandName} logo={logo} className="h-6 w-auto max-w-[160px] object-contain" />
        </div>

        <div className="relative flex flex-col gap-8">
          <h1 className="max-w-md text-balance text-4xl font-semibold leading-tight tracking-tight">
            One workspace to run every part of the business.
          </h1>
          <p className="max-w-md text-pretty text-sm leading-relaxed text-sidebar-foreground/70">{tagline}</p>

          <div className="grid grid-cols-2 gap-3">
            {modules.map((m) => (
              <div
                key={m.name}
                className="flex items-center gap-2.5 rounded-md border border-sidebar-border bg-sidebar-accent/40 px-3 py-2.5"
              >
                <m.icon className="size-4 text-sidebar-primary" />
                <span className="text-sm font-medium">{m.name}</span>
              </div>
            ))}
          </div>
        </div>

        <p className="relative text-xs text-sidebar-foreground/50">
          Access is granted per employee, per feature — configured by your administrator.
        </p>
      </section>

      <section className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col gap-1 lg:hidden">
            <div className="mb-4">
              <BrandMark brandName={brandName} logo={logo} className="h-6 w-auto max-w-[160px] object-contain" />
            </div>
          </div>

          <div className="mb-8 flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Sign in</h2>
            <p className="text-sm text-muted-foreground">Enter your credentials to access your workspace.</p>
          </div>

          <LoginForm social={social} signupEnabled={false} ssoProviders={ssoProviders} ssoError={ssoError} />

          <div className="mt-8 flex flex-col gap-2 border-t border-border pt-6 text-center">
            <p className="text-sm text-muted-foreground">
              Setting up {brandName} for your company?{" "}
          <Link href="/signup" className="whitespace-nowrap font-medium text-primary hover:underline">
            Create a business account
              </Link>
            </p>
            <p className="text-xs text-muted-foreground">
              Employees: ask your administrator if you don&apos;t have a login yet.
            </p>
          </div>
        </div>
      </section>
    </main>
  )
}
