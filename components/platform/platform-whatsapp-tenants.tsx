"use client"

import { useRouter } from "next/navigation"
import { Building2, CheckCircle2, CircleAlert, Loader2, MessageCircle } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { EmbeddedSignupConnect } from "@/components/marketing/whatsapp/embedded-signup-connect"
import type { WhatsAppTenantConnection } from "@/lib/whatsapp"

export function PlatformWhatsAppTenants({ tenants }: { tenants: WhatsAppTenantConnection[] }) {
  const router = useRouter()

  if (tenants.length === 0) {
    return <Card><CardContent className="py-12 text-center text-sm text-muted-foreground">No tenants found.</CardContent></Card>
  }

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
      {tenants.map((tenant) => {
        const integration = tenant.integration
        const active = tenant.tenantStatus === "active"
        return (
          <Card key={tenant.tenantId}>
            <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <Building2 className="size-5" />
                </span>
                <div>
                  <CardTitle className="text-base">{tenant.tenantName}</CardTitle>
                  <p className="text-xs text-muted-foreground">{tenant.tenantSlug}</p>
                </div>
              </div>
              <Badge variant={integration ? "default" : "secondary"} className="gap-1">
                {integration ? <CheckCircle2 className="size-3" /> : <CircleAlert className="size-3" />}
                {integration ? "Connected" : "Not connected"}
              </Badge>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {integration ? (
                <div className="grid grid-cols-1 gap-3 rounded-lg border border-border bg-muted/30 p-3 text-sm sm:grid-cols-2">
                  <div><p className="text-xs text-muted-foreground">WABA</p><p className="break-all font-mono text-xs">{integration.wabaId}</p></div>
                  <div><p className="text-xs text-muted-foreground">Phone</p><p>{integration.displayPhoneNumber || integration.phoneNumberId}</p></div>
                  <div><p className="text-xs text-muted-foreground">Business</p><p>{integration.businessName || integration.verifiedName || "WhatsApp Business"}</p></div>
                  <div><p className="text-xs text-muted-foreground">Token</p><p>{integration.tokenStatus === "stored" ? "Encrypted and stored" : "Missing"}</p></div>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                {active ? (
                  <EmbeddedSignupConnect
                    startUrl={`/api/platform/whatsapp/signup/start?tenantId=${tenant.tenantId}`}
                    readinessUrl="/api/platform/whatsapp/signup/start"
                    startBody={{ tenantId: tenant.tenantId }}
                    onConnected={() => router.refresh()}
                    variant={integration ? "outline" : "default"}
                  />
                ) : (
                  <Button disabled variant="outline"><Loader2 className="size-4" />Tenant {tenant.tenantStatus}</Button>
                )}
                <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                  <MessageCircle className="size-3.5" /> Tenant-scoped connection
                </span>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
