import { DoorOpen } from "lucide-react"
import { VendorPortalAdmin } from "@/components/vendor-portal/admin/vendor-portal-admin"

export default function VendorPortalPage() {
  return (
    <div className="grid gap-6 p-4 sm:p-6">
      <header className="flex items-start gap-3">
        <div className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <DoorOpen className="size-5" />
        </div>
        <div className="grid gap-1">
          <p className="text-xs font-medium text-muted-foreground">SPEC 119</p>
          <h1 className="text-2xl font-semibold tracking-tight">Vendor Portal</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            Optional self-service portal where vendors view POs, submit invoices and track payments. Select a vendor to
            control their access, provision logins and publish records to their portal.
          </p>
        </div>
      </header>

      <VendorPortalAdmin />
    </div>
  )
}
