import Image from "next/image"
import Link from "next/link"
import { SignupForm } from "@/components/signup-form"
import { LanguageWidget } from "@/components/providers/language-widget"
import { getPublicSettings } from "@/lib/settings/server"
import { Users2, TrendingUp, Wallet, UserPlus, Settings2 } from "lucide-react"

const modules = [
  { name: "HR", icon: Users2 },
  { name: "Sales", icon: TrendingUp },
  { name: "Finance", icon: Wallet },
  { name: "Recruitment", icon: UserPlus },
  { name: "Operations", icon: Settings2 },
]

export default async function SignupPage() {
  const settings = await getPublicSettings()

  const brandName = settings["company.name"] || "Muenot"
  const logo = settings["company.login_logo"] || settings["company.logo"] || ""
  const loginBackground = settings["theme.login_background"] || ""

  const BrandMark = ({ className }: { className?: string }) =>
    logo ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logo || "/placeholder.svg"} alt={brandName} className={className} />
    ) : (
      <Image src="/muenot-logo-transparent.png" alt={brandName} width={132} height={30} className={className} priority />
    )

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
          <BrandMark className="h-6 w-auto max-w-[160px] object-contain" />
        </div>

        <div className="relative flex flex-col gap-8">
          <h1 className="max-w-md text-balance text-4xl font-semibold leading-tight tracking-tight">
            Set up your company in minutes.
          </h1>
          <p className="max-w-md text-pretty text-sm leading-relaxed text-sidebar-foreground/70">
            Create your organization workspace, invite your team, and connect WhatsApp — all from one place. You become
            the workspace owner with full administrator control.
          </p>

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
          Your company data is isolated from every other organization on {brandName}.
        </p>
      </section>

      <section className="flex flex-1 items-center justify-center p-6 sm:p-10">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex flex-col gap-1 lg:hidden">
            <div className="mb-4">
              <BrandMark className="h-6 w-auto max-w-[160px] object-contain" />
            </div>
          </div>

          <div className="mb-8 flex flex-col gap-1.5">
            <h2 className="text-2xl font-semibold tracking-tight">Create a business account</h2>
            <p className="text-sm text-muted-foreground">
              Register your organization and become its administrator.
            </p>
          </div>

          <SignupForm />

          <p className="mt-8 text-center text-xs text-muted-foreground">
            Looking to join an existing company?{" "}
            <Link href="/login" className="font-medium text-primary hover:underline">
              Sign in with your work email
            </Link>
          </p>
        </div>
      </section>
    </main>
  )
}
